"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const node_path_1 = __importDefault(require("node:path"));
const node_child_process_1 = require("node:child_process");
const sessionManager_1 = require("./sessionManager");
const settings_1 = require("./settings");
const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 800;
const WINDOW_MIN_WIDTH = 960;
const WINDOW_MIN_HEIGHT = 600;
let mainWindow = null;
let sessionManager = null;
function setupIpc() {
    electron_1.ipcMain.handle('session:create', (_e, name, cmd, cwd, shellType, sshHost) => {
        return sessionManager?.createSession(name, cmd, cwd, shellType, sshHost) ?? null;
    });
    electron_1.ipcMain.handle('session:persist', (_e, id) => {
        sessionManager?.markSessionAsPersisted(id);
        (0, settings_1.saveSessions)(getSessionsStateToSave());
    });
    electron_1.ipcMain.handle('session:unpersist', (_e, id) => {
        // Remove from persisted sessions
        const currentSessions = (0, settings_1.loadSessions)();
        const filtered = currentSessions.filter(s => {
            const session = sessionManager?.getSessions().find(x => x.id === id && x.name === s.name && x.cwd === s.cwd);
            return !session;
        });
        (0, settings_1.saveSessions)(filtered);
    });
    electron_1.ipcMain.handle('session:list-persisted', () => {
        return (0, settings_1.loadSessions)();
    });
    electron_1.ipcMain.on('session:input', (_e, id, data) => {
        sessionManager?.sendInput(id, data);
    });
    electron_1.ipcMain.on('session:resize', (_e, id, cols, rows) => {
        sessionManager?.resizeSession(id, cols, rows);
    });
    electron_1.ipcMain.handle('session:kill', (_e, id) => {
        sessionManager?.killSession(id);
        (0, settings_1.saveSessions)(getSessionsStateToSave());
    });
    electron_1.ipcMain.handle('session:list', () => sessionManager?.getSessions() ?? []);
    electron_1.ipcMain.handle('session:open-review', (_e, cwd) => {
        const settings = (0, settings_1.loadSettings)();
        const cmd = settings.reviewTool.replace('{path}', `"${cwd}"`);
        (0, node_child_process_1.exec)(cmd, (err) => {
            if (err)
                console.error('Failed to open review tool:', err.message);
        });
    });
    electron_1.ipcMain.handle('session:pick-dir', async () => {
        if (!mainWindow)
            return null;
        const result = await electron_1.dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory'],
        });
        return result.canceled ? null : (result.filePaths[0] ?? null);
    });
    electron_1.ipcMain.handle('settings:get', () => (0, settings_1.loadSettings)());
    electron_1.ipcMain.handle('settings:set', (_e, settings) => {
        (0, settings_1.saveSettings)(settings);
        if (sessionManager)
            sessionManager.idleTimeout = settings.idleTimeout;
    });
}
function getSessionsStateToSave() {
    const persistedIds = sessionManager?.getPersistedSessionIds() ?? [];
    const allSessions = sessionManager?.getSessions() ?? [];
    return persistedIds
        .map(id => allSessions.find(s => s.id === id))
        .filter((s) => s !== undefined)
        .map(s => ({ name: s.name, cmd: s.cmd, cwd: s.cwd, shellType: s.shellType, sshHost: s.sshHost }));
}
function createWindow() {
    const settings = (0, settings_1.loadSettings)();
    sessionManager = new sessionManager_1.SessionManager(settings.idleTimeout);
    mainWindow = new electron_1.BrowserWindow({
        width: WINDOW_WIDTH,
        height: WINDOW_HEIGHT,
        minWidth: WINDOW_MIN_WIDTH,
        minHeight: WINDOW_MIN_HEIGHT,
        backgroundColor: '#0d1117',
        webPreferences: {
            preload: node_path_1.default.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    sessionManager.on('output', (id, data) => {
        mainWindow?.webContents.send('session:output', id, data);
    });
    sessionManager.on('sessionUpdate', (sessions) => {
        mainWindow?.webContents.send('session:list-update', sessions);
    });
    void mainWindow.loadFile(node_path_1.default.join(__dirname, '..', 'index.html'));
    // Restore persisted sessions after window loads
    mainWindow.webContents.on('did-finish-load', () => {
        const persistedSessions = (0, settings_1.loadSessions)();
        persistedSessions.forEach(sessionState => {
            const id = sessionManager?.createSession(sessionState.name, sessionState.cmd, sessionState.cwd, sessionState.shellType, sessionState.sshHost);
            if (id) {
                sessionManager?.markSessionAsPersisted(id);
            }
        });
    });
}
setupIpc();
void electron_1.app.whenReady().then(() => {
    createWindow();
    electron_1.app.on('activate', () => {
        if (electron_1.BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});
electron_1.app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        electron_1.app.quit();
    }
});
