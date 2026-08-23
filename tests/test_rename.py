"""
Comprehensive unit and integration tests for conversation renaming and custom_title persistence.
"""

import unittest
import tempfile
import os
import json
import sqlite3
import threading
import time
import urllib.request
import urllib.parse
import socketserver
import http.server

from server.db import Database
from server.parser import parse_openai_conversation, parse_export_data
from server.app import ApiRequestHandler

class TestRenameAndCustomTitle(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.temp_dir.name, "test_rename.db")
        self.db = Database(self.db_path)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_01_schema_and_migration(self):
        """Verify custom_title column exists on new DB and is auto-migrated on legacy DB."""
        conn = self.db.get_connection()
        cols = [r[1] for r in conn.execute("PRAGMA table_info(conversations)").fetchall()]
        self.assertIn("custom_title", cols)

        # Simulate legacy DB without custom_title
        legacy_path = os.path.join(self.temp_dir.name, "legacy.db")
        legacy_conn = sqlite3.connect(legacy_path)
        legacy_conn.execute("""
            CREATE TABLE conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                current_node TEXT,
                format TEXT DEFAULT 'openai',
                model_slug TEXT,
                message_count INTEGER DEFAULT 0,
                metadata_json TEXT
            )
        """)
        legacy_conn.execute("INSERT INTO conversations VALUES ('c1', 'Legacy Title', 100, 100, 'n1', 'openai', 'gpt-4', 1, '{}')")
        legacy_conn.commit()
        legacy_conn.close()

        # Opening with Database class should auto-migrate
        migrated_db = Database(legacy_path)
        m_conn = migrated_db.get_connection()
        m_cols = [r[1] for r in m_conn.execute("PRAGMA table_info(conversations)").fetchall()]
        self.assertIn("custom_title", m_cols)
        row = m_conn.execute("SELECT id, title, custom_title FROM conversations WHERE id = 'c1'").fetchone()
        self.assertEqual(row['title'], 'Legacy Title')
        self.assertIsNone(row['custom_title'])

    def test_02_rename_and_query(self):
        """Verify update_conversation_title updates custom_title and read queries resolve correctly."""
        raw_conv = {
            "id": "conv_rename_1",
            "title": "Original ChatGPT Title",
            "create_time": 1700000000.0,
            "update_time": 1700000000.0,
            "current_node": "m1",
            "mapping": {
                "m1": {
                    "id": "m1",
                    "parent": None,
                    "children": [],
                    "message": {
                        "id": "m1",
                        "author": {"role": "user"},
                        "content": {"parts": ["Hello world"]},
                        "create_time": 1700000000.0
                    }
                }
            }
        }
        meta, msgs = parse_openai_conversation(raw_conv)
        self.db.insert_conversation(meta, msgs)

        # Before rename
        conv = self.db.get_conversation("conv_rename_1")
        self.assertEqual(conv['title'], "Original ChatGPT Title")
        self.assertEqual(conv['original_title'], "Original ChatGPT Title")
        self.assertIsNone(conv.get('custom_title'))

        # Rename
        updated = self.db.update_conversation_title("conv_rename_1", "My Custom Project A")
        self.assertIsNotNone(updated)
        self.assertEqual(updated['title'], "My Custom Project A")
        self.assertEqual(updated['custom_title'], "My Custom Project A")
        self.assertEqual(updated['original_title'], "Original ChatGPT Title")
        self.assertEqual(updated['updated_at'], 1700000000.0, "Renaming must NOT alter updated_at timestamp")

        # In list_conversations list
        convs, total = self.db.list_conversations()
        self.assertEqual(total, 1)
        self.assertEqual(convs[0]['title'], "My Custom Project A")
        self.assertEqual(convs[0]['custom_title'], "My Custom Project A")
        self.assertEqual(convs[0]['original_title'], "Original ChatGPT Title")

    def test_03_reimport_preserves_custom_title(self):
        """Verify re-importing the original export file keeps custom_title without being overwritten."""
        raw_conv = {
            "id": "conv_persist_1",
            "title": "Original Platform Name",
            "create_time": 1700000000.0,
            "update_time": 1700000000.0,
            "current_node": "m1",
            "mapping": {
                "m1": {
                    "id": "m1",
                    "parent": None,
                    "children": [],
                    "message": {
                        "id": "m1",
                        "author": {"role": "user"},
                        "content": {"parts": ["Initial message"]},
                        "create_time": 1700000000.0
                    }
                }
            }
        }
        pairs = parse_export_data([raw_conv])
        self.db.insert_conversations_batch(pairs)

        # User renames the chat locally
        self.db.update_conversation_title("conv_persist_1", "Renamed By User")
        conv_before = self.db.get_conversation("conv_persist_1")
        self.assertEqual(conv_before['title'], "Renamed By User")

        # Now simulate re-importing the exact same export file months later
        # (with an extra message added from ChatGPT)
        updated_export = {
            "id": "conv_persist_1",
            "title": "Original Platform Name", # export file still has original title
            "create_time": 1700000000.0,
            "update_time": 1700005000.0,
            "current_node": "m2",
            "mapping": {
                "m1": {
                    "id": "m1",
                    "parent": None,
                    "children": ["m2"],
                    "message": {
                        "id": "m1",
                        "author": {"role": "user"},
                        "content": {"parts": ["Initial message"]},
                        "create_time": 1700000000.0
                    }
                },
                "m2": {
                    "id": "m2",
                    "parent": "m1",
                    "children": [],
                    "message": {
                        "id": "m2",
                        "author": {"role": "assistant"},
                        "content": {"parts": ["New reply added later"]},
                        "create_time": 1700005000.0
                    }
                }
            }
        }
        new_pairs = parse_export_data([updated_export])
        self.db.insert_conversations_batch(new_pairs)

        # Verify conversation preserved the custom title!
        conv_after = self.db.get_conversation("conv_persist_1")
        self.assertEqual(conv_after['title'], "Renamed By User")
        self.assertEqual(conv_after['custom_title'], "Renamed By User")
        self.assertEqual(conv_after['original_title'], "Original Platform Name")
        # And new message was also updated
        self.assertEqual(len(conv_after['active_branch']), 2)

    def test_04_restore_original_title(self):
        """Passing empty string or None restores the original title."""
        raw_conv = {
            "id": "conv_restore_1",
            "title": "Original Title",
            "create_time": 1700000000.0,
            "current_node": "m1",
            "mapping": {
                "m1": {
                    "id": "m1", "parent": None, "children": [],
                    "message": {"id": "m1", "author": {"role": "user"}, "content": {"parts": ["Hi"]}}
                }
            }
        }
        self.db.insert_conversation(*parse_openai_conversation(raw_conv))
        self.db.update_conversation_title("conv_restore_1", "Temporary Name")
        self.assertEqual(self.db.get_conversation("conv_restore_1")['title'], "Temporary Name")

        # Reset title
        self.db.update_conversation_title("conv_restore_1", "")
        restored = self.db.get_conversation("conv_restore_1")
        self.assertEqual(restored['title'], "Original Title")
        self.assertIsNone(restored.get('custom_title'))

    def test_05_search_matches_both_titles(self):
        """Search query matches both custom title and original title."""
        raw_conv = {
            "id": "conv_search_1",
            "title": "Alpha Research Notes",
            "create_time": 1700000000.0,
            "current_node": "m1",
            "mapping": {
                "m1": {
                    "id": "m1", "parent": None, "children": [],
                    "message": {"id": "m1", "author": {"role": "user"}, "content": {"parts": ["Content message"]}}
                }
            }
        }
        self.db.insert_conversation(*parse_openai_conversation(raw_conv))
        self.db.update_conversation_title("conv_search_1", "Beta Custom Name")

        # Search by custom title
        res_custom, total_custom = self.db.list_conversations(query="Beta")
        self.assertEqual(total_custom, 1)
        self.assertEqual(res_custom[0]['id'], "conv_search_1")

        # Search by original title
        res_orig, total_orig = self.db.list_conversations(query="Alpha")
        self.assertEqual(total_orig, 1)
        self.assertEqual(res_orig[0]['id'], "conv_search_1")


class TestRenameApiServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp_dir = tempfile.TemporaryDirectory()
        cls.db_path = os.path.join(cls.temp_dir.name, "test_api_rename.db")
        cls.db = Database(cls.db_path)
        ApiRequestHandler.db = cls.db

        class ThreadedServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
            daemon_threads = True

        cls.server = ThreadedServer(("127.0.0.1", 0), ApiRequestHandler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever)
        cls.thread.daemon = True
        cls.thread.start()
        time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.temp_dir.cleanup()

    def _url(self, path):
        return f"http://127.0.0.1:{self.port}{path}"

    def test_api_rename_endpoint(self):
        """Test PUT /api/conversations/<id>/title and PUT /api/conversations/<id>."""
        raw_conv = {
            "id": "api_conv_1",
            "title": "API Original Title",
            "create_time": 1700000000.0,
            "current_node": "m1",
            "mapping": {
                "m1": {
                    "id": "m1", "parent": None, "children": [],
                    "message": {"id": "m1", "author": {"role": "user"}, "content": {"parts": ["API test"]}}
                }
            }
        }
        self.db.insert_conversation(*parse_openai_conversation(raw_conv))

        # 1. Rename via PUT /api/conversations/<id>/title
        req = urllib.request.Request(
            self._url("/api/conversations/api_conv_1/title"),
            data=json.dumps({"title": "API Renamed Title"}).encode('utf-8'),
            headers={'Content-Type': 'application/json'},
            method='PUT'
        )
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode('utf-8'))
            self.assertEqual(data['status'], 'updated')
            self.assertEqual(data['conversation']['title'], 'API Renamed Title')
            self.assertEqual(data['conversation']['custom_title'], 'API Renamed Title')
            self.assertEqual(data['conversation']['original_title'], 'API Original Title')

        # 2. Rename 404 for non-existent conversation
        req_404 = urllib.request.Request(
            self._url("/api/conversations/non_existent_conv/title"),
            data=json.dumps({"title": "Test"}).encode('utf-8'),
            headers={'Content-Type': 'application/json'},
            method='PUT'
        )
        with self.assertRaises(urllib.error.HTTPError) as cm:
            urllib.request.urlopen(req_404)
        self.assertEqual(cm.exception.code, 404)

if __name__ == '__main__':
    unittest.main()
