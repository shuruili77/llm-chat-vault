"""
Integration tests for HTTP API server endpoints.
"""

import unittest
import threading
import tempfile
import os
import json
import urllib.request
import urllib.parse
import socketserver
import http.server
import time

from server.db import Database
from server.app import ApiRequestHandler

class TestApiServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp_dir = tempfile.TemporaryDirectory()
        cls.db_path = os.path.join(cls.temp_dir.name, "test_api.db")
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

    def test_01_empty_conversations_and_stats(self):
        req = urllib.request.Request(self._url("/api/conversations"))
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            self.assertEqual(data['total'], 0)
            self.assertEqual(len(data['conversations']), 0)

        req_stats = urllib.request.Request(self._url("/api/stats"))
        with urllib.request.urlopen(req_stats) as resp:
            stats = json.loads(resp.read().decode('utf-8'))['stats']
            self.assertEqual(stats['total_conversations'], 0)

    def test_02_post_json_import_and_fetch(self):
        sample_export = [{
            "id": "api_test_conv_1",
            "title": "API Architecture Discussion",
            "create_time": 1700000000.0,
            "update_time": 1700000500.0,
            "current_node": "resp_v2",
            "mapping": {
                "root": {"id": "root", "parent": None, "children": ["p1"], "message": None},
                "p1": {
                    "id": "p1", "parent": "root", "children": ["resp_v1", "resp_v2"],
                    "message": {"id": "p1", "author": {"role": "user"}, "content": {"parts": ["What is REST?"]}, "create_time": 1700000010.0}
                },
                "resp_v1": {
                    "id": "resp_v1", "parent": "p1", "children": [],
                    "message": {"id": "resp_v1", "author": {"role": "assistant"}, "content": {"parts": ["REST is Representational State Transfer."]}, "create_time": 1700000020.0}
                },
                "resp_v2": {
                    "id": "resp_v2", "parent": "p1", "children": [],
                    "message": {"id": "resp_v2", "author": {"role": "assistant"}, "content": {"parts": ["REST is an architectural style for distributed hypermedia systems."]}, "create_time": 1700000030.0}
                }
            }
        }]

        body = json.dumps(sample_export).encode('utf-8')
        req = urllib.request.Request(
            self._url("/api/import"),
            data=body,
            headers={'Content-Type': 'application/json'}
        )
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            self.assertEqual(data['status'], 'success')
            self.assertEqual(data['imported'], 1)

        # Verify listing
        req_list = urllib.request.Request(self._url("/api/conversations"))
        with urllib.request.urlopen(req_list) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            self.assertEqual(data['total'], 1)
            self.assertEqual(data['conversations'][0]['title'], "API Architecture Discussion")

        # Fetch conversation (active branch should be resp_v2)
        req_conv = urllib.request.Request(self._url("/api/conversations/api_test_conv_1"))
        with urllib.request.urlopen(req_conv) as resp:
            conv = json.loads(resp.read().decode('utf-8'))['conversation']
            self.assertEqual(len(conv['active_branch']), 2)
            self.assertEqual(conv['active_branch'][1]['id'], "resp_v2")
            self.assertEqual(len(conv['active_branch'][1]['siblings']), 2)

        # Switch to branch resp_v1 via query param
        req_b1 = urllib.request.Request(self._url("/api/conversations/api_test_conv_1?leaf_node_id=resp_v1"))
        with urllib.request.urlopen(req_b1) as resp:
            conv_b1 = json.loads(resp.read().decode('utf-8'))['conversation']
            self.assertEqual(conv_b1['active_branch'][1]['id'], "resp_v1")
            self.assertIn("Representational State Transfer", conv_b1['active_branch'][1]['content'])

        # Switch to branch by intermediate user prompt ID (p1) -> must resolve to newest leaf resp_v2
        req_prompt = urllib.request.Request(self._url("/api/conversations/api_test_conv_1?leaf_node_id=p1"))
        with urllib.request.urlopen(req_prompt) as resp:
            conv_prompt = json.loads(resp.read().decode('utf-8'))['conversation']
            self.assertEqual(len(conv_prompt['active_branch']), 2)
            self.assertEqual(conv_prompt['active_branch'][0]['id'], "p1")
            self.assertEqual(conv_prompt['active_branch'][1]['id'], "resp_v2")

    def test_03_fts_search_endpoint(self):
        req = urllib.request.Request(self._url("/api/search?q=hypermedia"))
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            self.assertEqual(data['count'], 1)
            self.assertEqual(data['results'][0]['conversation_id'], "api_test_conv_1")
            self.assertIn("<mark>", data['results'][0]['snippet'])

    def test_04_delete_endpoint(self):
        req = urllib.request.Request(self._url("/api/conversations/api_test_conv_1"), method='DELETE')
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            self.assertEqual(data['status'], 'deleted')

        # Confirm 404 on fetch
        try:
            with urllib.request.urlopen(self._url("/api/conversations/api_test_conv_1")) as resp:
                self.fail("Expected 404 HTTPError")
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 404)

    def test_05_api_sorting(self):
        # Insert 2 conversations via /api/import
        export_payload = [
            {
                "id": "sort_conv_1",
                "title": "Short Conversation",
                "create_time": 1000.0,
                "update_time": 1000.0,
                "current_node": "s1_m1",
                "mapping": {
                    "s1_m1": {"id": "s1_m1", "parent": None, "children": [], "message": {"id": "s1_m1", "author": {"role": "user"}, "content": {"parts": ["Hello"]}}}
                }
            },
            {
                "id": "sort_conv_2",
                "title": "Longer Conversation",
                "create_time": 2000.0,
                "update_time": 2000.0,
                "current_node": "s2_m3",
                "mapping": {
                    "s2_m1": {"id": "s2_m1", "parent": None, "children": ["s2_m2"], "message": {"id": "s2_m1", "author": {"role": "user"}, "content": {"parts": ["Msg 1"]}}},
                    "s2_m2": {"id": "s2_m2", "parent": "s2_m1", "children": ["s2_m3"], "message": {"id": "s2_m2", "author": {"role": "assistant"}, "content": {"parts": ["Msg 2"]}}},
                    "s2_m3": {"id": "s2_m3", "parent": "s2_m2", "children": [], "message": {"id": "s2_m3", "author": {"role": "user"}, "content": {"parts": ["Msg 3"]}}}
                }
            }
        ]
        body = json.dumps(export_payload).encode('utf-8')
        req_imp = urllib.request.Request(self._url("/api/import"), data=body, headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req_imp) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            self.assertEqual(data['status'], 'success')

        # Test sort_by=messages&order=desc -> sort_conv_2 first (3 msgs), sort_conv_1 second (1 msg)
        req_msg_desc = urllib.request.Request(self._url("/api/conversations?sort_by=messages&order=desc"))
        with urllib.request.urlopen(req_msg_desc) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            self.assertEqual(data['total'], 2)
            self.assertEqual(data['conversations'][0]['id'], "sort_conv_2")
            self.assertEqual(data['conversations'][0]['message_count'], 3)
            self.assertEqual(data['conversations'][1]['id'], "sort_conv_1")
            self.assertEqual(data['conversations'][1]['message_count'], 1)

        # Test sort_by=messages&order=asc -> sort_conv_1 first, sort_conv_2 second
        req_msg_asc = urllib.request.Request(self._url("/api/conversations?sort_by=messages&order=asc"))
        with urllib.request.urlopen(req_msg_asc) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            self.assertEqual(data['conversations'][0]['id'], "sort_conv_1")
            self.assertEqual(data['conversations'][1]['id'], "sort_conv_2")

        # Test sort_by=date&order=desc -> sort_conv_2 (2000), sort_conv_1 (1000)
        req_date_desc = urllib.request.Request(self._url("/api/conversations?sort_by=date&order=desc"))
        with urllib.request.urlopen(req_date_desc) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            self.assertEqual(data['conversations'][0]['id'], "sort_conv_2")
            self.assertEqual(data['conversations'][1]['id'], "sort_conv_1")

    def test_06_api_surrogates_and_shared_messages(self):
        """Test API import and retrieval with lone surrogates and shared message IDs across conversations."""
        export_payload = [
            {
                "id": "surr_conv_1",
                "title": "Quantum \ud835\udc4e Formula",
                "create_time": 3000.0,
                "update_time": 3000.0,
                "current_node": "shared_node_uuid",
                "mapping": {
                    "shared_node_uuid": {
                        "id": "shared_node_uuid",
                        "parent": None,
                        "children": [],
                        "message": {
                            "id": "shared_node_uuid",
                            "author": {"role": "user"},
                            "content": {"parts": ["Quantum state \ud835 in conv 1"]},
                            "metadata": {"nested": {"formula": "lone \ud835 surrogate"}}
                        }
                    }
                }
            },
            {
                "id": "surr_conv_2",
                "title": "Quantum \ud835\udc3a Algorithm",
                "create_time": 4000.0,
                "update_time": 4000.0,
                "current_node": "shared_node_uuid",
                "mapping": {
                    "shared_node_uuid": {
                        "id": "shared_node_uuid",
                        "parent": None,
                        "children": [],
                        "message": {
                            "id": "shared_node_uuid",
                            "author": {"role": "assistant"},
                            "content": {"parts": ["Quantum state \ud835 in conv 2"]},
                            "metadata": {"nested": {"algo": "lone \ud835 surrogate"}}
                        }
                    }
                }
            }
        ]
        body = json.dumps(export_payload, ensure_ascii=False).encode('utf-8', errors='replace')
        req_imp = urllib.request.Request(self._url("/api/import"), data=body, headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req_imp) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            self.assertEqual(data['status'], 'success')
            self.assertEqual(data['imported'], 2)

        # Retrieve conv 1 via GET /api/conversations/surr_conv_1
        with urllib.request.urlopen(self._url("/api/conversations/surr_conv_1")) as resp:
            self.assertEqual(resp.status, 200)
            res_json = json.loads(resp.read().decode('utf-8'))
            c1_data = res_json['conversation']
            self.assertEqual(c1_data['id'], "surr_conv_1")
            self.assertIn("Quantum", c1_data['title'])
            self.assertIn("Quantum state", c1_data['active_branch'][0]['content'])

        # Search via FTS and confirm no cross-contamination
        with urllib.request.urlopen(self._url("/api/search?q=Quantum")) as resp:
            s_data = json.loads(resp.read().decode('utf-8'))
            results = [r for r in s_data['results'] if r['conversation_id'] in ("surr_conv_1", "surr_conv_2")]
            self.assertEqual(len(results), 2)
            c_map = {r['conversation_id']: r['full_content'] for r in results}
            self.assertIn("conv 1", c_map['surr_conv_1'])
            self.assertIn("conv 2", c_map['surr_conv_2'])

if __name__ == '__main__':
    unittest.main()
