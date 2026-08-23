"""
Comprehensive unit and integration tests for Star / Favorite collection feature.
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


class TestStarredFeature(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.temp_dir.name, "test_starred.db")
        self.db = Database(self.db_path)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_01_schema_and_migration(self):
        """Verify is_starred column exists on new DB and is auto-migrated on legacy DB."""
        conn = self.db.get_connection()
        cols = [r[1] for r in conn.execute("PRAGMA table_info(conversations)").fetchall()]
        self.assertIn("is_starred", cols)

        # Simulate legacy DB without is_starred
        legacy_path = os.path.join(self.temp_dir.name, "legacy_starred.db")
        legacy_conn = sqlite3.connect(legacy_path)
        legacy_conn.execute("""
            CREATE TABLE conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                custom_title TEXT,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                current_node TEXT,
                format TEXT DEFAULT 'openai',
                model_slug TEXT,
                message_count INTEGER DEFAULT 0,
                metadata_json TEXT
            )
        """)
        legacy_conn.execute("INSERT INTO conversations VALUES ('c1', 'Legacy Title', NULL, 100, 100, 'n1', 'openai', 'gpt-4', 1, '{}')")
        legacy_conn.commit()
        legacy_conn.close()

        # Opening with Database class should auto-migrate is_starred
        migrated_db = Database(legacy_path)
        m_conn = migrated_db.get_connection()
        m_cols = [r[1] for r in m_conn.execute("PRAGMA table_info(conversations)").fetchall()]
        self.assertIn("is_starred", m_cols)

        # Query legacy row
        c1 = migrated_db.get_conversation("c1")
        self.assertIsNotNone(c1)
        self.assertFalse(c1["is_starred"])

    def test_02_toggle_star(self):
        """Test toggling conversation star status on and off."""
        # Insert conversation
        self.db.insert_conversation({
            "id": "conv-star-1",
            "title": "Star Test 1",
            "created_at": 1000.0,
            "updated_at": 1000.0,
            "current_node": "n1",
            "format": "openai",
            "model_slug": "gpt-4",
            "message_count": 2,
            "metadata_json": "{}"
        }, [])

        # Check default status
        conv = self.db.get_conversation("conv-star-1")
        self.assertFalse(conv["is_starred"])

        # Toggle to True
        updated = self.db.toggle_conversation_star("conv-star-1")
        self.assertTrue(updated["is_starred"])
        self.assertEqual(updated["updated_at"], 1000.0, "Starring must NOT mutate updated_at timestamp")

        # Toggle back to False
        updated2 = self.db.toggle_conversation_star("conv-star-1")
        self.assertFalse(updated2["is_starred"])
        self.assertEqual(updated2["updated_at"], 1000.0, "Unstarring must NOT mutate updated_at timestamp")

        # Set explicitly to True
        updated3 = self.db.toggle_conversation_star("conv-star-1", True)
        self.assertTrue(updated3["is_starred"])
        self.assertEqual(updated3["updated_at"], 1000.0)

        # Set explicitly to False
        updated4 = self.db.toggle_conversation_star("conv-star-1", False)
        self.assertFalse(updated4["is_starred"])
        self.assertEqual(updated4["updated_at"], 1000.0)

    def test_03_list_starred_filtering(self):
        """Test list_conversations filtering by starred status."""
        for i in range(5):
            self.db.insert_conversation({
                "id": f"conv-{i}",
                "title": f"Chat {i}",
                "created_at": 1000.0 + i,
                "updated_at": 1000.0 + i,
                "current_node": "n1",
                "format": "openai",
                "model_slug": "gpt-4",
                "message_count": 1,
                "metadata_json": "{}",
                "is_starred": (i % 2 == 1) # conv-1 and conv-3 are starred
            }, [])

        # List all
        all_convs, total_all = self.db.list_conversations()
        self.assertEqual(total_all, 5)

        # List starred only
        starred_convs, total_starred = self.db.list_conversations(starred=True)
        self.assertEqual(total_starred, 2)
        starred_ids = [c["id"] for c in starred_convs]
        self.assertEqual(set(starred_ids), {"conv-1", "conv-3"})
        for c in starred_convs:
            self.assertTrue(c["is_starred"])

        # List unstarred only
        unstarred_convs, total_unstarred = self.db.list_conversations(starred=False)
        self.assertEqual(total_unstarred, 3)
        unstarred_ids = [c["id"] for c in unstarred_convs]
        self.assertEqual(set(unstarred_ids), {"conv-0", "conv-2", "conv-4"})

        # Stats check
        stats = self.db.get_stats()
        self.assertEqual(stats["total_conversations"], 5)
        self.assertEqual(stats["starred_conversations"], 2)

    def test_04_preserve_star_on_reimport(self):
        """Verify that re-importing conversations preserves user's starred status."""
        # 1. First import
        self.db.insert_conversation({
            "id": "conv-reimport-1",
            "title": "Original Title",
            "created_at": 1000.0,
            "updated_at": 1000.0,
            "current_node": "n1",
            "format": "openai",
            "model_slug": "gpt-4",
            "message_count": 2,
            "metadata_json": "{}"
        }, [])

        # 2. User stars the chat & gives it a custom title
        self.db.toggle_conversation_star("conv-reimport-1", True)
        self.db.update_conversation_title("conv-reimport-1", "My Special Chat")

        # 3. User re-imports full export file containing this chat with original title and is_starred = 0
        self.db.insert_conversation({
            "id": "conv-reimport-1",
            "title": "Updated Upstream Title",
            "created_at": 1000.0,
            "updated_at": 1100.0,
            "current_node": "n2",
            "format": "openai",
            "model_slug": "gpt-4o",
            "message_count": 4,
            "metadata_json": "{}"
        }, [])

        # 4. Check that custom_title AND is_starred are still preserved
        conv = self.db.get_conversation("conv-reimport-1")
        self.assertEqual(conv["title"], "My Special Chat")
        self.assertEqual(conv["original_title"], "Updated Upstream Title")
        self.assertTrue(conv["is_starred"])


class TestStarredHttpApi(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp_dir = tempfile.TemporaryDirectory()
        cls.db_path = os.path.join(cls.temp_dir.name, "http_starred_test.db")
        cls.db = Database(cls.db_path)
        ApiRequestHandler.db = cls.db

        # Seed conversations
        cls.db.insert_conversation({
            "id": "http-c1",
            "title": "HTTP Conversation 1",
            "created_at": 1000.0,
            "updated_at": 1000.0,
            "current_node": "n1",
            "format": "openai",
            "model_slug": "gpt-4",
            "message_count": 1,
            "metadata_json": "{}"
        }, [])

        cls.db.insert_conversation({
            "id": "http-c2",
            "title": "HTTP Conversation 2",
            "created_at": 2000.0,
            "updated_at": 2000.0,
            "current_node": "n1",
            "format": "openai",
            "model_slug": "gpt-4",
            "message_count": 1,
            "metadata_json": "{}"
        }, [])

        class ThreadedServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
            daemon_threads = True

        cls.server = ThreadedServer(("127.0.0.1", 0), ApiRequestHandler)
        cls.port = cls.server.server_address[1]
        cls.server_thread = threading.Thread(target=cls.server.serve_forever)
        cls.server_thread.daemon = True
        cls.server_thread.start()
        time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.temp_dir.cleanup()

    def test_01_toggle_star_http_endpoint(self):
        """Test POST /api/conversations/<id>/star toggling star status."""
        url = f"http://127.0.0.1:{self.port}/api/conversations/http-c1/star"
        req = urllib.request.Request(url, data=b"{}", headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode("utf-8"))
            self.assertEqual(data["status"], "success")
            self.assertTrue(data["is_starred"])
            self.assertTrue(data["conversation"]["is_starred"])

        # Check filtering on GET /api/conversations?starred=true
        list_url = f"http://127.0.0.1:{self.port}/api/conversations?starred=true"
        with urllib.request.urlopen(list_url) as resp:
            self.assertEqual(resp.status, 200)
            list_data = json.loads(resp.read().decode("utf-8"))
            self.assertEqual(list_data["total"], 1)
            self.assertEqual(list_data["conversations"][0]["id"], "http-c1")

        # Toggle off via POST
        req2 = urllib.request.Request(url, data=json.dumps({"is_starred": False}).encode("utf-8"), headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req2) as resp2:
            self.assertEqual(resp2.status, 200)
            data2 = json.loads(resp2.read().decode("utf-8"))
            self.assertFalse(data2["is_starred"])

        # Check filtering again
        with urllib.request.urlopen(list_url) as resp3:
            self.assertEqual(resp3.status, 200)
            list_data3 = json.loads(resp3.read().decode("utf-8"))
            self.assertEqual(list_data3["total"], 0)


if __name__ == "__main__":
    unittest.main()
