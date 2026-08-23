# LLM Chat Vault - Update & Evolution Log

## 1. Fork Origin & Baseline Info

* **Upstream Repository**: [`TomzxCode / llm-conversations-viewer`](https://github.com/TomzxCode/llm-conversations-viewer)
* **Baseline Commit SHA**: `b7a3315a41b33eac052ad3596b1d890fc94b5cff`
* **Original Architecture**: Pure client-side static web application (HTML/Bootstrap + Vanilla JS) storing data ephemerally or in browser IndexedDB.
* **Original Limitation**: Linear backwards traversal from `current_node` to root, which skipped all previous prompt edits and regenerated response variations.

---

## 2. Key Enhancements & Modifications

### 2.1 Local SQLite Database Backend (`conversations.db`)
- **Persistent Local Database**: Built a local database layer in [`server/db.py`](../server/db.py) using Python's zero-dependency `sqlite3` library.
- **Relational Schema**: Structured tables for `conversations` and `messages` preserving conversation graph lineage (`parent_id`, `node_id`, `children_json`, `sibling_index`, `sibling_count`).
- **WAL Mode & Foreign Keys**: Configured `PRAGMA journal_mode = WAL` and `PRAGMA foreign_keys = ON` with cascading deletes.
- **FTS5 Full-Text Search Engine**: SQLite virtual table `messages_fts` synchronized via automated triggers (`AFTER INSERT`, `AFTER DELETE`, `AFTER UPDATE`), providing sub-5ms BM25 full-text search and highlighted snippets across thousands of messages.

### 2.2 Full Branching & Regenerated Prompts Support
- **Complete DAG Parser**: Rewrote parser logic in [`server/parser.py`](../server/parser.py) to ingest every node in ChatGPT's `mapping` graph instead of just the leaf node path.
- **Sibling Version Calculation**: Automatically calculates sibling indexes and total versions for both user prompts and assistant responses.
- **Interactive UI Version Switcher**: Enhanced [`js/ui/chat-view.js`](../js/ui/chat-view.js) and [`css/styles.css`](../css/styles.css) with `< 1 / 2 >` version pagination buttons to toggle between prompt edits and regenerated responses in real time.

### 2.3 Local REST API & Static File Server
- **Zero-Dependency HTTP Server**: Built [`server/app.py`](../server/app.py) using standard Python libraries to serve the static frontend and REST endpoints:
  - `GET /api/conversations`: Paginated conversation listing with search.
  - `GET /api/conversations/<id>`: Full conversation data with active branch and sibling metadata. Supports `?leaf_node_id=...` for branch switching.
  - `GET /api/search?q=...`: High-speed FTS5 full-text search.
  - `POST /api/import`: Multipart and JSON streaming import directly into SQLite.
  - `GET /api/stats`: Database status and statistics.
  - `DELETE /api/conversations/<id>`: Cascade deletion.

### 2.4 Batch Import CLI
- Created [`server/importer.py`](../server/importer.py) to stream and batch-insert `.zip` archives or `.json` exports into `conversations.db` from the command line:
  ```powershell
  python -m server.importer "path/to/conversations.zip"
  ```

### 2.5 Desktop Electron Packaging & 1-Click Launching
- **Electron Lifecycle Integration**: Built [`electron-main.js`](../electron-main.js) which automatically starts the local backend server, checks port availability, launches a native desktop window, and cleanly tears down background processes on exit.
- **Unpacked Executable Distribution**: Built unpacked standalone Windows binary at:
  - `dist/win-unpacked/LLM Chat Vault.exe`
- **Root One-Click Launcher**: Added [`Launch_Chat_Vault.bat`](../Launch_Chat_Vault.bat) in the project root.

### 2.6 Automated Unit & Integration Test Suites
- Added comprehensive test suites in [`tests/`](../tests/):
  - `tests/test_db_and_parser.py`: Tests SQLite schema, multi-branching DAGs, prompt edits, regenerations, Claude parsing, deletion cascades, and FTS5 search.
  - `tests/test_api_server.py`: Integration tests for all HTTP API endpoints.

---

## 3. Project File Map

```text
llm-chat-vault/
├── Launch_Chat_Vault.bat       # 1-Click launcher for unpacked desktop app
├── electron-main.js            # Electron main process & backend supervisor
├── package.json                # NPM configuration, build scripts & packaging settings
├── index.html                  # Main Web UI entry point
├── server/                     # Local Python backend
│   ├── __init__.py
│   ├── app.py                  # Zero-dependency HTTP REST API & static server
│   ├── db.py                   # SQLite schema, FTS5 triggers & DAG query engine
│   ├── importer.py             # Batch CLI importer for ZIP / JSON exports
│   └── parser.py               # Tree-aware conversation DAG parser
├── js/
│   ├── app.js                  # Main application orchestrator (supports API & local mode)
│   ├── ui/
│   │   ├── chat-view.js        # Chat renderer with < 1 / 2 > branch switcher
│   │   ├── chat-navigator.js   # Adaptive outline & timeline spine
│   │   ├── insights-modal.js   # Usage analytics & heatmap dashboard
│   │   ├── markdown.js         # Markdown parser & syntax highlighting
│   │   └── sidebar.js          # Sidebar navigation, tags, and search
│   └── utils/
│       ├── api-client.js       # Frontend REST API client for backend
│       ├── export.js           # Export utilities
│       ├── file-handler.js     # Drag-and-drop file processing
│       ├── indexeddb.js        # Browser-only IndexedDB storage fallback
│       └── storage.js          # Storage interface
├── css/
│   └── styles.css              # Styling including branch switcher components
├── tests/                      # Automated test suites
│   ├── __init__.py
│   ├── test_db_and_parser.py   # Unit tests for database, DAG branching, FTS5
│   └── test_api_server.py      # Integration tests for HTTP API endpoints
├── dist/win-unpacked/          # Unpacked standalone Electron executable
│   └── LLM Chat Vault.exe
└── docs/
    └── UPDATE_LOG.md           # This document
```
