# Agent Instructions & Project Rules

## ⚠️ MANDATORY DIRECTIVE: ALWAYS RE-PACK EXE AFTER ANY CODE CHANGES

**Whenever ANY modifications or fixes are made to this codebase (frontend JS/CSS/HTML, backend Python server/database, Electron configs, or assets), you MUST ALWAYS re-pack the Electron executable as the final step before reporting completion to the user.**

### Standard Post-Change Workflow:
```powershell
# 1. Run test suite to verify changes
pytest

# 2. Terminate any running app instance to prevent EPERM / Access Denied file locks
Stop-Process -Name "LLM Chat Vault", "LLM Conversations Viewer", electron -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

# 3. Rebuild and pack the executable (MUST use npm.cmd on Windows)
npm.cmd run pack

# 4. Verify output exe timestamp
Get-Item "dist\win-unpacked\LLM Chat Vault.exe"
```

---

## 🛠️ Project Build & Run Reference

### 1. Electron Packaging
- **Target Output**: `dist/win-unpacked/LLM Chat Vault.exe`
- **Launcher Script**: `Launch_Chat_Vault.bat` launches `dist/win-unpacked/LLM Chat Vault.exe` directly.
- **Packaging Command**: `npm.cmd run pack` (runs `electron-builder --dir --win`).

### 2. Testing & Verification
- Run all unit and integration tests before packaging:
```powershell
python -m pytest tests/
```

### 3. Key Architecture Notes
- **Desktop Wrapper**: Electron (`electron-main.js`) manages BrowserWindow and automatically launches the local Python backend server (`server/app.py`).
- **Database Layer**: SQLite with WAL mode & FTS5 full-text search (`server/db.py`).
- **Frontend**: Vanilla ES6 modules (`js/app.js`, `js/ui/sidebar.js`, `js/ui/chat-view.js`, `js/ui/chat-navigator.js`, `js/utils/`).
- **Offline / Pure Client Fallback**: IndexedDB v2 (`js/utils/indexeddb.js`).
- **Navigation & Preview**: `js/ui/chat-navigator.js` handles Claude timeline (<15 turns) and ChatGPT outline (>=15 turns) navigation modes.
