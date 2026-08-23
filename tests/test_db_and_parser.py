"""
Comprehensive unit tests for Database, Parser, and Importer modules.
"""

import unittest
import tempfile
import os
import json
import zipfile
import sqlite3

from server.db import Database
from server.parser import parse_openai_conversation, parse_claude_conversation, parse_export_data, detect_format
from server.importer import import_file

class TestParserAndDB(unittest.TestCase):

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.temp_dir.name, "test_convos.db")
        self.db = Database(self.db_path)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_database_initialization(self):
        with self.db.get_connection() as conn:
            tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
            self.assertIn("conversations", tables)
            self.assertIn("messages", tables)
            self.assertIn("messages_fts", tables)

    def test_chatgpt_branching_and_regeneration(self):
        """
        Simulate a conversation DAG with:
        - Root
        - User Prompt 1 (node_u1)
        - Assistant Response 1 (node_a1_v1) and Regenerated Response 1 (node_a1_v2)
        - User Follow-up from v2 (node_u2)
        - Assistant Final Response (node_a2)
        """
        raw_chatgpt_conv = {
            "id": "conv_tree_123",
            "title": "Quantum Physics & Python",
            "create_time": 1700000000.0,
            "update_time": 1700001000.0,
            "current_node": "node_a2",
            "mapping": {
                "root_node": {
                    "id": "root_node",
                    "parent": None,
                    "children": ["node_u1"],
                    "message": None
                },
                "node_u1": {
                    "id": "node_u1",
                    "parent": "root_node",
                    "children": ["node_a1_v1", "node_a1_v2"],
                    "message": {
                        "id": "node_u1",
                        "author": {"role": "user"},
                        "content": {"parts": ["Explain quantum entanglement simply."]},
                        "create_time": 1700000010.0,
                        "metadata": {"model_slug": "gpt-4"}
                    }
                },
                "node_a1_v1": {
                    "id": "node_a1_v1",
                    "parent": "node_u1",
                    "children": [],
                    "message": {
                        "id": "node_a1_v1",
                        "author": {"role": "assistant"},
                        "content": {"parts": ["Version 1: It's like two magic coins."]},
                        "create_time": 1700000020.0,
                        "metadata": {"model_slug": "gpt-4"}
                    }
                },
                "node_a1_v2": {
                    "id": "node_a1_v2",
                    "parent": "node_u1",
                    "children": ["node_u2"],
                    "message": {
                        "id": "node_a1_v2",
                        "author": {"role": "assistant"},
                        "content": {"parts": ["Version 2: Spooky action at a distance connecting two quantum particles."]},
                        "create_time": 1700000030.0,
                        "metadata": {"model_slug": "gpt-4"}
                    }
                },
                "node_u2": {
                    "id": "node_u2",
                    "parent": "node_a1_v2",
                    "children": ["node_a2"],
                    "message": {
                        "id": "node_u2",
                        "author": {"role": "user"},
                        "content": {"parts": ["Can you write a Python simulation of Bell states?"]},
                        "create_time": 1700000040.0,
                        "metadata": {"model_slug": "gpt-4"}
                    }
                },
                "node_a2": {
                    "id": "node_a2",
                    "parent": "node_u2",
                    "children": [],
                    "message": {
                        "id": "node_a2",
                        "author": {"role": "assistant"},
                        "content": {"parts": ["```python\nimport numpy as np\n# Bell state |Phi+>\npsi = (np.array([1, 0, 0, 1])) / np.sqrt(2)\n```"]},
                        "create_time": 1700000050.0,
                        "metadata": {"model_slug": "gpt-4"}
                    }
                }
            }
        }

        conv_meta, messages = parse_openai_conversation(raw_chatgpt_conv)
        self.assertEqual(conv_meta['id'], "conv_tree_123")
        self.assertEqual(len(messages), 5)

        self.db.insert_conversation(conv_meta, messages)

        # 1. Fetch default active branch (ending at node_a2)
        conv = self.db.get_conversation("conv_tree_123")
        self.assertIsNotNone(conv)
        active_msgs = conv['active_branch']
        self.assertEqual(len(active_msgs), 4)

        # Check that node_a1_v2 detects its sibling node_a1_v1
        resp_msg = active_msgs[1]
        self.assertEqual(resp_msg['id'], "node_a1_v2")
        self.assertIn("Spooky action", resp_msg['content'])
        self.assertEqual(len(resp_msg['siblings']), 2)
        self.assertEqual(resp_msg['siblings'][0]['id'], "node_a1_v1")
        self.assertEqual(resp_msg['siblings'][1]['id'], "node_a1_v2")

        # 2. Fetch alternative branch by specifying leaf node node_a1_v1
        alt_conv = self.db.get_conversation("conv_tree_123", leaf_node_id="node_a1_v1")
        self.assertIsNotNone(alt_conv)
        alt_active = alt_conv['active_branch']
        self.assertEqual(len(alt_active), 2)
        self.assertEqual(alt_active[1]['id'], "node_a1_v1")
        self.assertIn("magic coins", alt_active[1]['content'])

    def test_multi_version_edited_prompt_branches(self):
        """Test multiple prompt edits branching into 3 sibling prompt versions."""
        raw_conv = {
            "id": "conv_multi_edit",
            "title": "Poem variations",
            "create_time": 1700000000.0,
            "update_time": 1700000050.0,
            "current_node": "resp_v3",
            "mapping": {
                "root": {"id": "root", "parent": None, "children": ["p_v1", "p_v2", "p_v3"], "message": None},
                "p_v1": {
                    "id": "p_v1", "parent": "root", "children": ["resp_v1"],
                    "message": {"id": "p_v1", "author": {"role": "user"}, "content": {"parts": ["Write a haiku about rain."]}, "create_time": 1700000010.0}
                },
                "resp_v1": {
                    "id": "resp_v1", "parent": "p_v1", "children": [],
                    "message": {"id": "resp_v1", "author": {"role": "assistant"}, "content": {"parts": ["Soft rain falling down"]}, "create_time": 1700000015.0}
                },
                "p_v2": {
                    "id": "p_v2", "parent": "root", "children": ["resp_v2"],
                    "message": {"id": "p_v2", "author": {"role": "user"}, "content": {"parts": ["Write a sonnet about the ocean."]}, "create_time": 1700000020.0}
                },
                "resp_v2": {
                    "id": "resp_v2", "parent": "p_v2", "children": [],
                    "message": {"id": "resp_v2", "author": {"role": "assistant"}, "content": {"parts": ["The endless blue"]}, "create_time": 1700000025.0}
                },
                "p_v3": {
                    "id": "p_v3", "parent": "root", "children": ["resp_v3"],
                    "message": {"id": "p_v3", "author": {"role": "user"}, "content": {"parts": ["Write a limerick about coffee."]}, "create_time": 1700000030.0}
                },
                "resp_v3": {
                    "id": "resp_v3", "parent": "p_v3", "children": [],
                    "message": {"id": "resp_v3", "author": {"role": "assistant"}, "content": {"parts": ["There once was a cup so dark"]}, "create_time": 1700000035.0}
                }
            }
        }
        conv_meta, messages = parse_openai_conversation(raw_conv)
        self.db.insert_conversation(conv_meta, messages)

        conv = self.db.get_conversation("conv_multi_edit")
        self.assertEqual(len(conv['active_branch']), 2)
        active_prompt = conv['active_branch'][0]
        self.assertEqual(active_prompt['id'], "p_v3")
        self.assertEqual(len(active_prompt['siblings']), 3)
        self.assertEqual([s['id'] for s in active_prompt['siblings']], ["p_v1", "p_v2", "p_v3"])

        # Switch to branch 1 by intermediate user prompt ID (p_v1)
        conv_b1 = self.db.get_conversation("conv_multi_edit", leaf_node_id="p_v1")
        self.assertEqual(len(conv_b1['active_branch']), 2)
        self.assertEqual(conv_b1['active_branch'][0]['id'], "p_v1")
        self.assertEqual(conv_b1['active_branch'][1]['id'], "resp_v1")
        self.assertIn("haiku", conv_b1['active_branch'][0]['content'])
        self.assertIn("Soft rain", conv_b1['active_branch'][1]['content'])

        # Switch to branch 2 by intermediate user prompt ID (p_v2)
        conv_b2 = self.db.get_conversation("conv_multi_edit", leaf_node_id="p_v2")
        self.assertEqual(len(conv_b2['active_branch']), 2)
        self.assertEqual(conv_b2['active_branch'][0]['id'], "p_v2")
        self.assertEqual(conv_b2['active_branch'][1]['id'], "resp_v2")
        self.assertIn("sonnet", conv_b2['active_branch'][0]['content'])
        self.assertIn("endless blue", conv_b2['active_branch'][1]['content'])

        # Switch back to branch 3 by intermediate user prompt ID (p_v3)
        conv_b3 = self.db.get_conversation("conv_multi_edit", leaf_node_id="p_v3")
        self.assertEqual(len(conv_b3['active_branch']), 2)
        self.assertEqual(conv_b3['active_branch'][0]['id'], "p_v3")
        self.assertEqual(conv_b3['active_branch'][1]['id'], "resp_v3")
        self.assertIn("limerick", conv_b3['active_branch'][0]['content'])
        self.assertIn("coffee", conv_b3['active_branch'][0]['content'])

    def test_deep_multi_turn_branch_navigation(self):
        """Test navigating multi-turn sub-branches when switching at an intermediate edit point."""
        raw_conv = {
            "id": "conv_deep_branch",
            "title": "Story Branching",
            "create_time": 1700000000.0,
            "update_time": 1700000090.0,
            "current_node": "a_turn2_v2",
            "mapping": {
                "root": {"id": "root", "parent": None, "children": ["u_turn1"], "message": None},
                "u_turn1": {
                    "id": "u_turn1", "parent": "root", "children": ["a_turn1"],
                    "message": {"id": "u_turn1", "author": {"role": "user"}, "content": {"parts": ["Once upon a time in a dark forest."]}, "create_time": 1700000010.0}
                },
                "a_turn1": {
                    "id": "a_turn1", "parent": "u_turn1", "children": ["u_turn2_v1", "u_turn2_v2"],
                    "message": {"id": "a_turn1", "author": {"role": "assistant"}, "content": {"parts": ["The forest was dense and misty."]}, "create_time": 1700000020.0}
                },
                # Branch 1 (v1): 2 more turns
                "u_turn2_v1": {
                    "id": "u_turn2_v1", "parent": "a_turn1", "children": ["a_turn2_v1"],
                    "message": {"id": "u_turn2_v1", "author": {"role": "user"}, "content": {"parts": ["During that night,"]}, "create_time": 1700000030.0}
                },
                "a_turn2_v1": {
                    "id": "a_turn2_v1", "parent": "u_turn2_v1", "children": ["u_turn3_v1"],
                    "message": {"id": "a_turn2_v1", "author": {"role": "assistant"}, "content": {"parts": ["A wolf appeared."]}, "create_time": 1700000040.0}
                },
                "u_turn3_v1": {
                    "id": "u_turn3_v1", "parent": "a_turn2_v1", "children": ["a_turn3_v1"],
                    "message": {"id": "u_turn3_v1", "author": {"role": "user"}, "content": {"parts": ["Did it attack?"]}, "create_time": 1700000050.0}
                },
                "a_turn3_v1": {
                    "id": "a_turn3_v1", "parent": "u_turn3_v1", "children": [],
                    "message": {"id": "a_turn3_v1", "author": {"role": "assistant"}, "content": {"parts": ["No, it guided them safely home."]}, "create_time": 1700000060.0}
                },
                # Branch 2 (v2): 1 more turn
                "u_turn2_v2": {
                    "id": "u_turn2_v2", "parent": "a_turn1", "children": ["a_turn2_v2"],
                    "message": {"id": "u_turn2_v2", "author": {"role": "user"}, "content": {"parts": ["During that night, Emily said"]}, "create_time": 1700000070.0}
                },
                "a_turn2_v2": {
                    "id": "a_turn2_v2", "parent": "u_turn2_v2", "children": [],
                    "message": {"id": "a_turn2_v2", "author": {"role": "assistant"}, "content": {"parts": ["Emily said we should set up camp."]}, "create_time": 1700000080.0}
                }
            }
        }
        conv_meta, messages = parse_openai_conversation(raw_conv)
        self.db.insert_conversation(conv_meta, messages)

        # 1. Default load gives Branch 2 (latest): u_turn1 -> a_turn1 -> u_turn2_v2 -> a_turn2_v2 (4 messages)
        conv_default = self.db.get_conversation("conv_deep_branch")
        self.assertEqual(len(conv_default['active_branch']), 4)
        self.assertEqual(conv_default['active_branch'][2]['id'], "u_turn2_v2")
        self.assertEqual(conv_default['active_branch'][3]['id'], "a_turn2_v2")

        # 2. User clicks `< 1 / 2 >` on u_turn2_v2 -> selects u_turn2_v1 ("During that night,")
        # Should resolve down to a_turn3_v1 (the leaf of branch 1) and return all 6 messages!
        conv_v1 = self.db.get_conversation("conv_deep_branch", leaf_node_id="u_turn2_v1")
        self.assertEqual(len(conv_v1['active_branch']), 6)
        self.assertEqual(conv_v1['active_branch'][0]['id'], "u_turn1")
        self.assertEqual(conv_v1['active_branch'][1]['id'], "a_turn1")
        self.assertEqual(conv_v1['active_branch'][2]['id'], "u_turn2_v1")
        self.assertEqual(conv_v1['active_branch'][3]['id'], "a_turn2_v1")
        self.assertEqual(conv_v1['active_branch'][4]['id'], "u_turn3_v1")
        self.assertEqual(conv_v1['active_branch'][5]['id'], "a_turn3_v1")

        # 3. User clicks `> 2 / 2` on u_turn2_v1 -> selects u_turn2_v2 ("During that night, Emily said")
        # Should resolve down to a_turn2_v2 and return all 4 messages of branch 2!
        conv_v2 = self.db.get_conversation("conv_deep_branch", leaf_node_id="u_turn2_v2")
        self.assertEqual(len(conv_v2['active_branch']), 4)
        self.assertEqual(conv_v2['active_branch'][2]['id'], "u_turn2_v2")
        self.assertEqual(conv_v2['active_branch'][3]['id'], "a_turn2_v2")

    def test_fts5_full_text_search(self):
        raw_conv = {
            "id": "conv_search_1",
            "title": "Cooking Recipes",
            "create_time": 1700000000.0,
            "update_time": 1700000000.0,
            "current_node": "m2",
            "mapping": {
                "m1": {
                    "id": "m1", "parent": None, "children": ["m2"],
                    "message": {
                        "id": "m1", "author": {"role": "user"},
                        "content": {"parts": ["How to bake homemade sourdough bread?"]},
                        "create_time": 1700000000.0
                    }
                },
                "m2": {
                    "id": "m2", "parent": "m1", "children": [],
                    "message": {
                        "id": "m2", "author": {"role": "assistant"},
                        "content": {"parts": ["Mix flour, water, and active starter. Let it ferment overnight."]},
                        "create_time": 1700000010.0
                    }
                }
            }
        }
        conv_meta, messages = parse_openai_conversation(raw_conv)
        self.db.insert_conversation(conv_meta, messages)

        results = self.db.search("sourdough starter")
        self.assertTrue(len(results) >= 1)
        self.assertEqual(results[0]['conversation_id'], "conv_search_1")
        self.assertIn("<mark>", results[0]['snippet'])

        # Test that list_conversations finds chats by message content (not just title)
        conv_list, total = self.db.list_conversations(query="sourdough")
        self.assertEqual(total, 1)
        self.assertEqual(conv_list[0]['id'], "conv_search_1")
        self.assertIsNotNone(conv_list[0].get('search_snippet'))
        self.assertIn("<mark>", conv_list[0]['search_snippet'])

    def test_deletion_cascade(self):
        raw_conv = {
            "id": "conv_del_1",
            "title": "To Delete",
            "create_time": 1700000000.0,
            "update_time": 1700000000.0,
            "current_node": "dm1",
            "mapping": {
                "dm1": {
                    "id": "dm1", "parent": None, "children": [],
                    "message": {
                        "id": "dm1", "author": {"role": "user"},
                        "content": {"parts": ["Message to be deleted"]},
                        "create_time": 1700000000.0
                    }
                }
            }
        }
        meta, msgs = parse_openai_conversation(raw_conv)
        self.db.insert_conversation(meta, msgs)

        self.assertIsNotNone(self.db.get_conversation("conv_del_1"))
        self.assertTrue(self.db.delete_conversation("conv_del_1"))
        self.assertIsNone(self.db.get_conversation("conv_del_1"))
        # Verify messages and FTS entries were cleaned up
        with self.db.get_connection() as conn:
            msg_count = conn.execute("SELECT COUNT(*) FROM messages WHERE conversation_id = 'conv_del_1'").fetchone()[0]
            fts_count = conn.execute("SELECT COUNT(*) FROM messages_fts WHERE conversation_id = 'conv_del_1'").fetchone()[0]
            self.assertEqual(msg_count, 0)
            self.assertEqual(fts_count, 0)

    def test_claude_parser(self):
        raw_claude = {
            "uuid": "claude_conv_1",
            "name": "Anthropic Chat",
            "created_at_ts": 1700000000,
            "chat_messages": [
                {"uuid": "cm1", "sender": "human", "text": "Hello Claude!"},
                {"uuid": "cm2", "sender": "assistant", "text": "Hello! How can I assist you today?"}
            ]
        }
        conv_meta, messages = parse_claude_conversation(raw_claude)
        self.assertEqual(conv_meta['format'], 'claude')
        self.assertEqual(len(messages), 2)
        self.assertEqual(messages[0]['role'], 'user')
        self.assertEqual(messages[1]['role'], 'assistant')

    def test_importer_with_zip(self):
        export_data = [{
            "id": "zip_conv_1",
            "title": "Imported From Zip",
            "create_time": 1700000000.0,
            "current_node": "zm1",
            "mapping": {
                "zm1": {
                    "id": "zm1", "parent": None, "children": [],
                    "message": {
                        "id": "zm1", "author": {"role": "user"},
                        "content": {"parts": ["Testing ZIP import stream"]},
                        "create_time": 1700000000.0
                    }
                }
            }
        }]
        zip_path = os.path.join(self.temp_dir.name, "export.zip")
        with zipfile.ZipFile(zip_path, 'w') as z:
            z.writestr("conversations.json", json.dumps(export_data))

        res = import_file(zip_path, self.db_path)
        self.assertEqual(res['status'], 'success')
        self.assertEqual(res['imported_conversations'], 1)

        convs, total = self.db.list_conversations()
        self.assertEqual(total, 1)
        self.assertEqual(convs[0]['title'], "Imported From Zip")

    def test_list_conversations_sorting_and_message_count(self):
        # Create 3 conversations with varying message counts and timestamps
        # Conv A: 1 message, timestamp 1000
        conv_a = {
            "id": "conv_a", "title": "Alpha Conv",
            "created_at": 1000.0, "updated_at": 1000.0,
            "current_node": "ma1", "format": "openai"
        }
        msgs_a = [{"id": "ma1", "role": "user", "content": "Single msg", "is_hidden": False}]
        self.db.insert_conversation(conv_a, msgs_a)

        # Conv B: 4 messages, timestamp 3000
        conv_b = {
            "id": "conv_b", "title": "Beta Conv",
            "created_at": 3000.0, "updated_at": 3000.0,
            "current_node": "mb4", "format": "openai"
        }
        msgs_b = [
            {"id": f"mb{i}", "role": "user" if i % 2 == 1 else "assistant", "content": f"msg {i}", "is_hidden": False}
            for i in range(1, 5)
        ]
        self.db.insert_conversation(conv_b, msgs_b)

        # Conv C: 2 messages, timestamp 2000
        conv_c = {
            "id": "conv_c", "title": "Gamma Conv",
            "created_at": 2000.0, "updated_at": 2000.0,
            "current_node": "mc2", "format": "openai"
        }
        msgs_c = [
            {"id": "mc1", "role": "user", "content": "msg 1", "is_hidden": False},
            {"id": "mc2", "role": "assistant", "content": "msg 2", "is_hidden": False}
        ]
        self.db.insert_conversation(conv_c, msgs_c)

        # Verify message_count field
        convs, total = self.db.list_conversations()
        self.assertEqual(total, 3)
        counts_by_id = {c['id']: c['message_count'] for c in convs}
        self.assertEqual(counts_by_id['conv_a'], 1)
        self.assertEqual(counts_by_id['conv_b'], 4)
        self.assertEqual(counts_by_id['conv_c'], 2)

        # Sort by date DESC: B, C, A
        date_desc, _ = self.db.list_conversations(sort_by='date', sort_order='desc')
        self.assertEqual([c['id'] for c in date_desc], ['conv_b', 'conv_c', 'conv_a'])

        # Sort by date ASC: A, C, B
        date_asc, _ = self.db.list_conversations(sort_by='date', sort_order='asc')
        self.assertEqual([c['id'] for c in date_asc], ['conv_a', 'conv_c', 'conv_b'])

        # Sort by messages DESC: B (4), C (2), A (1)
        msgs_desc, _ = self.db.list_conversations(sort_by='messages', sort_order='desc')
        self.assertEqual([c['id'] for c in msgs_desc], ['conv_b', 'conv_c', 'conv_a'])

        # Sort by messages ASC: A (1), C (2), B (4)
        msgs_asc, _ = self.db.list_conversations(sort_by='messages', sort_order='asc')
        self.assertEqual([c['id'] for c in msgs_asc], ['conv_a', 'conv_c', 'conv_b'])

    def test_active_branch_message_count_with_regenerations_and_empty_nodes(self):
        """Verify that conversations with regenerations (multiple versions) and empty thought nodes report active count in list_conversations."""
        from server.parser import parse_openai_conversation

        # Raw conversation with 1 user prompt, 2 empty thought nodes, and 2 regenerated assistant responses (Total 5 DAG nodes, active branch = 2)
        raw_conv = {
            "id": "conv_branch_test",
            "title": "Branch Count Test",
            "create_time": 1700000000.0,
            "update_time": 1700000050.0,
            "current_node": "resp_v2",
            "mapping": {
                "root": {"id": "root", "parent": None, "children": ["u1"], "message": None},
                "u1": {
                    "id": "u1", "parent": "root", "children": ["resp_v1", "empty_thought_1"],
                    "message": {"id": "u1", "author": {"role": "user"}, "content": {"parts": ["Explain quantum mechanics"]}, "create_time": 1700000010.0}
                },
                "resp_v1": {
                    "id": "resp_v1", "parent": "u1", "children": [],
                    "message": {"id": "resp_v1", "author": {"role": "assistant"}, "content": {"parts": ["Version 1 answer"]}, "create_time": 1700000020.0}
                },
                "empty_thought_1": {
                    "id": "empty_thought_1", "parent": "u1", "children": ["resp_v2"],
                    "message": {"id": "empty_thought_1", "author": {"role": "assistant"}, "content": {"parts": [""]}, "create_time": 1700000025.0}
                },
                "resp_v2": {
                    "id": "resp_v2", "parent": "empty_thought_1", "children": [],
                    "message": {"id": "resp_v2", "author": {"role": "assistant"}, "content": {"parts": ["Version 2 answer"]}, "create_time": 1700000030.0}
                }
            }
        }

        conv_meta, messages = parse_openai_conversation(raw_conv)
        self.assertEqual(conv_meta['message_count'], 2)  # Active branch has only u1 and resp_v2
        self.db.insert_conversation(conv_meta, messages)

        # In list_conversations, message_count must be 2, matching active_branch
        convs, _ = self.db.list_conversations()
        conv_found = next(c for c in convs if c['id'] == 'conv_branch_test')
        self.assertEqual(conv_found['message_count'], 2)

        # In get_conversation, active_branch length must also be 2
        full_conv = self.db.get_conversation('conv_branch_test')
        self.assertEqual(len(full_conv['active_branch']), 2)
        self.assertEqual(full_conv['active_branch'][0]['id'], 'u1')
        self.assertEqual(full_conv['active_branch'][1]['id'], 'resp_v2')

    def test_cross_conversation_shared_message_ids(self):
        """Verify that identical message IDs across different conversations can coexist without search corruption."""
        conv1 = {"id": "c1", "title": "Conv 1", "created_at": 1000.0, "updated_at": 1000.0}
        msgs1 = [{"id": "shared_mid_1", "role": "user", "content": "Quantum physics topic in C1"}]
        self.db.insert_conversation(conv1, msgs1)

        conv2 = {"id": "c2", "title": "Conv 2", "created_at": 2000.0, "updated_at": 2000.0}
        msgs2 = [{"id": "shared_mid_1", "role": "user", "content": "Quantum algorithms topic in C2"}]
        self.db.insert_conversation(conv2, msgs2)

        # Both conversations should exist with their own messages
        c1_data = self.db.get_conversation("c1")
        c2_data = self.db.get_conversation("c2")
        self.assertIsNotNone(c1_data)
        self.assertIsNotNone(c2_data)
        self.assertEqual(c1_data['active_branch'][0]['content'], "Quantum physics topic in C1")
        self.assertEqual(c2_data['active_branch'][0]['content'], "Quantum algorithms topic in C2")

        # FTS search must return exactly 2 distinct results without Cartesian multiplication
        search_results = self.db.search("Quantum")
        self.assertEqual(len(search_results), 2)
        r_map = {r['conversation_id']: r['full_content'] for r in search_results}
        self.assertEqual(r_map['c1'], "Quantum physics topic in C1")
        self.assertEqual(r_map['c2'], "Quantum algorithms topic in C2")

    def test_surrogate_character_sanitization(self):
        """Verify that strings and nested metadata containing lone/unpaired UTF-16 surrogates are cleanly sanitized."""
        conv = {
            "id": "c_surrogate",
            "title": "Math \ud835\udc4e with lone surrogate \ud835",
            "created_at": 1000.0,
            "updated_at": 1000.0,
            "metadata": {
                "formula": "E = \ud835\udc4e",
                "nested": {
                    "lone": "surrogate \ud835 inside dict",
                    "list": ["item \ud835"]
                }
            }
        }
        msgs = [{
            "id": "m_surrogate",
            "role": "assistant",
            "content": "Equation: \ud835 and math \ud835\udc3a",
            "metadata": {"param": "val \ud835"}
        }]
        # Should insert without UnicodeEncodeError
        self.db.insert_conversation(conv, msgs)
        fetched = self.db.get_conversation("c_surrogate")
        self.assertIsNotNone(fetched)
        self.assertIn("Math", fetched['title'])
        self.assertIn("Equation", fetched['active_branch'][0]['content'])
        # Assert nested metadata is preserved and encodable
        self.assertIn("formula", fetched['metadata'])
        self.assertIn("nested", fetched['metadata'])

    def test_legacy_schema_automatic_migration(self):
        """Verify that opening an existing SQLite database with legacy single-PK schema automatically migrates."""
        import tempfile, sqlite3
        temp_dir = tempfile.mkdtemp()
        db_file = os.path.join(temp_dir, 'legacy_test.db')
        try:
            # Create a legacy database
            conn = sqlite3.connect(db_file)
            conn.execute("PRAGMA foreign_keys = ON")
            conn.execute("""
            CREATE TABLE conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                current_node TEXT,
                format TEXT DEFAULT 'openai',
                model_slug TEXT,
                metadata_json TEXT
            );
            """)
            conn.execute("""
            CREATE TABLE messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                parent_id TEXT,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at REAL,
                model_slug TEXT,
                status TEXT,
                is_hidden BOOLEAN DEFAULT 0,
                sibling_index INTEGER DEFAULT 0,
                sibling_count INTEGER DEFAULT 1,
                children_json TEXT DEFAULT '[]',
                metadata_json TEXT
            );
            """)
            conn.execute("""
            CREATE VIRTUAL TABLE messages_fts USING fts5(
                content,
                conversation_id UNINDEXED,
                message_id UNINDEXED,
                role UNINDEXED,
                tokenize = 'unicode61'
            );
            """)
            conn.execute("""
            CREATE TRIGGER trg_messages_ai AFTER INSERT ON messages BEGIN
                INSERT INTO messages_fts(content, conversation_id, message_id, role)
                VALUES (new.content, new.conversation_id, new.id, new.role);
            END;
            """)
            conn.execute("""
            CREATE TRIGGER trg_messages_ad AFTER DELETE ON messages BEGIN
                DELETE FROM messages_fts WHERE message_id = old.id;
            END;
            """)
            conn.execute("INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('legacy_c1', 'Legacy Chat', 100, 100)")
            conn.execute("INSERT INTO messages (id, conversation_id, role, content) VALUES ('shared_m_uuid', 'legacy_c1', 'user', 'Legacy content')")
            conn.commit()
            conn.close()

            # Now open with Database class - should auto-migrate
            db = Database(db_file)
            migrated_conn = db.get_connection()
            table_info = migrated_conn.execute("PRAGMA table_info(messages)").fetchall()
            pks = [row for row in table_info if row[5] > 0]
            self.assertEqual(len(pks), 2, "Messages table must have composite PK (conversation_id, id)")
            migrated_conn.close()

            # Insert another conversation with identical message ID
            conv2 = {"id": "legacy_c2", "title": "Second Chat", "created_at": 200, "updated_at": 200}
            msgs2 = [{"id": "shared_m_uuid", "role": "assistant", "content": "Second chat content"}]
            db.insert_conversation(conv2, msgs2)

            # Assert both exist
            c1 = db.get_conversation("legacy_c1")
            c2 = db.get_conversation("legacy_c2")
            self.assertIsNotNone(c1)
            self.assertIsNotNone(c2)
            self.assertEqual(c1['active_branch'][0]['content'], "Legacy content")
            self.assertEqual(c2['active_branch'][0]['content'], "Second chat content")
        finally:
            if os.path.exists(db_file):
                os.remove(db_file)

    def test_manifest_import_with_single_conversations_json(self):
        """Verify that dropping export_manifest.json in a folder with single conversations.json imports properly."""
        export_dir = os.path.join(self.temp_dir.name, "single_export_dir")
        os.makedirs(export_dir, exist_ok=True)

        manifest_path = os.path.join(export_dir, "export_manifest.json")
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump({"schema_version": "1.0", "user_id": "test_user"}, f)

        conv_path = os.path.join(export_dir, "conversations.json")
        with open(conv_path, "w", encoding="utf-8") as f:
            json.dump([{
                "id": "manifest_conv_1",
                "title": "Manifest Import Test",
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
                            "content": {"parts": ["Testing manifest import logic"]},
                            "create_time": 1700000000.0
                        }
                    }
                }
            }], f)

        res = import_file(manifest_path, db_path=self.db_path)
        self.assertEqual(res["status"], "success")
        self.assertEqual(res["imported_conversations"], 1)
        conv = self.db.get_conversation("manifest_conv_1")
        self.assertIsNotNone(conv)
        self.assertEqual(conv["title"], "Manifest Import Test")

    def test_fts_search_query_optimization(self):
        """Verify that list_conversations correctly matches content and title through FTS index."""
        raw_conv = {
            "id": "fts_test_conv",
            "title": "Database Optimization Guide",
            "create_time": 1700000000.0,
            "update_time": 1700000100.0,
            "current_node": "m2",
            "mapping": {
                "m1": {
                    "id": "m1",
                    "parent": None,
                    "children": ["m2"],
                    "message": {
                        "id": "m1",
                        "author": {"role": "user"},
                        "content": {"parts": ["What is indexing in SQLite?"]},
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
                        "content": {"parts": ["FTS5 provides fast inverted index full-text search capability."]},
                        "create_time": 1700000010.0
                    }
                }
            }
        }
        pairs = parse_export_data([raw_conv])
        self.db.insert_conversations_batch(pairs)

        # 1. Search by title keyword
        res1, count1 = self.db.list_conversations(query="Optimization")
        self.assertEqual(count1, 1)
        self.assertEqual(res1[0]["id"], "fts_test_conv")

        # 2. Search by message content keyword (FTS5)
        res2, count2 = self.db.list_conversations(query="inverted")
        self.assertEqual(count2, 1)
        self.assertEqual(res2[0]["id"], "fts_test_conv")
        self.assertIn("search_snippet", res2[0])
        self.assertIn("<mark>", res2[0]["search_snippet"])

        # 3. Search with non-matching query
        res3, count3 = self.db.list_conversations(query="nonexistentkeywordxyz")
        self.assertEqual(count3, 0)
        self.assertEqual(len(res3), 0)

    def test_starred_status_on_conflict_update(self):
        """Verify that re-importing a starred conversation updates is_starred properly."""
        conv_initial = {
            "id": "star_conv_1",
            "title": "Initial Star Test",
            "created_at": 1000.0,
            "updated_at": 1000.0,
            "is_starred": 0
        }
        msgs = [{"id": "m_init", "role": "user", "content": "Hello"}]
        self.db.insert_conversation(conv_initial, msgs)

        c1 = self.db.get_conversation("star_conv_1")
        self.assertFalse(c1["is_starred"])

        # Re-import with is_starred = 1
        conv_updated = {
            "id": "star_conv_1",
            "title": "Updated Star Test",
            "created_at": 1000.0,
            "updated_at": 1050.0,
            "is_starred": 1
        }
        self.db.insert_conversation(conv_updated, msgs)
        c2 = self.db.get_conversation("star_conv_1")
        self.assertTrue(c2["is_starred"])

    def test_detect_format_with_empty_initial_conversation(self):
        """Verify format detection works when first conversation in list has empty messages array."""
        empty_claude = [{"uuid": "c-1", "name": "Empty Claude", "chat_messages": []}]
        self.assertEqual(detect_format(empty_claude), "claude")

        empty_normalized = [{"id": "n-1", "messages": [], "format": "normalized"}]
        self.assertEqual(detect_format(empty_normalized), "normalized")

    def test_non_alphanumeric_search_fallback(self):
        """Verify that searching for symbols or non-alphanumeric queries falls back to LIKE matching."""
        raw_conv = {
            "id": "symbol_conv_1",
            "title": "C++ Template Metaprogramming",
            "created_at": 1000.0,
            "updated_at": 1000.0,
            "current_node": "m_sym",
            "mapping": {
                "m_sym": {
                    "id": "m_sym",
                    "parent": None,
                    "children": [],
                    "message": {
                        "id": "m_sym",
                        "author": {"role": "assistant"},
                        "content": {"parts": ["Specialization with std::vector<int> and ++count operator"]},
                        "create_time": 1000.0
                    }
                }
            }
        }
        pairs = parse_export_data([raw_conv])
        self.db.insert_conversations_batch(pairs)

        # Search for non-alphanumeric token '++'
        results = self.db.search("++")
        self.assertTrue(len(results) >= 1)
        self.assertEqual(results[0]["conversation_id"], "symbol_conv_1")

if __name__ == '__main__':
    unittest.main()
