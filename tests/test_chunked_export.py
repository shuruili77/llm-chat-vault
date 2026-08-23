import os
import json
import zipfile
import tempfile
import pytest
from server.db import Database
from server.importer import import_file, find_conversation_files_in_dir, find_conversation_files_in_zip
from server.parser import parse_export_data, detect_format

def make_sample_openai_conv(conv_id, title, msg_text, att_file_id=None):
    mapping = {
        "root-node": {
            "id": "root-node",
            "message": None,
            "parent": None,
            "children": ["msg-user"]
        },
        "msg-user": {
            "id": "msg-user",
            "message": {
                "id": "msg-user",
                "author": {"role": "user"},
                "create_time": 1720000000.0,
                "content": {
                    "content_type": "text",
                    "parts": [msg_text]
                },
                "metadata": {
                    "attachments": [{"id": att_file_id, "name": "sample.png"}] if att_file_id else []
                }
            },
            "parent": "root-node",
            "children": ["msg-assistant"]
        },
        "msg-assistant": {
            "id": "msg-assistant",
            "message": {
                "id": "msg-assistant",
                "author": {"role": "assistant"},
                "create_time": 1720000010.0,
                "content": {
                    "content_type": "text",
                    "parts": ["Assistant response to: " + msg_text]
                },
                "metadata": {}
            },
            "parent": "msg-user",
            "children": []
        }
    }
    return {
        "id": conv_id,
        "conversation_id": conv_id,
        "title": title,
        "create_time": 1720000000.0,
        "update_time": 1720000010.0,
        "current_node": "msg-assistant",
        "default_model_slug": "gpt-4o",
        "mapping": mapping
    }

def test_detect_format_chunked_items():
    conv1 = make_sample_openai_conv("c1", "Title 1", "Hello 1")
    assert detect_format([conv1]) == 'openai'

def test_chunked_directory_import():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "test.db")
        att_dir = os.path.join(tmpdir, "attachments")
        export_dir = os.path.join(tmpdir, "export_data")
        os.makedirs(export_dir, exist_ok=True)

        # Create chunk 0
        chunk0 = [
            make_sample_openai_conv("c001", "Chat 1", "Message 1", "file-12345"),
            make_sample_openai_conv("c002", "Chat 2", "Message 2")
        ]
        with open(os.path.join(export_dir, "conversations-000.json"), "w", encoding="utf-8") as f:
            json.dump(chunk0, f)

        # Create chunk 1
        chunk1 = [
            make_sample_openai_conv("c003", "Chat 3", "Message 3"),
            make_sample_openai_conv("c004", "Chat 4", "Message 4")
        ]
        with open(os.path.join(export_dir, "conversations-001.json"), "w", encoding="utf-8") as f:
            json.dump(chunk1, f)

        # Create asset file name mapping
        asset_map = {
            "file-12345.dat": "photo_sample.png"
        }
        with open(os.path.join(export_dir, "conversation_asset_file_names.json"), "w", encoding="utf-8") as f:
            json.dump(asset_map, f)

        # Create dummy .dat media file
        with open(os.path.join(export_dir, "file-12345.dat"), "wb") as f:
            f.write(b"FAKE_PNG_BYTES")

        # Create export_manifest.json
        manifest = {
            "export_files": [
                {"path": "conversations-000.json"},
                {"path": "conversations-001.json"},
                {"path": "file-12345.dat"}
            ]
        }
        with open(os.path.join(export_dir, "export_manifest.json"), "w", encoding="utf-8") as f:
            json.dump(manifest, f)

        # Import directory
        res = import_file(export_dir, db_path=db_path, attachments_dir=att_dir)
        assert res["status"] == "success"
        assert res["imported_conversations"] == 4

        # Verify database contents
        db = Database(db_path)
        convs, total = db.list_conversations()
        assert total == 4
        assert len(convs) == 4
        conv_ids = {c["id"] for c in convs}
        assert conv_ids == {"c001", "c002", "c003", "c004"}

        # Verify attachment copy and link
        c1 = db.get_conversation("c001")
        assert c1 is not None
        user_msg = next((m for m in c1["active_branch"] if m["role"] == "user"), None)
        assert user_msg is not None
        assert "file-12345" in user_msg["content"] or "photo_sample.png" in user_msg["content"]

def test_chunked_zip_import():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "test.db")
        att_dir = os.path.join(tmpdir, "attachments")
        zip_path = os.path.join(tmpdir, "export.zip")

        with zipfile.ZipFile(zip_path, "w") as z:
            chunk0 = [make_sample_openai_conv("cz1", "Zip Chat 1", "Content 1")]
            chunk1 = [make_sample_openai_conv("cz2", "Zip Chat 2", "Content 2")]
            z.writestr("conversations-000.json", json.dumps(chunk0))
            z.writestr("conversations-001.json", json.dumps(chunk1))
            z.writestr("conversation_asset_file_names.json", json.dumps({"file-z1.dat": "pic.png"}))
            z.writestr("file-z1.dat", b"IMAGE_DATA")

        res = import_file(zip_path, db_path=db_path, attachments_dir=att_dir)
        assert res["status"] == "success"
        assert res["imported_conversations"] == 2

        db = Database(db_path)
        convs, total = db.list_conversations()
        assert total == 2
        assert {c["id"] for c in convs} == {"cz1", "cz2"}

def test_single_file_sibling_detection():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "test.db")
        att_dir = os.path.join(tmpdir, "attachments")
        export_dir = os.path.join(tmpdir, "export_data")
        os.makedirs(export_dir, exist_ok=True)

        chunk0 = [make_sample_openai_conv("cs1", "Sibling Chat 1", "Content 1")]
        chunk1 = [make_sample_openai_conv("cs2", "Sibling Chat 2", "Content 2")]
        c0_path = os.path.join(export_dir, "conversations-000.json")
        c1_path = os.path.join(export_dir, "conversations-001.json")
        manifest_path = os.path.join(export_dir, "export_manifest.json")

        with open(c0_path, "w", encoding="utf-8") as f:
            json.dump(chunk0, f)
        with open(c1_path, "w", encoding="utf-8") as f:
            json.dump(chunk1, f)
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump({"manifest": True}, f)

        # When pointing to export_manifest.json, auto-loads all chunks in same folder
        res = import_file(manifest_path, db_path=db_path, attachments_dir=att_dir)
        assert res["status"] == "success"
        assert res["imported_conversations"] == 2
