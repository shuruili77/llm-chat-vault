"""
Unit and integration tests for Image & Attachment handling in LLM Chat Vault.
Tests extraction, indexing, parser resolution, static serving, path-traversal security, and fallback display.
"""

import unittest
import os
import tempfile
import shutil
import json
import zipfile
import urllib.request
import urllib.parse
import threading
import time

from server.db import Database, get_default_attachments_dir
from server.parser import (
    parse_openai_conversation,
    parse_export_data,
    resolve_media,
    is_image_file
)
from server.importer import (
    extract_media_from_zip,
    extract_media_from_directory,
    import_file
)
from server.app import ApiRequestHandler, run_server

class TestImageAttachments(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp(prefix="test_llm_attachments_")
        self.db_path = os.path.join(self.temp_dir, "test.db")
        self.attachments_dir = os.path.join(self.temp_dir, "attachments")
        os.makedirs(self.attachments_dir, exist_ok=True)
        self.db = Database(self.db_path)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_is_image_file(self):
        self.assertTrue(is_image_file("photo.png"))
        self.assertTrue(is_image_file("photo.JPG"))
        self.assertTrue(is_image_file("render.webp"))
        self.assertTrue(is_image_file("graphic.jfif"))
        self.assertTrue(is_image_file("icon.svg"))
        self.assertFalse(is_image_file("document.pdf"))
        self.assertFalse(is_image_file("audio.wav"))
        self.assertFalse(is_image_file("data.json"))

    def test_resolve_media_matching_strategies(self):
        media_index = {
            "file-00jYTMg2M5kql4ncOVocsDyu-image.png": "file-00jYTMg2M5kql4ncOVocsDyu-image.png",
            "file-00jYTMg2M5kql4ncOVocsDyu": "file-00jYTMg2M5kql4ncOVocsDyu-image.png",
            "84ac99c5-bbc4-4edf-adad-3d99b8ff1ed7": "dalle-generations/file-84ac99c5.webp",
            "my_uploaded_file.jpeg": "my_uploaded_file.jpeg",
            "file_1234567890abcdef": "file-1234567890abcdef.png",
        }

        # 1. Exact ID
        res = resolve_media("file-00jYTMg2M5kql4ncOVocsDyu", media_index=media_index)
        self.assertEqual(res, "file-00jYTMg2M5kql4ncOVocsDyu-image.png")

        # 2. Underscore vs hyphen conversion
        res2 = resolve_media("file_00jYTMg2M5kql4ncOVocsDyu", media_index=media_index)
        self.assertEqual(res2, "file-00jYTMg2M5kql4ncOVocsDyu-image.png")

        # 3. DALL-E gen_id lookup
        res3 = resolve_media("unknown_pointer", gen_id="84ac99c5-bbc4-4edf-adad-3d99b8ff1ed7", media_index=media_index)
        self.assertEqual(res3, "dalle-generations/file-84ac99c5.webp")

        # 4. Attachment filename lookup
        res4 = resolve_media("file_missing_id", aname="my_uploaded_file.jpeg", media_index=media_index)
        self.assertEqual(res4, "my_uploaded_file.jpeg")

        # 5. Missing item returns None
        res5 = resolve_media("completely_unknown_id", media_index=media_index)
        self.assertIsNone(res5)

    def test_parse_openai_with_media_index(self):
        sample_openai_conv = {
            "id": "conv_with_images",
            "title": "Multimodal Chat",
            "create_time": 1700000000.0,
            "update_time": 1700000100.0,
            "current_node": "node_assistant_1",
            "mapping": {
                "node_root": {
                    "id": "node_root",
                    "parent": None,
                    "children": ["node_user_1"],
                    "message": None
                },
                "node_user_1": {
                    "id": "node_user_1",
                    "parent": "node_root",
                    "children": ["node_assistant_1"],
                    "message": {
                        "id": "node_user_1",
                        "author": {"role": "user"},
                        "create_time": 1700000010.0,
                        "content": {
                            "content_type": "multimodal_text",
                            "parts": [
                                "Here is my sketch:",
                                {
                                    "content_type": "image_asset_pointer",
                                    "asset_pointer": "file-service://file-sketch12345",
                                    "size_bytes": 1024
                                },
                                {
                                    "content_type": "image_asset_pointer",
                                    "asset_pointer": "sediment://file_missing99999",
                                    "size_bytes": 2048
                                }
                            ]
                        },
                        "metadata": {
                            "attachments": [
                                {
                                    "id": "file-sketch12345",
                                    "name": "my_drawing.png"
                                },
                                {
                                    "id": "file_missing99999",
                                    "name": "unexported_photo.jpeg"
                                }
                            ]
                        }
                    }
                },
                "node_assistant_1": {
                    "id": "node_assistant_1",
                    "parent": "node_user_1",
                    "children": [],
                    "message": {
                        "id": "node_assistant_1",
                        "author": {"role": "assistant"},
                        "create_time": 1700000050.0,
                        "content": {
                            "content_type": "multimodal_text",
                            "parts": [
                                "I have generated this artwork for you:",
                                {
                                    "content_type": "image_asset_pointer",
                                    "asset_pointer": "sediment://file_generated_abc",
                                    "metadata": {
                                        "dalle": {
                                            "gen_id": "gen_uuid_777"
                                        }
                                    }
                                }
                            ]
                        },
                        "metadata": {
                            "model_slug": "gpt-4o"
                        }
                    }
                }
            }
        }

        media_index = {
            "file-sketch12345": "file-sketch12345-my_drawing.png",
            "gen_uuid_777": "dalle-generations/file-artwork.webp"
        }

        meta, msgs = parse_openai_conversation(sample_openai_conv, media_index=media_index)
        self.assertEqual(meta["id"], "conv_with_images")
        self.assertEqual(len(msgs), 2)

        user_msg = next(m for m in msgs if m["role"] == "user")
        self.assertIn("Here is my sketch:", user_msg["content"])
        self.assertIn("![my_drawing.png](/api/attachments/file-sketch12345-my_drawing.png)", user_msg["content"])
        self.assertIn("[Attachment: unexported_photo.jpeg (not found in export)]", user_msg["content"])

        assistant_msg = next(m for m in msgs if m["role"] == "assistant")
        self.assertIn("I have generated this artwork for you:", assistant_msg["content"])
        self.assertIn("![Image](/api/attachments/dalle-generations/file-artwork.webp)", assistant_msg["content"])

    def test_import_zip_with_images(self):
        # Create a sample export zip with conversations.json and images
        zip_path = os.path.join(self.temp_dir, "sample_export.zip")
        sample_convs = [{
            "id": "conv_zip_1",
            "title": "ZIP Import Test",
            "create_time": 1700000000.0,
            "update_time": 1700000100.0,
            "current_node": "m1",
            "mapping": {
                "m1": {
                    "id": "m1",
                    "parent": None,
                    "children": [],
                    "message": {
                        "id": "m1",
                        "author": {"role": "user"},
                        "create_time": 1700000000.0,
                        "content": {
                            "content_type": "multimodal_text",
                            "parts": [
                                "Photo test",
                                {
                                    "content_type": "image_asset_pointer",
                                    "asset_pointer": "file-service://file-abc111"
                                }
                            ]
                        },
                        "metadata": {
                            "attachments": [{"id": "file-abc111", "name": "sample.png"}]
                        }
                    }
                }
            }
        }]

        with zipfile.ZipFile(zip_path, 'w') as z:
            z.writestr("conversations.json", json.dumps(sample_convs))
            z.writestr("file-abc111-sample.png", b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDRFakeImageBytes")

        res = import_file(zip_path, db_path=self.db_path, attachments_dir=self.attachments_dir)
        self.assertEqual(res["status"], "success")
        self.assertEqual(res["imported_conversations"], 1)

        # Check that file was extracted to attachments dir
        extracted_file = os.path.join(self.attachments_dir, "file-abc111-sample.png")
        self.assertTrue(os.path.exists(extracted_file))

        # Check that conversation in db has resolved image url
        conv = self.db.get_conversation("conv_zip_1")
        self.assertIsNotNone(conv)
        msg = conv["active_branch"][0]
        self.assertIn("![sample.png](/api/attachments/file-abc111-sample.png)", msg["content"])

    def test_import_directory_with_images(self):
        # Create a sample folder with conversations.json and subfolders
        source_dir = os.path.join(self.temp_dir, "source_export_dir")
        dalle_sub = os.path.join(source_dir, "dalle-generations")
        os.makedirs(dalle_sub, exist_ok=True)

        sample_convs = [{
            "id": "conv_dir_1",
            "title": "Directory Import Test",
            "create_time": 1700000000.0,
            "update_time": 1700000100.0,
            "current_node": "m1",
            "mapping": {
                "m1": {
                    "id": "m1",
                    "parent": None,
                    "children": [],
                    "message": {
                        "id": "m1",
                        "author": {"role": "assistant"},
                        "create_time": 1700000000.0,
                        "content": {
                            "content_type": "multimodal_text",
                            "parts": [
                                {
                                    "content_type": "image_asset_pointer",
                                    "asset_pointer": "sediment://file_dalle999",
                                    "metadata": {
                                        "dalle": {"gen_id": "gen_888_uuid"}
                                    }
                                }
                            ]
                        },
                        "metadata": {}
                    }
                }
            }
        }]

        with open(os.path.join(source_dir, "conversations.json"), 'w', encoding='utf-8') as f:
            json.dump(sample_convs, f)
        with open(os.path.join(dalle_sub, "file-dalle999-gen_888_uuid.webp"), 'wb') as f:
            f.write(b"RIFF\x00\x00\x00\x00WEBPFakeWebpBytes")

        res = import_file(source_dir, db_path=self.db_path, attachments_dir=self.attachments_dir)
        self.assertEqual(res["status"], "success")
        self.assertEqual(res["imported_conversations"], 1)

        conv = self.db.get_conversation("conv_dir_1")
        self.assertIsNotNone(conv)
        msg = conv["active_branch"][0]
        self.assertIn("/api/attachments/dalle-generations/file-dalle999-gen_888_uuid.webp", msg["content"])


class TestAttachmentsApiServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp_dir = tempfile.mkdtemp(prefix="test_llm_server_")
        cls.db_path = os.path.join(cls.temp_dir, "test.db")
        cls.attachments_dir = os.path.join(cls.temp_dir, "attachments")
        os.makedirs(cls.attachments_dir, exist_ok=True)

        cls.db = Database(cls.db_path)
        cls.port = 8991

        # Write a test image in attachments
        cls.test_img_path = os.path.join(cls.attachments_dir, "test_pic.png")
        with open(cls.test_img_path, 'wb') as f:
            f.write(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4")

        # Set up handler configuration
        ApiRequestHandler.db = cls.db
        ApiRequestHandler.attachments_dir = cls.attachments_dir

        import socketserver
        import http.server
        class ThreadedServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
            daemon_threads = True
            allow_reuse_address = True

        cls.server = ThreadedServer(("127.0.0.1", cls.port), ApiRequestHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        time.sleep(0.3)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        shutil.rmtree(cls.temp_dir, ignore_errors=True)

    def test_get_attachment_success(self):
        url = f"http://127.0.0.1:{self.port}/api/attachments/test_pic.png"
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.headers.get("Content-Type"), "image/png")
            self.assertIn("immutable", resp.headers.get("Cache-Control", ""))
            data = resp.read()
            self.assertTrue(data.startswith(b"\x89PNG"))

    def test_get_attachment_not_found(self):
        url = f"http://127.0.0.1:{self.port}/api/attachments/non_existent.png"
        req = urllib.request.Request(url)
        try:
            with urllib.request.urlopen(req) as resp:
                self.fail("Expected 404 HTTPError")
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 404)
            body = json.loads(e.read().decode('utf-8'))
            self.assertIn("error", body)

    def test_path_traversal_protection(self):
        # Attempt to access outside the attachments directory
        url = f"http://127.0.0.1:{self.port}/api/attachments/..%2F..%2Ftest.db"
        req = urllib.request.Request(url)
        try:
            with urllib.request.urlopen(req) as resp:
                self.fail("Expected 404 or 400 for path traversal")
        except urllib.error.HTTPError as e:
            self.assertIn(e.code, [400, 404])

if __name__ == '__main__':
    unittest.main()
