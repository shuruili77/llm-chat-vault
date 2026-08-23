"""
Database layer for LLM Conversations Viewer.
Handles SQLite schema, connection management, tree-aware queries, and FTS5 full-text search.
"""

import sqlite3
import os
import json
import uuid
import time
from typing import List, Dict, Any, Optional, Tuple

def get_default_db_path() -> str:
    appdata = os.environ.get('APPDATA')
    if appdata:
        vault_db = os.path.join(appdata, 'llm-chat-vault', 'conversations.db')
        if os.path.exists(vault_db):
            return vault_db
        user_db = os.path.join(appdata, 'llm-conversations-viewer', 'conversations.db')
        if os.path.exists(user_db):
            return user_db
        return vault_db
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "conversations.db")

def get_default_attachments_dir(db_path: Optional[str] = None) -> str:
    env_dir = os.environ.get('ATTACHMENTS_DIR')
    if env_dir:
        return os.path.abspath(env_dir)
    if db_path and db_path != ':memory:':
        return os.path.join(os.path.dirname(os.path.abspath(db_path)), "attachments")
    appdata = os.environ.get('APPDATA')
    if appdata:
        vault_att = os.path.join(appdata, 'llm-chat-vault', 'attachments')
        if os.path.exists(vault_att):
            return vault_att
        user_att = os.path.join(appdata, 'llm-conversations-viewer', 'attachments')
        if os.path.exists(user_att):
            return user_att
        return vault_att
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "attachments")

DEFAULT_DB_PATH = get_default_db_path()
DEFAULT_ATTACHMENTS_DIR = get_default_attachments_dir(DEFAULT_DB_PATH)

SCHEMA_SQL = """
-- Conversations metadata table
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    custom_title TEXT,
    is_starred BOOLEAN DEFAULT 0,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    current_node TEXT,
    format TEXT DEFAULT 'openai',
    model_slug TEXT,
    message_count INTEGER DEFAULT 0,
    metadata_json TEXT
);

-- Messages table preserving full conversation DAG / branch tree
CREATE TABLE IF NOT EXISTS messages (
    id TEXT NOT NULL,
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
    metadata_json TEXT,
    PRIMARY KEY (conversation_id, id)
);

-- Projects metadata table
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE,
    color TEXT DEFAULT '#3b82f6',
    icon TEXT DEFAULT '📁',
    description TEXT DEFAULT '',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);

-- Junction table linking conversations and projects
CREATE TABLE IF NOT EXISTS conversation_projects (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    created_at REAL NOT NULL,
    PRIMARY KEY (conversation_id, project_id)
);

-- Indexes for fast traversal and sidebar listing
CREATE INDEX IF NOT EXISTS idx_messages_conv_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_parent_id ON messages(parent_id);
CREATE INDEX IF NOT EXISTS idx_conv_updated_at ON conversations(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_cp_project_id ON conversation_projects(project_id);
CREATE INDEX IF NOT EXISTS idx_cp_conv_id ON conversation_projects(conversation_id);

-- Full-Text Search virtual table (FTS5)
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    conversation_id UNINDEXED,
    message_id UNINDEXED,
    role UNINDEXED,
    tokenize = 'unicode61'
);

-- Triggers to keep FTS5 synchronized
CREATE TRIGGER IF NOT EXISTS trg_messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(content, conversation_id, message_id, role)
    VALUES (new.content, new.conversation_id, new.id, new.role);
END;

CREATE TRIGGER IF NOT EXISTS trg_messages_ad AFTER DELETE ON messages BEGIN
    DELETE FROM messages_fts WHERE conversation_id = old.conversation_id AND message_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_messages_au AFTER UPDATE ON messages BEGIN
    DELETE FROM messages_fts WHERE conversation_id = old.conversation_id AND message_id = old.id;
    INSERT INTO messages_fts(content, conversation_id, message_id, role)
    VALUES (new.content, new.conversation_id, new.id, new.role);
END;
"""

def _clean_str(val: Any) -> Any:
    """Sanitize surrogate codepoints from strings, dicts, and lists for SQLite & UTF-8 safety."""
    if isinstance(val, str):
        return val.encode('utf-8', errors='replace').decode('utf-8', errors='replace')
    elif isinstance(val, dict):
        return {_clean_str(k): _clean_str(v) for k, v in val.items()}
    elif isinstance(val, list):
        return [_clean_str(item) for item in val]
    elif isinstance(val, tuple):
        return tuple(_clean_str(item) for item in val)
    return val

def _resolve_descendant_leaf_helper(start_node_id: str, all_messages: Dict[str, Dict[str, Any]]) -> str:
    """Traverse downward through children to find deepest descendant leaf node in that branch."""
    curr = start_node_id
    visited = set()
    while curr and curr in all_messages and curr not in visited:
        visited.add(curr)
        node = all_messages[curr]
        children = node.get('children', [])
        if isinstance(children, str):
            try:
                children = json.loads(children)
            except Exception:
                children = []
        valid_children = [cid for cid in children if cid in all_messages and cid not in visited]
        if not valid_children:
            valid_children = [
                mid for mid, m in all_messages.items()
                if m.get('parent_id') == curr and mid not in visited
            ]

        if not valid_children:
            break

        content_children = [
            cid for cid in valid_children
            if not all_messages[cid].get('is_hidden') and bool((all_messages[cid].get('content') or '').strip())
        ]
        candidates = content_children if content_children else valid_children
        curr = max(candidates, key=lambda cid: (all_messages[cid].get('created_at') or 0.0))

    return curr or start_node_id

def calculate_active_message_count(
    current_node: Optional[str],
    messages: List[Dict[str, Any]]
) -> int:
    """Calculate visible message count along active branch for a conversation."""
    if not messages:
        return 0
    msg_dict = {m['id']: m for m in messages if isinstance(m, dict) and 'id' in m}
    if not msg_dict:
        return 0

    # If messages are in a flat list without parent links
    has_any_parent = any(bool(m.get('parent_id')) for m in msg_dict.values())
    if not has_any_parent:
        return len([
            m for m in messages
            if (not m.get('is_hidden') or m.get('role') in ('user', 'assistant')) and bool((m.get('content') or '').strip())
        ])

    target_node = current_node if current_node in msg_dict else None
    if target_node:
        target_node = _resolve_descendant_leaf_helper(target_node, msg_dict)
    else:
        parents = {m['parent_id'] for m in msg_dict.values() if m.get('parent_id')}
        leaves = [mid for mid in msg_dict.keys() if mid not in parents]
        target_node = leaves[-1] if leaves else list(msg_dict.keys())[-1]

    count = 0
    curr = target_node
    visited = set()
    while curr and curr in msg_dict and curr not in visited:
        visited.add(curr)
        m = msg_dict[curr]
        is_user_or_assistant = m.get('role') in ('user', 'assistant')
        has_content = bool((m.get('content') or '').strip())
        if (not m.get('is_hidden') or is_user_or_assistant) and has_content:
            count += 1
        curr = m.get('parent_id')
    return count

class Database:
    def __init__(self, db_path: str = DEFAULT_DB_PATH):
        self.db_path = db_path.strip('"\'') if isinstance(db_path, str) else db_path
        self._mem_conn = None
        if self.db_path == ':memory:':
            self._mem_conn = sqlite3.connect(':memory:')
            self._mem_conn.row_factory = sqlite3.Row
            self._mem_conn.execute("PRAGMA foreign_keys = ON")
        else:
            db_dir = os.path.dirname(os.path.abspath(self.db_path))
            if db_dir:
                os.makedirs(db_dir, exist_ok=True)
        self._init_db()

    def get_connection(self) -> sqlite3.Connection:
        if self._mem_conn:
            return self._mem_conn
        conn = sqlite3.connect(self.db_path, timeout=60.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout = 60000")
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
        return conn

    def _init_db(self):
        conn = self.get_connection()
        conn.executescript(SCHEMA_SQL)
        # Check if conversations table needs message_count, custom_title, or is_starred column
        conv_cols = [row[1] for row in conn.execute("PRAGMA table_info(conversations)").fetchall()]
        if 'custom_title' not in conv_cols:
            conn.execute("ALTER TABLE conversations ADD COLUMN custom_title TEXT")

        if 'is_starred' not in conv_cols:
            conn.execute("ALTER TABLE conversations ADD COLUMN is_starred BOOLEAN DEFAULT 0")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_conv_starred ON conversations(is_starred DESC)")
        else:
            conn.execute("CREATE INDEX IF NOT EXISTS idx_conv_starred ON conversations(is_starred DESC)")

        if 'message_count' not in conv_cols:
            conn.execute("ALTER TABLE conversations ADD COLUMN message_count INTEGER DEFAULT 0")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_conv_message_count ON conversations(message_count DESC)")
            self._migrate_all_message_counts(conn)
        else:
            conn.execute("CREATE INDEX IF NOT EXISTS idx_conv_message_count ON conversations(message_count DESC)")
            null_count = conn.execute("SELECT COUNT(*) FROM conversations WHERE message_count IS NULL").fetchone()[0]
            if null_count > 0:
                self._migrate_all_message_counts(conn)

        # Helpful indices for analytics & sorting performance
        conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_role_model ON messages(role, model_slug)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_conv_created_at ON conversations(created_at)")

        # Check if messages table needs migration to composite primary key (conversation_id, id)
        table_info = conn.execute("PRAGMA table_info(messages)").fetchall()
        pks = [row for row in table_info if row[5] > 0]
        if table_info and len(pks) < 2:
            self._migrate_messages_table(conn)
        if not self._mem_conn:
            conn.commit()
            conn.close()

    def _migrate_all_message_counts(self, conn: sqlite3.Connection):
        """Backfill active branch message_count for all existing conversations."""
        conv_rows = conn.execute("SELECT id, current_node FROM conversations").fetchall()
        msg_rows = conn.execute("SELECT id, conversation_id, parent_id, role, content, is_hidden FROM messages").fetchall()

        conv_msg_map = {}
        for m in msg_rows:
            cid = m['conversation_id']
            if cid not in conv_msg_map:
                conv_msg_map[cid] = {}
            conv_msg_map[cid][m['id']] = dict(m)

        updates = []
        for c in conv_rows:
            cid = c['id']
            c_node = c['current_node']
            msgs = list(conv_msg_map.get(cid, {}).values())
            cnt = calculate_active_message_count(c_node, msgs)
            updates.append((cnt, cid))

        if updates:
            conn.executemany("UPDATE conversations SET message_count = ? WHERE id = ?", updates)

    def _migrate_messages_table(self, conn: sqlite3.Connection):
        """Migrate messages table from single PK to composite PK (conversation_id, id)."""
        conn.execute("PRAGMA foreign_keys = OFF")
        conn.execute("ALTER TABLE messages RENAME TO messages_old")
        conn.execute(
            """
            CREATE TABLE messages (
                id TEXT NOT NULL,
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
                metadata_json TEXT,
                PRIMARY KEY (conversation_id, id)
            )
            """
        )
        conn.execute(
            """
            INSERT OR IGNORE INTO messages (
                id, conversation_id, parent_id, role, content, created_at,
                model_slug, status, is_hidden, sibling_index, sibling_count,
                children_json, metadata_json
            )
            SELECT 
                id, conversation_id, parent_id, role, content, created_at,
                model_slug, status, is_hidden, sibling_index, sibling_count,
                children_json, metadata_json
            FROM messages_old
            """
        )
        conn.execute("DROP TABLE messages_old")
        conn.execute("DROP TRIGGER IF EXISTS trg_messages_ai")
        conn.execute("DROP TRIGGER IF EXISTS trg_messages_ad")
        conn.execute("DROP TRIGGER IF EXISTS trg_messages_au")
        conn.execute(
            """
            CREATE TRIGGER trg_messages_ai AFTER INSERT ON messages BEGIN
                INSERT INTO messages_fts(content, conversation_id, message_id, role)
                VALUES (new.content, new.conversation_id, new.id, new.role);
            END;
            """
        )
        conn.execute(
            """
            CREATE TRIGGER trg_messages_ad AFTER DELETE ON messages BEGIN
                DELETE FROM messages_fts WHERE conversation_id = old.conversation_id AND message_id = old.id;
            END;
            """
        )
        conn.execute(
            """
            CREATE TRIGGER trg_messages_au AFTER UPDATE ON messages BEGIN
                DELETE FROM messages_fts WHERE conversation_id = old.conversation_id AND message_id = old.id;
                INSERT INTO messages_fts(content, conversation_id, message_id, role)
                VALUES (new.content, new.conversation_id, new.id, new.role);
            END;
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_conv_id ON messages(conversation_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_parent_id ON messages(parent_id)")
        conn.execute("PRAGMA foreign_keys = ON")

    def insert_conversation(self, conv: Dict[str, Any], messages: List[Dict[str, Any]]) -> None:
        """Insert or replace a conversation and all its branched messages atomically without losing project assignments."""
        conn = self.get_connection()
        try:
            with conn:
                conv_id = _clean_str(conv['id'])
                # Delete existing messages for this conversation (avoids cascading conversation_projects deletion)
                conn.execute("DELETE FROM messages WHERE conversation_id = ?", (conv_id,))
                
                clean_meta = _clean_str(conv.get('metadata', {}))
                msg_count = conv.get('message_count')
                if msg_count is None:
                    msg_count = calculate_active_message_count(conv.get('current_node'), messages)

                custom_title = _clean_str(conv.get('custom_title')) if conv.get('custom_title') else None
                is_starred = 1 if conv.get('is_starred') else 0
                conn.execute(
                    """
                    INSERT INTO conversations (id, title, custom_title, is_starred, created_at, updated_at, current_node, format, model_slug, message_count, metadata_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        title = excluded.title,
                        custom_title = COALESCE(conversations.custom_title, excluded.custom_title),
                        is_starred = CASE WHEN excluded.is_starred = 1 THEN 1 ELSE conversations.is_starred END,
                        created_at = excluded.created_at,
                        updated_at = excluded.updated_at,
                        current_node = excluded.current_node,
                        format = excluded.format,
                        model_slug = excluded.model_slug,
                        message_count = excluded.message_count,
                        metadata_json = excluded.metadata_json
                    """,
                    (
                        conv_id,
                        _clean_str(conv.get('title', 'Untitled')),
                        custom_title,
                        is_starred,
                        conv.get('created_at', 0.0),
                        conv.get('updated_at', 0.0),
                        _clean_str(conv.get('current_node')),
                        _clean_str(conv.get('format', 'openai')),
                        _clean_str(conv.get('model_slug')),
                        int(msg_count or 0),
                        json.dumps(clean_meta, ensure_ascii=False)
                    )
                )

                for msg in messages:
                    clean_msg_meta = _clean_str(msg.get('metadata', {}))
                    clean_msg_children = _clean_str(msg.get('children', []))
                    conn.execute(
                        """
                        INSERT OR REPLACE INTO messages (
                            id, conversation_id, parent_id, role, content, created_at,
                            model_slug, status, is_hidden, sibling_index, sibling_count,
                            children_json, metadata_json
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            _clean_str(msg['id']),
                            conv_id,
                            _clean_str(msg.get('parent_id')),
                            _clean_str(msg.get('role', 'unknown')),
                            _clean_str(msg.get('content', '')),
                            msg.get('created_at'),
                            _clean_str(msg.get('model_slug')),
                            _clean_str(msg.get('status', 'finished_successfully')),
                            1 if msg.get('is_hidden') else 0,
                            msg.get('sibling_index', 0),
                            msg.get('sibling_count', 1),
                            json.dumps(clean_msg_children, ensure_ascii=False),
                            json.dumps(clean_msg_meta, ensure_ascii=False)
                        )
                    )
        finally:
            if not self._mem_conn:
                conn.close()

    def insert_conversations_batch(self, parsed_pairs: List[Tuple[Dict[str, Any], List[Dict[str, Any]]]]) -> int:
        """Insert multiple conversations and messages within a single fast atomic transaction."""
        conn = self.get_connection()
        total_msgs = 0
        try:
            with conn:
                for conv, messages in parsed_pairs:
                    conv_id = _clean_str(conv['id'])
                    msg_count = conv.get('message_count')
                    if msg_count is None:
                        msg_count = calculate_active_message_count(conv.get('current_node'), messages)

                    conn.execute("DELETE FROM messages WHERE conversation_id = ?", (conv_id,))
                    clean_meta = _clean_str(conv.get('metadata', {}))
                    custom_title = _clean_str(conv.get('custom_title')) if conv.get('custom_title') else None
                    is_starred = 1 if conv.get('is_starred') else 0
                    conn.execute(
                        """
                        INSERT INTO conversations (id, title, custom_title, is_starred, created_at, updated_at, current_node, format, model_slug, message_count, metadata_json)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(id) DO UPDATE SET
                            title = excluded.title,
                            custom_title = COALESCE(conversations.custom_title, excluded.custom_title),
                            is_starred = CASE WHEN excluded.is_starred = 1 THEN 1 ELSE conversations.is_starred END,
                            created_at = excluded.created_at,
                            updated_at = excluded.updated_at,
                            current_node = excluded.current_node,
                            format = excluded.format,
                            model_slug = excluded.model_slug,
                            message_count = excluded.message_count,
                            metadata_json = excluded.metadata_json
                        """,
                        (
                            conv_id,
                            _clean_str(conv.get('title', 'Untitled')),
                            custom_title,
                            is_starred,
                            conv.get('created_at', 0.0),
                            conv.get('updated_at', 0.0),
                            _clean_str(conv.get('current_node')),
                            _clean_str(conv.get('format', 'openai')),
                            _clean_str(conv.get('model_slug')),
                            int(msg_count or 0),
                            json.dumps(clean_meta, ensure_ascii=False)
                        )
                    )
                    for msg in messages:
                        clean_msg_meta = _clean_str(msg.get('metadata', {}))
                        clean_msg_children = _clean_str(msg.get('children', []))
                        conn.execute(
                            """
                            INSERT OR REPLACE INTO messages (
                                id, conversation_id, parent_id, role, content, created_at,
                                model_slug, status, is_hidden, sibling_index, sibling_count,
                                children_json, metadata_json
                            )
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            """,
                            (
                                _clean_str(msg['id']),
                                conv_id,
                                _clean_str(msg.get('parent_id')),
                                _clean_str(msg.get('role', 'unknown')),
                                _clean_str(msg.get('content', '')),
                                msg.get('created_at'),
                                _clean_str(msg.get('model_slug')),
                                _clean_str(msg.get('status', 'finished_successfully')),
                                1 if msg.get('is_hidden') else 0,
                                msg.get('sibling_index', 0),
                                msg.get('sibling_count', 1),
                                json.dumps(clean_msg_children, ensure_ascii=False),
                                json.dumps(clean_msg_meta, ensure_ascii=False)
                            )
                        )
                        total_msgs += 1
        finally:
            if not self._mem_conn:
                conn.close()
        return total_msgs

    def list_conversations(
        self,
        limit: int = 100,
        offset: int = 0,
        query: Optional[str] = None,
        sort_by: str = 'date',
        sort_order: str = 'desc',
        project_id: Optional[str] = None,
        starred: Optional[bool] = None
    ) -> Tuple[List[Dict[str, Any]], int]:
        """List conversations with message count, project tags, optional search filter, project scoping, star filter, sorting, and pagination."""
        conn = self.get_connection()
        try:
            # Validate sort arguments
            sort_by = (sort_by or 'date').lower()
            sort_order = 'ASC' if sort_order and sort_order.lower() == 'asc' else 'DESC'

            if sort_by in ('messages', 'message_count', 'count'):
                order_clause = f"c.message_count {sort_order}, c.updated_at DESC"
            elif sort_by in ('created', 'created_at'):
                order_clause = f"c.created_at {sort_order}"
            elif sort_by in ('title', 'name'):
                order_clause = f"c.title COLLATE NOCASE {sort_order}"
            else:  # default 'date' / 'updated' / 'updated_at'
                order_clause = f"c.updated_at {sort_order}"

            project_filter = ""
            project_params: List[Any] = []
            if project_id and project_id.strip():
                if project_id.strip() == 'starred':
                    project_filter = "AND c.is_starred = 1"
                else:
                    project_filter = "AND c.id IN (SELECT conversation_id FROM conversation_projects WHERE project_id = ?)"
                    project_params = [project_id.strip()]

            if starred is True:
                project_filter += " AND c.is_starred = 1"
            elif starred is False:
                project_filter += " AND c.is_starred = 0"

            if query and query.strip():
                raw_q = query.strip()
                like_pattern = f"%{raw_q}%"
                tokens = raw_q.split()
                safe_tokens = ["".join(c for c in t if c.isalnum() or c in "_-") for t in tokens]
                safe_tokens = [f'"{t}"' for t in safe_tokens if t]
                fts_query = " OR ".join(safe_tokens) if safe_tokens else None

                if fts_query:
                    count_sql = f"""
                        SELECT COUNT(*) FROM conversations c
                        WHERE (c.title LIKE ? 
                           OR (c.custom_title IS NOT NULL AND c.custom_title LIKE ?)
                           OR c.id IN (SELECT conversation_id FROM messages_fts WHERE messages_fts MATCH ?))
                           {project_filter}
                    """
                    try:
                        count_cur = conn.execute(count_sql, (like_pattern, like_pattern, fts_query, *project_params))
                        total = count_cur.fetchone()[0]
                    except Exception:
                        # Fallback if FTS syntax error
                        count_sql = f"""
                            SELECT COUNT(*) FROM conversations c
                            WHERE (c.title LIKE ? 
                               OR (c.custom_title IS NOT NULL AND c.custom_title LIKE ?))
                               {project_filter}
                        """
                        count_cur = conn.execute(count_sql, (like_pattern, like_pattern, *project_params))
                        total = count_cur.fetchone()[0]

                    sql = f"""
                        SELECT 
                            c.id, c.title, c.custom_title, c.is_starred, c.created_at, c.updated_at, c.current_node, c.format, c.model_slug,
                            c.message_count,
                            (
                                SELECT json_group_array(json_object('id', p.id, 'name', p.name, 'color', p.color, 'icon', p.icon))
                                FROM conversation_projects cp
                                JOIN projects p ON p.id = cp.project_id
                                WHERE cp.conversation_id = c.id
                            ) AS projects_json,
                            (
                                SELECT snippet(messages_fts, 0, '<mark>', '</mark>', '...', 12)
                                FROM messages_fts 
                                WHERE messages_fts.conversation_id = c.id
                                  AND messages_fts MATCH ?
                                LIMIT 1
                            ) AS search_snippet
                        FROM conversations c
                        WHERE (c.title LIKE ? 
                           OR (c.custom_title IS NOT NULL AND c.custom_title LIKE ?)
                           OR c.id IN (SELECT conversation_id FROM messages_fts WHERE messages_fts MATCH ?))
                           {project_filter}
                        ORDER BY 
                            CASE WHEN (c.title LIKE ? OR (c.custom_title IS NOT NULL AND c.custom_title LIKE ?)) THEN 0 ELSE 1 END,
                            {order_clause}
                        LIMIT ? OFFSET ?
                    """
                    try:
                        cur = conn.execute(sql, (
                            fts_query,
                            like_pattern, like_pattern, fts_query,
                            *project_params,
                            like_pattern, like_pattern,
                            limit, offset
                        ))
                    except Exception:
                        # Fallback query if FTS expression fails
                        fallback_sql = f"""
                            SELECT 
                                c.id, c.title, c.custom_title, c.is_starred, c.created_at, c.updated_at, c.current_node, c.format, c.model_slug,
                                c.message_count,
                                (
                                    SELECT json_group_array(json_object('id', p.id, 'name', p.name, 'color', p.color, 'icon', p.icon))
                                    FROM conversation_projects cp
                                    JOIN projects p ON p.id = cp.project_id
                                    WHERE cp.conversation_id = c.id
                                ) AS projects_json,
                                NULL AS search_snippet
                            FROM conversations c
                            WHERE (c.title LIKE ? 
                               OR (c.custom_title IS NOT NULL AND c.custom_title LIKE ?))
                               {project_filter}
                            ORDER BY 
                                CASE WHEN (c.title LIKE ? OR (c.custom_title IS NOT NULL AND c.custom_title LIKE ?)) THEN 0 ELSE 1 END,
                                {order_clause}
                            LIMIT ? OFFSET ?
                        """
                        cur = conn.execute(fallback_sql, (
                            like_pattern, like_pattern,
                            *project_params,
                            like_pattern, like_pattern,
                            limit, offset
                        ))
                else:
                    # Non-alphanumeric search query fallback (only title matching)
                    count_sql = f"""
                        SELECT COUNT(*) FROM conversations c
                        WHERE (c.title LIKE ? 
                           OR (c.custom_title IS NOT NULL AND c.custom_title LIKE ?))
                           {project_filter}
                    """
                    count_cur = conn.execute(count_sql, (like_pattern, like_pattern, *project_params))
                    total = count_cur.fetchone()[0]

                    sql = f"""
                        SELECT 
                            c.id, c.title, c.custom_title, c.is_starred, c.created_at, c.updated_at, c.current_node, c.format, c.model_slug,
                            c.message_count,
                            (
                                SELECT json_group_array(json_object('id', p.id, 'name', p.name, 'color', p.color, 'icon', p.icon))
                                FROM conversation_projects cp
                                JOIN projects p ON p.id = cp.project_id
                                WHERE cp.conversation_id = c.id
                            ) AS projects_json,
                            NULL AS search_snippet
                        FROM conversations c
                        WHERE (c.title LIKE ? 
                           OR (c.custom_title IS NOT NULL AND c.custom_title LIKE ?))
                           {project_filter}
                        ORDER BY 
                            CASE WHEN (c.title LIKE ? OR (c.custom_title IS NOT NULL AND c.custom_title LIKE ?)) THEN 0 ELSE 1 END,
                            {order_clause}
                        LIMIT ? OFFSET ?
                    """
                    cur = conn.execute(sql, (
                        like_pattern, like_pattern,
                        *project_params,
                        like_pattern, like_pattern,
                        limit, offset
                    ))
            else:
                count_sql = f"SELECT COUNT(*) FROM conversations c WHERE 1=1 {project_filter}"
                count_cur = conn.execute(count_sql, project_params)
                total = count_cur.fetchone()[0]

                sql = f"""
                    SELECT 
                        c.id, c.title, c.custom_title, c.is_starred, c.created_at, c.updated_at, c.current_node, c.format, c.model_slug,
                        c.message_count,
                        (
                            SELECT json_group_array(json_object('id', p.id, 'name', p.name, 'color', p.color, 'icon', p.icon))
                            FROM conversation_projects cp
                            JOIN projects p ON p.id = cp.project_id
                            WHERE cp.conversation_id = c.id
                        ) AS projects_json
                    FROM conversations c
                    WHERE 1=1 {project_filter}
                    ORDER BY {order_clause}
                    LIMIT ? OFFSET ?
                """
                cur = conn.execute(sql, (*project_params, limit, offset))

            rows = []
            for r in cur.fetchall():
                row_dict = dict(r)
                row_dict['original_title'] = row_dict.get('title', 'Untitled')
                row_dict['is_starred'] = bool(row_dict.get('is_starred', 0))
                if row_dict.get('custom_title'):
                    row_dict['title'] = row_dict['custom_title']
                if row_dict.get('projects_json'):
                    try:
                        raw_projs = json.loads(row_dict['projects_json'])
                        row_dict['projects'] = [p for p in raw_projs if p and p.get('id')]
                    except Exception:
                        row_dict['projects'] = []
                else:
                    row_dict['projects'] = []
                rows.append(row_dict)
            return rows, total
        finally:
            if not self._mem_conn:
                conn.close()

    def get_conversation(self, conv_id: str, leaf_node_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """
        Get full conversation details.
        Returns the conversation metadata, all raw nodes (for branching),
        and the currently active branch messages from root to leaf_node.
        """
        conn = self.get_connection()
        try:
            conv_row = conn.execute("SELECT * FROM conversations WHERE id = ?", (conv_id,)).fetchone()
            if not conv_row:
                return None

            conv_dict = dict(conv_row)
            conv_dict['original_title'] = conv_dict.get('title', 'Untitled')
            conv_dict['is_starred'] = bool(conv_dict.get('is_starred', 0))
            if conv_dict.get('custom_title'):
                conv_dict['title'] = conv_dict['custom_title']
            if conv_dict.get('metadata_json'):
                conv_dict['metadata'] = json.loads(conv_dict['metadata_json'])

            conv_dict['projects'] = self.get_conversation_projects(conv_id)

            msg_rows = conn.execute(
                "SELECT * FROM messages WHERE conversation_id = ?", (conv_id,)
            ).fetchall()

            all_messages = {}
            for r in msg_rows:
                m = dict(r)
                m['children'] = json.loads(m.get('children_json') or '[]')
                m['metadata'] = json.loads(m.get('metadata_json') or '{}')
                all_messages[m['id']] = m

            # Determine target leaf node
            target_node = leaf_node_id or conv_dict.get('current_node')
            if not target_node or target_node not in all_messages:
                target_node = self._find_default_leaf(all_messages)
            else:
                # If target_node is an intermediate node (user prompt or assistant turn),
                # traverse down to its deepest descendant leaf in that branch.
                target_node = self._resolve_descendant_leaf(target_node, all_messages)

            # Trace active branch from target leaf back to root
            active_branch = []
            curr = target_node
            visited = set()
            while curr and curr in all_messages and curr not in visited:
                visited.add(curr)
                node_data = all_messages[curr]
                is_user_or_assistant = node_data.get('role') in ['user', 'assistant']
                has_content = bool((node_data.get('content') or '').strip())
                if (not node_data.get('is_hidden') or is_user_or_assistant) and has_content:
                    # Fetch sibling versions
                    siblings = self._get_sibling_info(node_data, all_messages)
                    node_data_with_siblings = dict(node_data)
                    node_data_with_siblings['siblings'] = siblings
                    if node_data_with_siblings.get('content') is None:
                        node_data_with_siblings['content'] = ''
                    active_branch.insert(0, node_data_with_siblings)
                curr = node_data.get('parent_id')

            conv_dict['active_branch'] = active_branch
            conv_dict['all_messages'] = all_messages
            conv_dict['active_leaf'] = target_node
            return conv_dict
        finally:
            if not self._mem_conn:
                conn.close()

    # =========================================================================
    # Project / Tag Management Methods
    # =========================================================================

    def create_project(
        self,
        name: str,
        color: str = '#3b82f6',
        icon: str = '📁',
        description: str = '',
        project_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """Create a new project classification."""
        conn = self.get_connection()
        pid = project_id or str(uuid.uuid4())
        now = time.time()
        name = _clean_str(name).strip()
        color = _clean_str(color).strip() or '#3b82f6'
        icon = _clean_str(icon).strip() or '📁'
        description = _clean_str(description).strip()
        try:
            with conn:
                conn.execute(
                    """
                    INSERT INTO projects (id, name, color, icon, description, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (pid, name, color, icon, description, now, now)
                )
            return {
                'id': pid,
                'name': name,
                'color': color,
                'icon': icon,
                'description': description,
                'created_at': now,
                'updated_at': now,
                'conversation_count': 0
            }
        finally:
            if not self._mem_conn:
                conn.close()

    def update_project(
        self,
        project_id: str,
        name: Optional[str] = None,
        color: Optional[str] = None,
        icon: Optional[str] = None,
        description: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        """Update an existing project's metadata."""
        conn = self.get_connection()
        now = time.time()
        try:
            with conn:
                existing = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
                if not existing:
                    return None
                new_name = _clean_str(name).strip() if name is not None else existing['name']
                new_color = _clean_str(color).strip() if color is not None else existing['color']
                new_icon = _clean_str(icon).strip() if icon is not None else existing['icon']
                new_desc = _clean_str(description).strip() if description is not None else existing['description']
                conn.execute(
                    """
                    UPDATE projects SET name = ?, color = ?, icon = ?, description = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (new_name, new_color, new_icon, new_desc, now, project_id)
                )
                count = conn.execute(
                    "SELECT COUNT(*) FROM conversation_projects WHERE project_id = ?",
                    (project_id,)
                ).fetchone()[0]
                return {
                    'id': project_id,
                    'name': new_name,
                    'color': new_color,
                    'icon': new_icon,
                    'description': new_desc,
                    'created_at': existing['created_at'],
                    'updated_at': now,
                    'conversation_count': count
                }
        finally:
            if not self._mem_conn:
                conn.close()

    def delete_project(self, project_id: str) -> bool:
        """Delete a project (cascades junction links; never deletes conversations)."""
        conn = self.get_connection()
        try:
            with conn:
                cur = conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
                return cur.rowcount > 0
        finally:
            if not self._mem_conn:
                conn.close()

    def list_projects(self) -> List[Dict[str, Any]]:
        """List all projects along with current conversation counts, sorted by chat count descending."""
        conn = self.get_connection()
        try:
            sql = """
                SELECT 
                    p.id, p.name, p.color, p.icon, p.description, p.created_at, p.updated_at,
                    COUNT(cp.conversation_id) AS conversation_count
                FROM projects p
                LEFT JOIN conversation_projects cp ON cp.project_id = p.id
                GROUP BY p.id
                ORDER BY COUNT(cp.conversation_id) DESC, p.name COLLATE NOCASE ASC
            """
            cur = conn.execute(sql)
            return [dict(r) for r in cur.fetchall()]
        finally:
            if not self._mem_conn:
                conn.close()

    def get_project(self, project_id: str) -> Optional[Dict[str, Any]]:
        """Get details for a single project (including virtual 'starred' tag)."""
        conn = self.get_connection()
        try:
            if project_id == 'starred':
                starred_cnt = conn.execute("SELECT COUNT(*) FROM conversations WHERE is_starred = 1").fetchone()[0]
                return {
                    "id": "starred",
                    "name": "Starred",
                    "color": "#f59e0b",
                    "icon": "⭐",
                    "description": "Favorited conversations",
                    "created_at": 0,
                    "updated_at": 0,
                    "conversation_count": starred_cnt
                }

            sql = """
                SELECT 
                    p.id, p.name, p.color, p.icon, p.description, p.created_at, p.updated_at,
                    COUNT(cp.conversation_id) AS conversation_count
                FROM projects p
                LEFT JOIN conversation_projects cp ON cp.project_id = p.id
                WHERE p.id = ?
                GROUP BY p.id
            """
            row = conn.execute(sql, (project_id,)).fetchone()
            return dict(row) if row else None
        finally:
            if not self._mem_conn:
                conn.close()

    def get_conversation_projects(self, conv_id: str) -> List[Dict[str, Any]]:
        """Get all projects assigned to a given conversation."""
        conn = self.get_connection()
        try:
            sql = """
                SELECT p.id, p.name, p.color, p.icon, p.description
                FROM projects p
                JOIN conversation_projects cp ON cp.project_id = p.id
                WHERE cp.conversation_id = ?
                ORDER BY p.name COLLATE NOCASE ASC
            """
            cur = conn.execute(sql, (conv_id,))
            return [dict(r) for r in cur.fetchall()]
        finally:
            if not self._mem_conn:
                conn.close()

    def set_conversation_projects(self, conv_id: str, project_ids: List[str]) -> List[Dict[str, Any]]:
        """Set or replace project assignments for a single conversation."""
        conn = self.get_connection()
        now = time.time()
        try:
            with conn:
                conn.execute("DELETE FROM conversation_projects WHERE conversation_id = ?", (conv_id,))
                for pid in project_ids:
                    if pid:
                        conn.execute(
                            "INSERT OR IGNORE INTO conversation_projects (conversation_id, project_id, created_at) VALUES (?, ?, ?)",
                            (conv_id, pid, now)
                        )
            return self.get_conversation_projects(conv_id)
        finally:
            if not self._mem_conn:
                conn.close()

    def batch_assign_projects(
        self,
        conv_ids: List[str],
        add_project_ids: List[str] = [],
        remove_project_ids: List[str] = []
    ) -> Dict[str, Any]:
        """Bulk add or remove project assignments for multiple conversations."""
        conn = self.get_connection()
        now = time.time()
        try:
            with conn:
                for cid in conv_ids:
                    for rpid in remove_project_ids:
                        if rpid:
                            conn.execute(
                                "DELETE FROM conversation_projects WHERE conversation_id = ? AND project_id = ?",
                                (cid, rpid)
                            )
                    for apid in add_project_ids:
                        if apid:
                            conn.execute(
                                "INSERT OR IGNORE INTO conversation_projects (conversation_id, project_id, created_at) VALUES (?, ?, ?)",
                                (cid, apid, now)
                            )
            return {"status": "success", "modified_conversations": len(conv_ids)}
        finally:
            if not self._mem_conn:
                conn.close()


    def _resolve_descendant_leaf(self, start_node_id: str, all_messages: Dict[str, Dict[str, Any]]) -> str:
        """
        Given any node in the conversation DAG (e.g. an intermediate user prompt or assistant response),
        traverse downward through its children to find the deepest descendant leaf node in that branch.
        If a node has multiple children branches further down, picks the newest child (highest created_at).
        """
        curr = start_node_id
        visited = set()
        while curr and curr in all_messages and curr not in visited:
            visited.add(curr)
            node = all_messages[curr]
            children = node.get('children', [])
            valid_children = [cid for cid in children if cid in all_messages and cid not in visited]
            if not valid_children:
                # Fallback: check if any message in all_messages has parent_id == curr
                valid_children = [
                    mid for mid, m in all_messages.items()
                    if m.get('parent_id') == curr and mid not in visited
                ]

            if not valid_children:
                break

            # Prioritize non-hidden children with content
            content_children = [
                cid for cid in valid_children
                if not all_messages[cid].get('is_hidden') and all_messages[cid].get('content')
            ]
            candidates = content_children if content_children else valid_children

            # Pick child with latest created_at (or last in list as tie-breaker)
            curr = max(candidates, key=lambda cid: (all_messages[cid].get('created_at') or 0.0))

        return curr or start_node_id

    def _find_default_leaf(self, all_messages: Dict[str, Dict[str, Any]]) -> Optional[str]:
        if not all_messages:
            return None
        leaf_candidates = [m['id'] for m in all_messages.values() if not m.get('children')]
        if leaf_candidates:
            return max(leaf_candidates, key=lambda nid: all_messages[nid].get('created_at') or 0)
        return max(all_messages.keys(), key=lambda nid: all_messages[nid].get('created_at') or 0)

    def _get_sibling_info(self, node: Dict[str, Any], all_messages: Dict[str, Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Returns metadata for all sibling versions of this message (for < 1 / 2 > pagination)."""
        parent_id = node.get('parent_id')
        node_id = node.get('id')
        valid_siblings = []

        if parent_id and parent_id in all_messages:
            parent_node = all_messages[parent_id]
            child_ids = parent_node.get('children', [])
            for cid in child_ids:
                if cid in all_messages:
                    c = all_messages[cid]
                    is_user_or_asst = c.get('role') in ['user', 'assistant']
                    if (not c.get('is_hidden') and (c.get('content') or is_user_or_asst)) or cid == node_id:
                        valid_siblings.append({'id': c['id'], 'created_at': c.get('created_at') or 0})
            if valid_siblings:
                # Ensure current node is in the list
                if not any(s['id'] == node_id for s in valid_siblings):
                    valid_siblings.append({'id': node_id, 'created_at': node.get('created_at') or 0})
                valid_siblings.sort(key=lambda x: x.get('created_at') or 0)
                return valid_siblings

        # Sibling nodes sharing the exact same parent_id (handles root or placeholder parents)
        same_parent_siblings = [
            {'id': m['id'], 'created_at': m.get('created_at') or 0}
            for m in all_messages.values()
            if m.get('parent_id') == parent_id and ((not m.get('is_hidden') and (m.get('content') or m.get('role') in ['user', 'assistant'])) or m.get('id') == node_id)
        ]
        if same_parent_siblings:
            if not any(s['id'] == node_id for s in same_parent_siblings):
                same_parent_siblings.append({'id': node_id, 'created_at': node.get('created_at') or 0})
            same_parent_siblings.sort(key=lambda x: x.get('created_at') or 0)
            return same_parent_siblings

        return [{'id': node_id, 'created_at': node.get('created_at') or 0}]

    def search(self, query_str: str, limit: int = 50) -> List[Dict[str, Any]]:
        """Perform full-text search across all messages using SQLite FTS5."""
        if not query_str or not query_str.strip():
            return []

        tokens = query_str.strip().split()
        safe_tokens = []
        for t in tokens:
            cleaned = "".join(c for c in t if c.isalnum() or c in "_-")
            if cleaned:
                safe_tokens.append(f'"{cleaned}"')
        if not safe_tokens:
            # Fallback for non-alphanumeric queries using exact LIKE substring matching
            raw_q = query_str.strip()
            like_pattern = f"%{raw_q}%"
            conn = self.get_connection()
            try:
                cur = conn.execute(
                    """
                    SELECT 
                        m.id as message_id,
                        m.conversation_id,
                        m.role,
                        '...' || substr(m.content, max(1, instr(lower(m.content), lower(?)) - 15), 60) || '...' as snippet,
                        COALESCE(c.custom_title, c.title) as conversation_title,
                        c.custom_title,
                        c.is_starred,
                        c.title as original_title,
                        c.updated_at as conversation_updated_at,
                        m.created_at as message_created_at,
                        m.content as full_content
                    FROM messages m
                    JOIN conversations c ON c.id = m.conversation_id
                    WHERE m.content LIKE ? OR c.title LIKE ? OR (c.custom_title IS NOT NULL AND c.custom_title LIKE ?)
                    ORDER BY m.created_at DESC
                    LIMIT ?
                    """,
                    (raw_q, like_pattern, like_pattern, like_pattern, limit)
                )
                res = []
                for r in cur.fetchall():
                    d = dict(r)
                    d['is_starred'] = bool(d.get('is_starred', 0))
                    res.append(d)
                return res
            finally:
                if not self._mem_conn:
                    conn.close()

        # Match using OR if multiple terms are given or exact phrase
        fts_query = " OR ".join(safe_tokens)

        conn = self.get_connection()
        try:
            cur = conn.execute(
                """
                SELECT 
                    f.message_id,
                    f.conversation_id,
                    f.role,
                    snippet(messages_fts, 0, '<mark>', '</mark>', '...', 15) as snippet,
                    COALESCE(c.custom_title, c.title) as conversation_title,
                    c.custom_title,
                    c.is_starred,
                    c.title as original_title,
                    c.updated_at as conversation_updated_at,
                    m.created_at as message_created_at,
                    m.content as full_content
                FROM messages_fts f
                JOIN conversations c ON c.id = f.conversation_id
                JOIN messages m ON m.conversation_id = f.conversation_id AND m.id = f.message_id
                WHERE messages_fts MATCH ?
                ORDER BY bm25(messages_fts)
                LIMIT ?
                """,
                (fts_query, limit)
            )
            res = []
            for r in cur.fetchall():
                d = dict(r)
                d['is_starred'] = bool(d.get('is_starred', 0))
                res.append(d)
            return res
        finally:
            if not self._mem_conn:
                conn.close()

    def update_conversation_title(self, conv_id: str, new_title: Optional[str]) -> Optional[Dict[str, Any]]:
        """
        Update the custom title of a conversation.
        If new_title is non-empty, sets custom_title.
        If new_title is empty or None, resets custom_title to NULL (restoring original title).
        Does NOT modify updated_at to preserve historical chronological ordering.
        Returns updated conversation dict or None if not found.
        """
        conn = self.get_connection()
        cleaned_title = _clean_str(new_title).strip() if new_title is not None else ""
        custom_val = cleaned_title if cleaned_title else None

        try:
            with conn:
                cur = conn.execute(
                    "UPDATE conversations SET custom_title = ? WHERE id = ?",
                    (custom_val, conv_id)
                )
                if cur.rowcount == 0:
                    return None
            return self.get_conversation(conv_id)
        finally:
            if not self._mem_conn:
                conn.close()

    def toggle_conversation_star(self, conv_id: str, is_starred: Optional[bool] = None) -> Optional[Dict[str, Any]]:
        """
        Toggle or set star/favorite status for a conversation.
        If is_starred is None, flips current star state.
        Does NOT modify updated_at to preserve historical chronological ordering.
        Returns updated conversation dict or None if not found.
        """
        conn = self.get_connection()
        try:
            with conn:
                existing = conn.execute("SELECT id, is_starred FROM conversations WHERE id = ?", (conv_id,)).fetchone()
                if not existing:
                    return None
                if is_starred is None:
                    new_val = 0 if existing['is_starred'] else 1
                else:
                    new_val = 1 if is_starred else 0

                conn.execute(
                    "UPDATE conversations SET is_starred = ? WHERE id = ?",
                    (new_val, conv_id)
                )
            return self.get_conversation(conv_id)
        finally:
            if not self._mem_conn:
                conn.close()

    def delete_conversation(self, conv_id: str) -> bool:
        """Delete a conversation and all its messages."""
        conn = self.get_connection()
        try:
            with conn:
                cur = conn.execute("DELETE FROM conversations WHERE id = ?", (conv_id,))
                return cur.rowcount > 0
        finally:
            if not self._mem_conn:
                conn.close()

    def get_stats(self) -> Dict[str, Any]:
        """Get summary database statistics."""
        conn = self.get_connection()
        try:
            total_convs = conn.execute("SELECT COUNT(*) FROM conversations").fetchone()[0]
            starred_convs = conn.execute("SELECT COUNT(*) FROM conversations WHERE is_starred = 1").fetchone()[0]
            total_msgs = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
            total_fts = conn.execute("SELECT COUNT(*) FROM messages_fts").fetchone()[0]
            return {
                "total_conversations": total_convs,
                "starred_conversations": starred_convs,
                "total_messages": total_msgs,
                "indexed_fts_entries": total_fts
            }
        finally:
            if not self._mem_conn:
                conn.close()

    def get_analytics(self, cutoff_hour: int = 0) -> Dict[str, Any]:
        """Get rich usage statistics and insights with optional day cutoff hour (0-6)."""
        conn = self.get_connection()
        try:
            cutoff = max(0, min(12, int(cutoff_hour)))
            offset_sec = cutoff * 3600

            # 1. Overview counts
            total_convs = conn.execute("SELECT COUNT(*) FROM conversations").fetchone()[0]
            total_msgs = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
            starred_convs = conn.execute("SELECT COUNT(*) FROM conversations WHERE is_starred = 1").fetchone()[0]

            asst_row = conn.execute(
                "SELECT COUNT(*), COALESCE(SUM(LENGTH(content)), 0) FROM messages WHERE role = 'assistant'"
            ).fetchone()
            user_row = conn.execute(
                "SELECT COUNT(*), COALESCE(SUM(LENGTH(content)), 0) FROM messages WHERE role = 'user'"
            ).fetchone()

            assistant_msgs = asst_row[0] if asst_row else 0
            assistant_chars = asst_row[1] if asst_row else 0
            user_msgs = user_row[0] if user_row else 0
            user_chars = user_row[1] if user_row else 0

            # 2. Top models by message count & conversation count
            model_rows = conn.execute("""
                SELECT 
                    COALESCE(NULLIF(model_slug, ''), 'Unknown') as model,
                    COUNT(*) as message_count,
                    COUNT(DISTINCT conversation_id) as conversation_count
                FROM messages
                WHERE role = 'assistant'
                GROUP BY model
                ORDER BY message_count DESC
                LIMIT 15
            """).fetchall()
            top_models = [dict(r) for r in model_rows]

            # 3. Monthly activity (chronological, shifted by cutoff offset)
            monthly_rows = conn.execute("""
                SELECT 
                    strftime('%Y-%m', datetime(created_at - ?, 'unixepoch', 'localtime')) as month,
                    COUNT(*) as conversation_count,
                    COALESCE(SUM(message_count), 0) as total_messages
                FROM conversations
                WHERE created_at > 0
                GROUP BY month
                ORDER BY month ASC
            """, (offset_sec,)).fetchall()
            monthly_timeline = [dict(r) for r in monthly_rows]

            # 4. Longest conversations
            longest_rows = conn.execute("""
                SELECT 
                    id,
                    title,
                    custom_title,
                    message_count,
                    created_at,
                    model_slug,
                    is_starred
                FROM conversations
                WHERE message_count > 0
                ORDER BY message_count DESC
                LIMIT 15
            """).fetchall()
            longest_conversations = []
            for r in longest_rows:
                d = dict(r)
                d['display_title'] = d.get('custom_title') or d.get('title') or 'Untitled'
                d['is_starred'] = bool(d.get('is_starred', 0))
                longest_conversations.append(d)

            # 5. Weekly 7 Days x 24 Hours Activity Heatmap & Daily Breakdown (Logical DOW shifted by cutoff offset)
            heatmap_rows = conn.execute("""
                SELECT 
                    CAST(strftime('%w', datetime(created_at - ?, 'unixepoch', 'localtime')) AS INTEGER) as dow,
                    CAST(strftime('%H', datetime(created_at, 'unixepoch', 'localtime')) AS INTEGER) as hour,
                    COUNT(*) as count
                FROM messages
                WHERE created_at > 0 AND role = 'user'
                GROUP BY dow, hour
            """, (offset_sec,)).fetchall()

            conv_dow_rows = conn.execute("""
                SELECT 
                    CAST(strftime('%w', datetime(created_at - ?, 'unixepoch', 'localtime')) AS INTEGER) as dow,
                    COUNT(*) as conv_count
                FROM conversations
                WHERE created_at > 0
                GROUP BY dow
            """, (offset_sec,)).fetchall()
            conv_dow_map = {r['dow']: r['conv_count'] for r in conv_dow_rows}

            cell_map = {}
            max_heat = 0
            peak_cell = {"day": "N/A", "hour": 0, "count": 0}
            for r in heatmap_rows:
                dow = r['dow']
                hr = r['hour']
                cnt = r['count']
                cell_map[(dow, hr)] = cnt
                if cnt > max_heat:
                    max_heat = cnt

            # Standard Monday (1) -> Sunday (0) sequence
            days_order = [
                (1, "Mon"),
                (2, "Tue"),
                (3, "Wed"),
                (4, "Thu"),
                (5, "Fri"),
                (6, "Sat"),
                (0, "Sun")
            ]

            total_weekly_prompts = 0
            total_weekly_convs = 0
            weekly_heatmap = []
            for dow_idx, dow_name in days_order:
                day_hours = []
                day_total = 0
                for h in range(24):
                    c = cell_map.get((dow_idx, h), 0)
                    day_hours.append({"hour": h, "count": c})
                    day_total += c
                    if c == max_heat and c > 0:
                        peak_cell = {"day": dow_name, "hour": h, "count": c}
                
                day_convs = conv_dow_map.get(dow_idx, 0)
                total_weekly_prompts += day_total
                total_weekly_convs += day_convs

                weekly_heatmap.append({
                    "dow_index": dow_idx,
                    "day": dow_name,
                    "total": day_total,
                    "conv_count": day_convs,
                    "hours": day_hours
                })

            avg_daily_convs = round(total_weekly_convs / 7.0, 1) if total_weekly_convs > 0 else 0
            avg_daily_prompts = round(total_weekly_prompts / 7.0, 1) if total_weekly_prompts > 0 else 0

            return {
                "overview": {
                    "total_conversations": total_convs,
                    "total_messages": total_msgs,
                    "assistant_messages": assistant_msgs,
                    "user_messages": user_msgs,
                    "assistant_characters": assistant_chars,
                    "user_characters": user_chars,
                    "starred_conversations": starred_convs
                },
                "cutoff_hour": cutoff,
                "top_models": top_models,
                "monthly_timeline": monthly_timeline,
                "longest_conversations": longest_conversations,
                "weekly_heatmap": {
                    "days": weekly_heatmap,
                    "max_count": max_heat,
                    "peak_cell": peak_cell,
                    "total_weekly_convs": total_weekly_convs,
                    "total_weekly_prompts": total_weekly_prompts,
                    "avg_daily_convs": avg_daily_convs,
                    "avg_daily_prompts": avg_daily_prompts
                }
            }
        finally:
            if not self._mem_conn:
                conn.close()
