"""
Local HTTP REST API & Static File Server for LLM Conversations Viewer.
Zero-dependency implementation using Python standard library.
Handles conversations, full-text search, attachments static serving, and import endpoints.
"""

import http.server
import socketserver
import json
import urllib.parse
import os
import sys
import io
import shutil
import zipfile
import mimetypes
import tempfile
from email.parser import BytesParser
from email.policy import default
from typing import Optional, Any, Dict, List

from server.db import Database, DEFAULT_DB_PATH, get_default_attachments_dir
from server.parser import parse_export_data
from server.importer import extract_media_from_zip, extract_media_from_directory

def _safe_int(val: Any, default_val: int) -> int:
    try:
        return int(val)
    except (ValueError, TypeError):
        return default_val

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

class ApiRequestHandler(http.server.SimpleHTTPRequestHandler):
    db: Optional[Database] = None
    attachments_dir: str = os.path.join(PROJECT_ROOT, "attachments")

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PROJECT_ROOT, **kwargs)

    def _send_json(self, data: Any, status: int = 200):
        try:
            body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        except UnicodeEncodeError:
            body = json.dumps(data, ensure_ascii=True).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
        self.wfile.write(body)

    def _send_error_json(self, message: str, status: int = 400):
        self._send_json({"error": message, "status": status}, status=status)

    def end_headers(self):
        # Disable caching for API calls, allow caching for static assets
        if not self.path.startswith('/api/attachments/'):
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        # API routing: List conversations
        if path == '/api/conversations':
            limit = _safe_int(query.get('limit', [100])[0], 100)
            offset = _safe_int(query.get('offset', [0])[0], 0)
            search_q = query.get('q', [None])[0]
            sort_by = query.get('sort_by', ['date'])[0]
            sort_order = query.get('order', query.get('sort_order', ['desc']))[0]
            project_id = query.get('project_id', [None])[0]
            starred = query.get('starred', [None])[0]
            starred_bool = True if starred in ('1', 'true', 'True') else (False if starred in ('0', 'false', 'False') else None)

            convs, total = self.db.list_conversations(
                limit=limit,
                offset=offset,
                query=search_q,
                sort_by=sort_by,
                sort_order=sort_order,
                project_id=project_id,
                starred=starred_bool
            )
            self._send_json({
                "conversations": convs,
                "total": total,
                "limit": limit,
                "offset": offset,
                "sort_by": sort_by,
                "order": sort_order,
                "project_id": project_id,
                "starred": starred_bool
            })
            return

        # API routing: List all projects
        elif path == '/api/projects':
            projects = self.db.list_projects()
            self._send_json({"projects": projects, "total": len(projects)})
            return

        # API routing: Single project
        elif path.startswith('/api/projects/'):
            project_id = path[len('/api/projects/'):].strip()
            project = self.db.get_project(project_id)
            if not project:
                self._send_error_json("Project not found", 404)
                return
            self._send_json({"project": project})
            return

        # API routing: Attachments serving
        elif path.startswith('/api/attachments/'):
            raw_filename = path[len('/api/attachments/'):].strip()
            decoded_filename = urllib.parse.unquote(raw_filename)
            norm_rel = os.path.normpath(decoded_filename).lstrip('/\\')
            abs_att_dir = os.path.abspath(self.attachments_dir)
            full_path = os.path.abspath(os.path.join(abs_att_dir, norm_rel))

            # Security check against path traversal
            try:
                if os.path.commonpath([abs_att_dir, full_path]) != abs_att_dir:
                    self._send_error_json("Attachment not found", 404)
                    return
            except ValueError:
                self._send_error_json("Attachment not found", 404)
                return

            if not os.path.exists(full_path) or os.path.isdir(full_path):
                self._send_error_json("Attachment not found", 404)
                return

            # Guess MIME type
            mime, _ = mimetypes.guess_type(full_path)
            if not mime:
                lower_f = full_path.lower()
                if lower_f.endswith('.webp'):
                    mime = 'image/webp'
                elif lower_f.endswith(('.jfif', '.jpg', '.jpeg')):
                    mime = 'image/jpeg'
                elif lower_f.endswith('.png'):
                    mime = 'image/png'
                elif lower_f.endswith('.wav'):
                    mime = 'audio/wav'
                elif lower_f.endswith('.mp3'):
                    mime = 'audio/mpeg'
                elif lower_f.endswith('.mp4'):
                    mime = 'video/mp4'
                else:
                    mime = 'application/octet-stream'

            file_size = os.path.getsize(full_path)
            self.send_response(200)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(file_size))
            self.send_header('Cache-Control', 'public, max-age=31536000, immutable')
            self.send_header('Access-Control-Allow-Origin', '*')
            super().end_headers()

            with open(full_path, 'rb') as f:
                shutil.copyfileobj(f, self.wfile)
            return

        # API routing: Single conversation
        elif path.startswith('/api/conversations/'):
            conv_id = path[len('/api/conversations/'):].strip()
            leaf_node = query.get('leaf_node_id', [None])[0]
            conv = self.db.get_conversation(conv_id, leaf_node_id=leaf_node)
            if not conv:
                self._send_error_json("Conversation not found", 404)
                return
            self._send_json({"conversation": conv})
            return

        # API routing: FTS Search
        elif path == '/api/search':
            q = query.get('q', [''])[0]
            limit = _safe_int(query.get('limit', [50])[0], 50)
            results = self.db.search(q, limit=limit)
            self._send_json({"results": results, "query": q, "count": len(results)})
            return

        # API routing: Stats
        elif path == '/api/stats':
            stats = self.db.get_stats()
            self._send_json({"stats": stats})
            return

        # API routing: Analytics & Insights
        elif path == '/api/analytics':
            cutoff_hour = _safe_int(query.get('cutoff_hour', [0])[0], 0)
            analytics_data = self.db.get_analytics(cutoff_hour=cutoff_hour)
            self._send_json({"analytics": analytics_data})
            return

        # Fallback to static files
        if path == '/':
            self.path = '/index.html'
        super().do_GET()

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path.startswith('/api/projects/'):
            project_id = path[len('/api/projects/'):].strip()
            success = self.db.delete_project(project_id)
            if success:
                self._send_json({"status": "deleted", "id": project_id})
            else:
                self._send_error_json("Project not found", 404)
            return

        elif path.startswith('/api/conversations/'):
            conv_id = path[len('/api/conversations/'):].strip()
            success = self.db.delete_conversation(conv_id)
            if success:
                self._send_json({"status": "deleted", "id": conv_id})
            else:
                self._send_error_json("Conversation not found", 404)
            return

        self._send_error_json("Not found", 404)

    def do_PATCH(self):
        self.do_PUT()

    def do_PUT(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        content_length = int(self.headers.get('Content-Length', 0))
        raw_body = self.rfile.read(content_length).decode('utf-8') if content_length > 0 else '{}'

        try:
            body = json.loads(raw_body)
        except Exception:
            self._send_error_json("Invalid JSON body", 400)
            return

        if path.startswith('/api/projects/'):
            project_id = path[len('/api/projects/'):].strip()
            updated = self.db.update_project(
                project_id=project_id,
                name=body.get('name'),
                color=body.get('color'),
                icon=body.get('icon'),
                description=body.get('description')
            )
            if not updated:
                self._send_error_json("Project not found", 404)
                return
            self._send_json({"status": "updated", "project": updated})
            return

        elif path.startswith('/api/conversations/'):
            if path.endswith('/star'):
                conv_id = path[len('/api/conversations/'):-len('/star')].strip()
                is_starred_param = body.get('is_starred')
                updated = self.db.toggle_conversation_star(conv_id, is_starred_param)
                if not updated:
                    self._send_error_json("Conversation not found", 404)
                    return
                self._send_json({"status": "success", "conversation": updated, "is_starred": updated.get('is_starred', False)})
                return

            conv_id = path[len('/api/conversations/'):].strip()
            if '/' in conv_id:
                parts = conv_id.split('/')
                conv_id = parts[0]
            new_title = body.get('title') if 'title' in body else body.get('custom_title')
            updated = self.db.update_conversation_title(conv_id, new_title)
            if not updated:
                self._send_error_json("Conversation not found", 404)
                return
            self._send_json({"status": "updated", "conversation": updated})
            return

        self._send_error_json("Endpoint not found", 404)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        # Star / Favorite toggle: POST /api/conversations/<id>/star
        if path.startswith('/api/conversations/') and path.endswith('/star'):
            conv_id = path[len('/api/conversations/'):-len('/star')].strip()
            content_length = int(self.headers.get('Content-Length', 0))
            raw_body = self.rfile.read(content_length).decode('utf-8') if content_length > 0 else '{}'
            try:
                body = json.loads(raw_body) if raw_body.strip() else {}
            except Exception:
                body = {}
            is_starred_param = body.get('is_starred')
            updated = self.db.toggle_conversation_star(conv_id, is_starred_param)
            if not updated:
                self._send_error_json("Conversation not found", 404)
                return
            self._send_json({"status": "success", "conversation": updated, "is_starred": updated.get('is_starred', False)})
            return

        # Projects: Create
        elif path == '/api/projects':
            content_length = int(self.headers.get('Content-Length', 0))
            raw_body = self.rfile.read(content_length).decode('utf-8') if content_length > 0 else '{}'
            try:
                body = json.loads(raw_body)
                name = body.get('name', '').strip()
                if not name:
                    self._send_error_json("Project name is required", 400)
                    return
                color = body.get('color', '#3b82f6')
                icon = body.get('icon', '📁')
                description = body.get('description', '')
                project = self.db.create_project(name=name, color=color, icon=icon, description=description)
                self._send_json({"status": "created", "project": project}, status=201)
                return
            except Exception as e:
                self._send_error_json(f"Failed to create project: {str(e)}", 400)
                return

        # Conversations: Batch Assign Projects
        elif path == '/api/conversations/batch-projects':
            content_length = int(self.headers.get('Content-Length', 0))
            raw_body = self.rfile.read(content_length).decode('utf-8') if content_length > 0 else '{}'
            try:
                body = json.loads(raw_body)
                conv_ids = body.get('conversation_ids', [])
                add_project_ids = body.get('add_project_ids', [])
                remove_project_ids = body.get('remove_project_ids', [])
                res = self.db.batch_assign_projects(conv_ids, add_project_ids, remove_project_ids)
                self._send_json(res)
                return
            except Exception as e:
                self._send_error_json(f"Failed to batch assign projects: {str(e)}", 400)
                return

        # Single conversation project assignment: POST /api/conversations/<id>/projects
        elif path.startswith('/api/conversations/') and path.endswith('/projects'):
            conv_id = path[len('/api/conversations/'):-len('/projects')].strip()
            content_length = int(self.headers.get('Content-Length', 0))
            raw_body = self.rfile.read(content_length).decode('utf-8') if content_length > 0 else '{}'
            try:
                body = json.loads(raw_body)
                project_ids = body.get('project_ids', [])
                assigned = self.db.set_conversation_projects(conv_id, project_ids)
                self._send_json({"status": "success", "conversation_id": conv_id, "projects": assigned})
                return
            except Exception as e:
                self._send_error_json(f"Failed to assign projects: {str(e)}", 400)
                return

        elif path == '/api/import':
            content_type = self.headers.get('Content-Type', '')
            content_length = int(self.headers.get('Content-Length', 0))

            if 'multipart/form-data' in content_type:
                temp_upload = None
                temp_path = None
                try:
                    temp_upload = tempfile.NamedTemporaryFile(delete=False, suffix='.upload')
                    temp_path = temp_upload.name

                    # Stream chunks directly from socket to temporary disk file
                    remaining = content_length
                    chunk_size = 65536
                    while remaining > 0:
                        read_len = min(remaining, chunk_size)
                        buf = self.rfile.read(read_len)
                        if not buf:
                            break
                        temp_upload.write(buf)
                        remaining -= len(buf)
                    temp_upload.flush()
                    temp_upload.close()

                    # Read payload
                    with open(temp_path, 'rb') as fp:
                        raw_body = fp.read()

                    # Multipart parsing via email.parser
                    msg_header = f"Content-Type: {content_type}\r\n\r\n".encode('latin1')
                    parsed_msg = BytesParser(policy=default).parsebytes(msg_header + raw_body)
                    del raw_body

                    file_bytes = None
                    filename = 'upload'

                    if parsed_msg.is_multipart():
                        for part in parsed_msg.iter_parts():
                            if part.get_filename() or part.get_param('name', header='content-disposition') == 'file':
                                file_bytes = part.get_payload(decode=True)
                                filename = part.get_filename() or 'upload'
                                break
                    del parsed_msg

                    if not file_bytes:
                        self._send_error_json("No file found in multipart upload", 400)
                        return

                    media_index = {}
                    if filename.lower().endswith('.zip') or file_bytes[:4] == b'PK\x03\x04':
                        with zipfile.ZipFile(io.BytesIO(file_bytes)) as z:
                            from server.importer import find_conversation_files_in_zip, extract_media_from_zip
                            conv_files = find_conversation_files_in_zip(z)
                            if not conv_files:
                                self._send_error_json("Could not find conversations.json or conversations-*.json inside ZIP", 400)
                                return
                            media_index = extract_media_from_zip(z, self.attachments_dir)
                            raw_data = []
                            for cf in conv_files:
                                with z.open(cf) as zf:
                                    chunk = json.load(zf)
                                    if isinstance(chunk, list):
                                        raw_data.extend(chunk)
                                    elif isinstance(chunk, dict) and 'mapping' in chunk:
                                        raw_data.append(chunk)
                    else:
                        loaded = json.loads(file_bytes.decode('utf-8'))
                        raw_data = loaded if isinstance(loaded, list) else ([loaded] if isinstance(loaded, dict) and 'mapping' in loaded else [])
                        media_index = extract_media_from_directory(self.attachments_dir, self.attachments_dir)
                    del file_bytes

                    parsed_pairs = parse_export_data(raw_data, media_index=media_index)
                    total_messages = self.db.insert_conversations_batch(parsed_pairs)
                    count = len(parsed_pairs)

                    self._send_json({
                        "status": "success",
                        "imported": count,
                        "imported_conversations": count,
                        "imported_messages": total_messages,
                        "extracted_attachments": len(media_index)
                    })
                    return
                except Exception as e:
                    self._send_error_json(f"Failed to process upload: {str(e)}", 400)
                    return
                finally:
                    if temp_path and os.path.exists(temp_path):
                        try:
                            os.remove(temp_path)
                        except OSError:
                            pass

            elif 'application/json' in content_type:
                raw_body = self.rfile.read(content_length).decode('utf-8')
                try:
                    raw_data = json.loads(raw_body)
                    # Check if direct local path import
                    if isinstance(raw_data, dict) and raw_data.get('path'):
                        file_path = raw_data['path']
                        from server.importer import import_file
                        res = import_file(file_path, db_path=self.db.db_path, attachments_dir=self.attachments_dir)
                        self._send_json(res)
                        return

                    media_index = extract_media_from_directory(self.attachments_dir, self.attachments_dir)
                    parsed_pairs = parse_export_data(raw_data, media_index=media_index)
                    count = 0
                    for conv, msgs in parsed_pairs:
                        self.db.insert_conversation(conv, msgs)
                        count += 1
                    self._send_json({"status": "success", "imported": count})
                    return
                except Exception as e:
                    self._send_error_json(f"Failed to import JSON: {str(e)}", 400)
                    return
            else:
                self._send_error_json("Unsupported Content-Type", 400)
                return

        self._send_error_json("Endpoint not found", 404)

def run_server(port: int = 8000, db_path: str = DEFAULT_DB_PATH, attachments_dir: Optional[str] = None):
    if not attachments_dir:
        attachments_dir = get_default_attachments_dir(db_path)
    os.makedirs(attachments_dir, exist_ok=True)

    db_instance = Database(db_path)
    ApiRequestHandler.db = db_instance
    ApiRequestHandler.attachments_dir = attachments_dir

    class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
        daemon_threads = True
        allow_reuse_address = True

    with ThreadedHTTPServer(("127.0.0.1", port), ApiRequestHandler) as httpd:
        print(f"==================================================")
        print(f" LLM Chat Vault Local Server")
        print(f" Serving UI & API at: http://127.0.0.1:{port}")
        print(f" SQLite Database:     {db_path}")
        print(f" Attachments Dir:     {attachments_dir}")
        print(f"==================================================")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.")

if __name__ == '__main__':
    port_arg = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    db_arg = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_DB_PATH
    att_arg = sys.argv[3] if len(sys.argv) > 3 else None
    run_server(port=port_arg, db_path=db_arg, attachments_dir=att_arg)
