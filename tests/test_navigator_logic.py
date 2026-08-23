"""
Unit tests for ChatNavigator turn extraction, plain text cleaning, and mode switching logic.
"""

import unittest
import re

def extract_plain_text(text: str, max_length: int = 120) -> str:
    if not text:
        return ""
    # Strip markdown elements
    clean = re.sub(r'```[\s\S]*?```', ' [Code Block] ', text)
    clean = re.sub(r'`([^`]+)`', r'\1', clean)
    clean = re.sub(r'!\[([^\]]*)\]\([^)]+\)', ' [Image] ', clean)
    clean = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', clean)
    clean = re.sub(r'^#+\s+', '', clean, flags=re.MULTILINE)
    clean = re.sub(r'(\*\*|__)(.*?)\1', r'\2', clean)
    clean = re.sub(r'(\*|_)(.*?)\1', r'\2', clean)
    clean = re.sub(r'^>\s+', '', clean, flags=re.MULTILINE)
    clean = re.sub(r'[\r\n]+', ' ', clean)
    clean = re.sub(r'\s+', ' ', clean).strip()

    if len(clean) > max_length:
        clean = clean[:max_length].strip() + '...'
    return clean

def extract_turns(messages: list) -> list:
    if not messages:
        return []
    turns = []
    current_turn = None
    turn_index = 1

    for idx, msg in enumerate(messages):
        if not msg:
            continue
        role = (msg.get('role') or '').lower()
        raw_content = msg.get('content') or ''

        if role == 'user':
            if current_turn:
                turns.append(current_turn)
            clean_user_text = extract_plain_text(raw_content)
            current_turn = {
                'index': turn_index,
                'user_message_id': msg.get('id') or f"msg-{idx}",
                'element_id': f"msg-turn-{turn_index}",
                'user_text': clean_user_text or '(Empty prompt)',
                'raw_user_text': raw_content,
                'assistant_snippet': '',
                'timestamp': msg.get('timestamp') or msg.get('created_at')
            }
            turn_index += 1
        elif role == 'assistant' and current_turn:
            if not current_turn['assistant_snippet'] and raw_content:
                current_turn['assistant_snippet'] = extract_plain_text(raw_content, 180)

    if current_turn:
        turns.append(current_turn)
    return turns

def determine_mode(turn_count: int, threshold: int = 15, user_preferred_mode: str = None) -> str:
    if user_preferred_mode:
        return user_preferred_mode
    return 'outline' if turn_count >= threshold else 'timeline'

def filter_turns(turns: list, query: str) -> list:
    if not query:
        return turns
    q = query.lower().strip()
    return [
        t for t in turns
        if q in t['user_text'].lower() or (t['assistant_snippet'] and q in t['assistant_snippet'].lower())
    ]


class TestChatNavigatorLogic(unittest.TestCase):

    def test_plain_text_cleaner(self):
        md = "### Header\nThis is **bold** and `code` with [link](https://example.com) and ```python\nprint(1)\n```"
        cleaned = extract_plain_text(md)
        self.assertNotIn("###", cleaned)
        self.assertNotIn("**", cleaned)
        self.assertNotIn("```", cleaned)
        self.assertIn("Header This is bold and code with link and [Code Block]", cleaned)

    def test_turn_extraction_pairs(self):
        messages = [
            {'role': 'system', 'content': 'You are a helpful assistant.'},
            {'role': 'user', 'id': 'u1', 'content': 'Hello, who are you?'},
            {'role': 'assistant', 'id': 'a1', 'content': 'I am Claude.'},
            {'role': 'user', 'id': 'u2', 'content': 'Write a sorting function.'},
            {'role': 'assistant', 'id': 'a2', 'content': '```python\ndef quicksort(arr): ...\n```'}
        ]
        turns = extract_turns(messages)

        self.assertEqual(len(turns), 2)
        self.assertEqual(turns[0]['index'], 1)
        self.assertEqual(turns[0]['user_text'], 'Hello, who are you?')
        self.assertEqual(turns[0]['assistant_snippet'], 'I am Claude.')
        self.assertEqual(turns[1]['index'], 2)
        self.assertEqual(turns[1]['user_text'], 'Write a sorting function.')
        self.assertIn('[Code Block]', turns[1]['assistant_snippet'])

    def test_turn_extraction_consecutive_user_prompts(self):
        messages = [
            {'role': 'user', 'id': 'u1', 'content': 'First query'},
            {'role': 'user', 'id': 'u2', 'content': 'Second follow-up query before reply'},
            {'role': 'assistant', 'id': 'a1', 'content': 'Final answer to both'}
        ]
        turns = extract_turns(messages)
        self.assertEqual(len(turns), 2)
        self.assertEqual(turns[0]['user_text'], 'First query')
        self.assertEqual(turns[0]['assistant_snippet'], '')
        self.assertEqual(turns[1]['user_text'], 'Second follow-up query before reply')
        self.assertEqual(turns[1]['assistant_snippet'], 'Final answer to both')

    def test_adaptive_threshold_mode(self):
        # < 15 turns -> timeline mode
        self.assertEqual(determine_mode(1, 15), 'timeline')
        self.assertEqual(determine_mode(14, 15), 'timeline')

        # >= 15 turns -> outline mode
        self.assertEqual(determine_mode(15, 15), 'outline')
        self.assertEqual(determine_mode(40, 15), 'outline')

        # Manual preference overrides threshold
        self.assertEqual(determine_mode(5, 15, user_preferred_mode='outline'), 'outline')
        self.assertEqual(determine_mode(50, 15, user_preferred_mode='timeline'), 'timeline')
        self.assertEqual(determine_mode(20, 15, user_preferred_mode='collapsed'), 'collapsed')

    def test_filter_turns_search(self):
        turns = [
            {'index': 1, 'user_text': '帮我设定主角的背景故事', 'assistant_snippet': '主角是一名星际领航员...'},
            {'index': 2, 'user_text': '写一段第45章的对话', 'assistant_snippet': '好的，这是第45章草稿...'},
            {'index': 3, 'user_text': '检查一下飞船能源核心的设定', 'assistant_snippet': '能源核心采用反物质反应堆...'}
        ]

        # Search matching user text
        res = filter_turns(turns, '第45章')
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0]['index'], 2)

        # Search matching assistant snippet
        res_ai = filter_turns(turns, '反物质')
        self.assertEqual(len(res_ai), 1)
        self.assertEqual(res_ai[0]['index'], 3)

        # Non-matching
        self.assertEqual(len(filter_turns(turns, '不存在的关键词')), 0)

        # Empty query returns all
        self.assertEqual(len(filter_turns(turns, '')), 3)


if __name__ == '__main__':
    unittest.main()
