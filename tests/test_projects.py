import pytest
import sqlite3
import time
from server.db import Database

def test_project_crud_and_assignment():
    db = Database(":memory:")
    
    # 1. Create project
    p1 = db.create_project(name="Coding Tasks", color="#10b981", icon="💻", description="Dev chats")
    assert p1["name"] == "Coding Tasks"
    assert p1["color"] == "#10b981"
    assert p1["icon"] == "💻"
    assert p1["conversation_count"] == 0
    p1_id = p1["id"]

    p2 = db.create_project(name="Research", color="#8b5cf6", icon="🔬", description="Research notes")
    p2_id = p2["id"]

    # 2. List projects
    projs = db.list_projects()
    assert len(projs) == 2

    # 3. Create conversation
    conv = {
        "id": "conv-1",
        "title": "Build a React App",
        "created_at": time.time(),
        "updated_at": time.time(),
        "format": "openai"
    }
    messages = [
        {"id": "msg-1", "role": "user", "content": "How to use useState?"},
        {"id": "msg-2", "parent_id": "msg-1", "role": "assistant", "content": "Here is an example..."}
    ]
    db.insert_conversation(conv, messages)

    # 4. Assign projects to conversation
    assigned = db.set_conversation_projects("conv-1", [p1_id, p2_id])
    assert len(assigned) == 2
    assert any(p["id"] == p1_id for p in assigned)
    assert any(p["id"] == p2_id for p in assigned)

    # Check project count
    projs = db.list_projects()
    p1_entry = next(p for p in projs if p["id"] == p1_id)
    assert p1_entry["conversation_count"] == 1

    # 5. List conversations with project filter
    convs, total = db.list_conversations(project_id=p1_id)
    assert total == 1
    assert len(convs[0]["projects"]) == 2

    # 6. Re-import conversation should preserve project assignment
    db.insert_conversation(conv, messages)
    conv_detail = db.get_conversation("conv-1")
    assert len(conv_detail["projects"]) == 2

    # 7. Update project metadata
    updated_p1 = db.update_project(p1_id, name="Frontend Coding", color="#3b82f6")
    assert updated_p1["name"] == "Frontend Coding"
    assert updated_p1["color"] == "#3b82f6"

    # 8. Batch assign projects
    conv2 = {"id": "conv-2", "title": "Quantum Physics", "created_at": time.time(), "updated_at": time.time()}
    db.insert_conversation(conv2, [{"id": "msg-3", "role": "user", "content": "Explain entanglement"}])
    db.batch_assign_projects(["conv-2"], add_project_ids=[p2_id])

    p2_convs, p2_total = db.list_conversations(project_id=p2_id)
    assert p2_total == 2

    # 9. Delete project - check conversations are preserved
    db.delete_project(p1_id)
    assert db.get_project(p1_id) is None
    # Conversation still exists
    assert db.get_conversation("conv-1") is not None
    # And only p2 remains attached
    assert len(db.get_conversation_projects("conv-1")) == 1

    # 10. Delete conversation - cascades junction link
    db.delete_conversation("conv-1")
    p2_updated = db.get_project(p2_id)
    assert p2_updated["conversation_count"] == 1


import http.server
import socketserver
import threading
import json
import urllib.request
import tempfile
import os
from server.app import ApiRequestHandler

def test_api_server_projects_endpoints():
    temp_dir = tempfile.TemporaryDirectory()
    db_path = os.path.join(temp_dir.name, "test_api_proj.db")
    db = Database(db_path)
    ApiRequestHandler.db = db

    class ThreadedServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
        daemon_threads = True

    server = ThreadedServer(("127.0.0.1", 0), ApiRequestHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever)
    thread.daemon = True
    thread.start()
    time.sleep(0.1)

    try:
        def _url(p):
            return f"http://127.0.0.1:{port}{p}"

        # 1. POST /api/projects
        req = urllib.request.Request(
            _url("/api/projects"),
            data=json.dumps({"name": "Fullstack AI", "color": "#10b981", "icon": "🚀", "description": "AI apps"}).encode('utf-8'),
            headers={'Content-Type': 'application/json'}
        )
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            assert data["status"] == "created"
            proj_id = data["project"]["id"]
            assert data["project"]["name"] == "Fullstack AI"

        # 2. GET /api/projects
        req = urllib.request.Request(_url("/api/projects"))
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            assert len(data["projects"]) == 1

        # 3. PUT /api/projects/<id>
        req = urllib.request.Request(
            _url(f"/api/projects/{proj_id}"),
            data=json.dumps({"name": "Fullstack Web & AI", "color": "#3b82f6"}).encode('utf-8'),
            headers={'Content-Type': 'application/json'},
            method='PUT'
        )
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            assert data["status"] == "updated"
            assert data["project"]["name"] == "Fullstack Web & AI"
            assert data["project"]["color"] == "#3b82f6"

        # 4. Import a conversation
        db.insert_conversation(
            {"id": "conv-api-1", "title": "Next.js AI Chat", "created_at": time.time(), "updated_at": time.time()},
            [{"id": "m1", "role": "user", "content": "How to deploy Next.js?"}]
        )

        # 5. POST /api/conversations/<id>/projects
        req = urllib.request.Request(
            _url("/api/conversations/conv-api-1/projects"),
            data=json.dumps({"project_ids": [proj_id]}).encode('utf-8'),
            headers={'Content-Type': 'application/json'}
        )
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            assert data["status"] == "success"
            assert len(data["projects"]) == 1

        # 6. GET /api/conversations?project_id=<id>
        req = urllib.request.Request(_url(f"/api/conversations?project_id={proj_id}"))
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            assert data["total"] == 1
            assert data["conversations"][0]["id"] == "conv-api-1"
            assert len(data["conversations"][0]["projects"]) == 1

        # 7. POST /api/conversations/batch-projects
        db.insert_conversation(
            {"id": "conv-api-2", "title": "Vue App", "created_at": time.time(), "updated_at": time.time()},
            [{"id": "m2", "role": "user", "content": "Vue reactivity"}]
        )
        req = urllib.request.Request(
            _url("/api/conversations/batch-projects"),
            data=json.dumps({"conversation_ids": ["conv-api-2"], "add_project_ids": [proj_id]}).encode('utf-8'),
            headers={'Content-Type': 'application/json'}
        )
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            assert data["status"] == "success"

        # Check total in project
        req = urllib.request.Request(_url(f"/api/conversations?project_id={proj_id}"))
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            assert data["total"] == 2

        # 8. DELETE /api/projects/<id>
        req = urllib.request.Request(
            _url(f"/api/projects/{proj_id}"),
            method='DELETE'
        )
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            assert data["status"] == "deleted"

        # Verify project is deleted but conversations remain
        req = urllib.request.Request(_url("/api/conversations"))
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            assert data["total"] == 2

    finally:
        server.shutdown()
        server.server_close()
        temp_dir.cleanup()

