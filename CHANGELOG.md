# Changelog

All notable changes to this project after forking from [`TomzxCode/llm-conversations-viewer`](https://github.com/TomzxCode/llm-conversations-viewer) (baseline `b7a3315a41b33eac052ad3596b1d890fc94b5cff`) are documented in this file and in [`docs/UPDATE_LOG.md`](docs/UPDATE_LOG.md).

## [1.2.0] - 2026-08-14

### Added
- **Modern Design System & Aesthetics Refresh (`css/styles.css`, `index.html`, `js/ui/sidebar.js`, `js/ui/chat-view.js`, `js/ui/markdown.js`)**:
  - Integrated `Inter` typography font stack from Google Fonts and `JetBrains Mono` for syntax highlighting.
  - Streamlined sidebar header with unified search bar, total count badge, minimal segmented sort pill (`Date` / `Messages` / `↓` `↑`), and quick upload action.
  - Redesigned conversation list cards with smooth rounded geometry, subtle format badges (`OpenAI`, `Claude`, `Z.ai`), relative date, message count chip, and left indicator active state (`#EFF6FF`).
  - Contextual multi-select mode with batch toolbar toggle.
  - Refined main chat canvas with centered reading column (`820px`), modern user message bubbles, and assistant cards.
  - Elevated syntax-highlighted code blocks with language labels and interactive **1-Click "Copy Code"** buttons with visual checkmark feedback.
  - Added slim minimal custom scrollbars and smooth micro-interactions.
  - Explicit year date formatting (`MMM d, yyyy`, e.g. `Apr 11, 2024`) across sidebar conversation cards and main chat header.

### Fixed
- **Full DAG Branch Navigation & Descendant Leaf Resolution (`server/db.py`, `js/parsers.js`, `js/app.js`)**:
  - Fixed an issue where switching conversation branch versions (`< 1 / 2 >`) at an intermediate user prompt or assistant message caused subsequent turns to disappear.
  - Added downward DAG traversal (`_resolve_descendant_leaf`) that resolves any selected intermediate branch node to its deepest descendant leaf before tracing to root, displaying the complete conversation thread for the selected branch.
  - Added client-side fallback DAG branch support (`extractActiveBranch`) preserving full branch trees.
- **Nested ZIP Archive Detection (`js/utils/file-handler.js`, `server/app.py`, `server/importer.py`)**:
  - Fixed ZIP archive extraction failing with "conversations.json not found" when the archive contains nested root folders (e.g. `chatgptdataexport011926/conversations.json` alongside audio/image directories).
  - Added regex matching `/(^|\/)(conversations|chat_history)\.json$/i` across both frontend JSZip and backend Python extraction.
  - Successfully imported and verified 2,539 conversations (57,977 messages) with audio/image folders.
- **Global Full-Text Message & Title Search (`server/db.py`, `js/ui/sidebar.js`, `js/app.js`, `css/styles.css`)**:
  - Upgraded live sidebar search to query both conversation titles and all underlying message contents using SQLite FTS5 index and CJK substring matching.
  - Added live matching message snippets (`search_snippet`) directly in conversation cards with guaranteed 100% keyword highlighting (`<mark class="search-highlight">`).
  - Added debounced live query routing to backend search with seamless offline client fallback.
- **Infinite Scroll & "Load More" Pagination (`js/ui/sidebar.js`, `js/app.js`, `css/styles.css`)**:
  - Replaced hard-capped 100 conversation limit with automatic infinite scroll and a sleek "Load More" button at the bottom of the conversation list.
  - Seamlessly streams batches of 100 conversations as the user scrolls, updating the total count pill dynamically.
- **Unified Canonical Database Location & Instant Startup (`electron-main.js`, `server/db.py`, `js/app.js`)**:
  - Unified database resolution across packaged executables, `Launch_LLM_Viewer.bat`, and `electron .` dev mode to always reference `%APPDATA%\llm-conversations-viewer\conversations.db`.
  - Added single-instance process lock and instant Python runtime scanner that launches the backend in under 100ms.
  - Added client-side connection retry loop in `js/app.js` preventing fallback to empty offline mode during startup.
- **Accidental Drag Overlay & Escape/Click-to-Dismiss Fix (`js/utils/file-handler.js`, `index.html`, `css/styles.css`)**:
  - Fixed accidental overlay trigger when dragging highlighted text on the page by strictly validating `e.dataTransfer.types.includes('Files')`.
  - Added `dragCounter` tracking to accurately handle nested DOM elements during drag-and-drop.
  - Added <kbd>Esc</kbd> key dismiss listener capturing key events across the entire window.
  - Added sleek Close button (✕) and click-anywhere-to-dismiss behavior so the user is never trapped in the upload overlay.

## [1.1.0] - 2026-08-14

### Added
- **Message Count & Date Sorting (`index.html`, `js/ui/sidebar.js`, `server/db.py`, `server/app.py`)**:
  - Added dedicated sort buttons in the sidebar to toggle between sorting by **Date** (newest / oldest) and **Message Count** (highest / lowest).
  - Computed message counts dynamically in SQLite backend with fast indexed aggregation.
  - Added full ascending / descending direction toggles with persistent preference in `localStorage`.
  - Added comprehensive unit and integration tests for sorting in `tests/test_db_and_parser.py` and `tests/test_api_server.py`.

### Fixed
- **UI File Upload Auto-Persistence (`js/utils/file-handler.js`, `js/app.js`)**:
  - Connected browser drag-and-drop / file picker directly to backend `POST /api/import` so all dropped and uploaded JSON/ZIP files are immediately and permanently saved into SQLite `conversations.db`.
- **Persistent Database Path for Packaged Desktop App (`electron-main.js`, `server/db.py`)**:
  - Stored `conversations.db` in the persistent user application directory (`app.getPath('userData')`) when running as a packaged/unpacked desktop executable, ensuring database records survive subsequent executable repacks, updates, or rebuilds.
- **Lone UTF-16 Surrogate Sanitization (`server/db.py`, `server/app.py`)**:
  - Added recursive surrogate codepoint sanitization (`_clean_str`) across scalar strings, nested metadata dictionaries, and message lists to prevent SQLite and JSON serialization crashes on LaTeX/mathematical equations and emoji exports.
- **Shared Message UUID Support Across Forked Conversations (`server/db.py`)**:
  - Updated `messages` table schema to composite primary key `PRIMARY KEY (conversation_id, id)` and qualified FTS5 search joins on `(conversation_id, message_id)` to support OpenAI datasets containing shared node UUIDs across branched or forked chats without duplicate key collisions or Cartesian search multiplication.

## [1.0.0] - 2026-08-14

### Added
- **Local SQLite Database (`server/db.py`)**:
  - Direct local storage in `conversations.db` with WAL mode and foreign key cascading deletes.
  - Relational schema storing conversations and messages with full DAG parent/child links.
  - Built-in **SQLite FTS5 Full-Text Search** virtual table with automatic triggers and snippet highlighting (`<mark>`).
- **Complete Branching & Regenerated Prompt Support (`server/parser.py`)**:
  - Preserves every branch and message version in ChatGPT's `mapping` tree.
  - Computes sibling index and sibling count for prompt edits and regenerated responses.
- **Branch Version Switcher UI (`js/ui/chat-view.js`, `css/styles.css`)**:
  - Interactive `< 1 / 2 >` version pagination buttons on prompt edits and assistant regenerations to switch and re-trace conversation branches in real-time.
- **Zero-Dependency Python Backend & REST API (`server/app.py`)**:
  - Serves frontend static files and REST API endpoints (`/api/conversations`, `/api/conversations/<id>`, `/api/search`, `/api/import`, `/api/stats`).
- **Batch CLI Importer (`server/importer.py`)**:
  - Command-line tool to batch stream and ingest `.zip` archives and `.json` files directly into `conversations.db`.
- **Electron Desktop App & Unpacked Executable (`electron-main.js`, `package.json`)**:
  - Unpacked standalone executable built at `dist/win-unpacked/LLM Conversations Viewer.exe`.
  - 1-Click launcher script `Launch_LLM_Viewer.bat` in the project root.
  - Automated Python server lifecycle management inside Electron.
- **Comprehensive Automated Test Suite (`tests/`)**:
  - 11 unit & integration tests covering database, multi-branching DAGs, FTS5, importer, and HTTP API server (`python -m unittest discover tests`).
- **Documentation**:
  - Added [`docs/UPDATE_LOG.md`](docs/UPDATE_LOG.md) detailing architecture, file tree, and fork modifications.
