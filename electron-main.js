const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');

// Set Windows AppUserModelId to ensure custom taskbar grouping and branding
if (process.platform === 'win32') {
    app.setAppUserModelId('com.antigravity.llmchatvault');
}
app.setName('LLM Chat Vault');

let mainWindow = null;
let serverProcess = null;
const SERVER_PORT = 8000;

// Force canonical userData directory to match %APPDATA%/llm-chat-vault
const appdata = process.env.APPDATA;
if (appdata) {
    const canonicalDir = path.join(appdata, 'llm-chat-vault');
    const legacyDir = path.join(appdata, 'llm-conversations-viewer');
    try {
        if (!fs.existsSync(canonicalDir)) {
            fs.mkdirSync(canonicalDir, { recursive: true });
            // If legacy dir exists and has conversations.db, migrate it seamlessly
            const legacyDb = path.join(legacyDir, 'conversations.db');
            const newDb = path.join(canonicalDir, 'conversations.db');
            if (fs.existsSync(legacyDb) && !fs.existsSync(newDb)) {
                fs.copyFileSync(legacyDb, newDb);
                console.log('Migrated existing conversations.db to llm-chat-vault directory.');
            }
        }
        app.setPath('userData', canonicalDir);
    } catch (e) {
        console.warn('Failed to set canonical userData directory:', e);
    }
}

// Register native file/folder picker for seamless archive import
ipcMain.handle('select-archive-path', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select ChatGPT / Claude Export Folder or Archive',
        properties: ['openFile', 'openDirectory'],
        filters: [
            { name: 'Export Files & Archives', extensions: ['zip', 'json'] },
            { name: 'All Files', extensions: ['*'] }
        ]
    });
    if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
        return result.filePaths[0];
    }
    return null;
});

function getAppRoot() {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'app');
    }
    return __dirname;
}

function getDatabasePath() {
    const appdata = process.env.APPDATA;
    if (appdata) {
        const canonicalDb = path.join(appdata, 'llm-chat-vault', 'conversations.db');
        if (fs.existsSync(canonicalDb)) {
            return canonicalDb;
        }
        const legacyDb = path.join(appdata, 'llm-conversations-viewer', 'conversations.db');
        if (fs.existsSync(legacyDb)) {
            return legacyDb;
        }
    }
    const userDataDir = app.getPath('userData');
    const userDataDb = path.join(userDataDir, 'conversations.db');
    const legacyDb = path.join(getAppRoot(), 'conversations.db');
    const rootDb = path.join(__dirname, 'conversations.db');

    try {
        if (!fs.existsSync(userDataDir)) {
            fs.mkdirSync(userDataDir, { recursive: true });
        }
        // Migrate from legacy or root db if userDataDb doesn't exist
        if (!fs.existsSync(userDataDb)) {
            if (fs.existsSync(legacyDb)) {
                fs.copyFileSync(legacyDb, userDataDb);
                console.log('Migrated legacy database to user data directory.');
            } else if (fs.existsSync(rootDb)) {
                fs.copyFileSync(rootDb, userDataDb);
                console.log('Migrated root database to user data directory.');
            }
        }
    } catch (e) {
        console.warn('Database path setup check skipped:', e);
    }
    return userDataDb;
}

function checkServerReady(port, retries = 60, delay = 50) {
    return new Promise((resolve) => {
        let attempts = 0;
        const interval = setInterval(() => {
            attempts++;
            const req = http.get(`http://127.0.0.1:${port}/api/stats`, (res) => {
                if (res.statusCode === 200) {
                    clearInterval(interval);
                    resolve(true);
                }
            });
            req.on('error', () => {
                if (attempts >= retries) {
                    clearInterval(interval);
                    resolve(false);
                }
            });
            req.end();
        }, delay);
    });
}

function findWorkingPython() {
    const candidates = [];
    if (process.platform === 'win32') {
        const localApp = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : '');
        if (localApp) {
            const pyDir = path.join(localApp, 'Programs', 'Python');
            if (fs.existsSync(pyDir)) {
                try {
                    const entries = fs.readdirSync(pyDir);
                    for (const entry of entries) {
                        candidates.push(path.join(pyDir, entry, 'python.exe'));
                    }
                } catch {}
            }
        }
        for (const drive of ['C:', 'D:', 'E:']) {
            candidates.push(
                path.join(drive, 'Python313', 'python.exe'),
                path.join(drive, 'Python312', 'python.exe'),
                path.join(drive, 'Python311', 'python.exe'),
                path.join(drive, 'Python310', 'python.exe'),
                path.join(drive, 'Program Files', 'Python312', 'python.exe'),
                path.join(drive, 'Program Files', 'Python311', 'python.exe'),
                path.join(drive, 'Program Files', 'Python310', 'python.exe')
            );
        }
        candidates.push('py', 'python', 'python3');
    } else {
        candidates.push('python3', 'python');
    }

    const { spawnSync } = require('child_process');
    for (const cand of candidates) {
        if (typeof cand === 'string' && cand.toLowerCase().includes('windowsapps')) continue;
        if (path.isAbsolute(cand) && !fs.existsSync(cand)) continue;
        try {
            const res = spawnSync(cand, ['-c', 'import sqlite3; print("OK")'], {
                encoding: 'utf-8',
                timeout: 1500,
                windowsHide: true
            });
            if (res.status === 0 && res.stdout && res.stdout.includes('OK')) {
                console.log(`Verified Python executable: ${cand}`);
                return cand;
            }
        } catch {}
    }
    return 'python';
}

async function startBackendServer() {
    // Check if server is already running
    const alreadyUp = await new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${SERVER_PORT}/api/stats`, (res) => {
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.end();
    });

    if (alreadyUp) {
        console.log('Backend server is already running.');
        return true;
    }

    const appRoot = getAppRoot();
    const dbPath = getDatabasePath();
    const logPath = path.join(app.getPath('userData'), 'server.log');
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });

    const attachmentsPath = path.join(app.getPath('userData'), 'attachments');
    try {
        if (!fs.existsSync(attachmentsPath)) {
            fs.mkdirSync(attachmentsPath, { recursive: true });
        }
    } catch (e) {}

    const pythonCmd = findWorkingPython();
    try {
        console.log(`Starting backend server with ${pythonCmd}...`);
        serverProcess = spawn(pythonCmd, ['-m', 'server.app', String(SERVER_PORT), dbPath, attachmentsPath], {
            cwd: appRoot,
            shell: false,
            windowsHide: true,
            env: Object.assign({}, process.env, { ATTACHMENTS_DIR: attachmentsPath })
        });

        if (serverProcess.stdout) serverProcess.stdout.pipe(logStream);
        if (serverProcess.stderr) serverProcess.stderr.pipe(logStream);

        serverProcess.on('error', (err) => {
            console.warn(`Error running ${pythonCmd}:`, err.message);
        });

        let earlyExit = false;
        serverProcess.on('exit', (code) => {
            if (code !== 0 && code !== null) {
                console.warn(`Backend process exited with code ${code}`);
                earlyExit = true;
            }
        });

        const ready = await checkServerReady(SERVER_PORT, 60, 50);
        if (ready) {
            console.log(`Backend server successfully started and responding on port ${SERVER_PORT}.`);
            return true;
        }
    } catch (err) {
        console.warn(`Failed to start backend server:`, err);
    }

    return await checkServerReady(SERVER_PORT, 10, 100);
}

function getAppIconPath() {
    const appRoot = getAppRoot();
    const isWin = process.platform === 'win32';
    const primaryIcon = isWin ? 'icon.ico' : 'icon.png';
    const candidates = [
        path.join(__dirname, 'assets', primaryIcon),
        path.join(appRoot, 'assets', primaryIcon),
        path.join(__dirname, 'assets', 'icon.png'),
        path.join(appRoot, 'assets', 'icon.png'),
    ];
    for (const cand of candidates) {
        if (fs.existsSync(cand)) {
            return cand;
        }
    }
    return undefined;
}

async function createWindow() {
    const isBackendUp = await startBackendServer();
    const appIcon = getAppIconPath();

    mainWindow = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 800,
        minHeight: 600,
        title: 'LLM Chat Vault',
        icon: appIcon,
        backgroundColor: '#0d1117',
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: true
        }
    });

    if (isBackendUp) {
        mainWindow.loadURL(`http://127.0.0.1:${SERVER_PORT}`);
    } else {
        const appRoot = getAppRoot();
        mainWindow.loadFile(path.join(appRoot, 'index.html'));
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (serverProcess) {
        try {
            serverProcess.kill();
        } catch {}
    }
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    }
});
