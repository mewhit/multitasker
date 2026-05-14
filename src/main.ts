import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'node:path';
import { exec } from 'node:child_process';
import { SessionManager, type Session } from './sessionManager';
import { loadSettings, saveSettings, AppSettings, loadSessions, saveSessions, SessionState } from './settings';

const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 800;
const WINDOW_MIN_WIDTH = 960;
const WINDOW_MIN_HEIGHT = 600;

let mainWindow: BrowserWindow | null = null;
let sessionManager: SessionManager | null = null;

function setupIpc(): void {
  ipcMain.handle('session:create', (_e, name: string, cmd: string, cwd: string, shellType: string, sshHost: string) => {
    return sessionManager?.createSession(name, cmd, cwd, shellType as import('./settings').ShellType, sshHost) ?? null;
  });

  ipcMain.handle('session:persist', (_e, id: string) => {
    sessionManager?.markSessionAsPersisted(id);
    saveSessions(getSessionsStateToSave());
  });

  ipcMain.handle('session:unpersist', (_e, id: string) => {
    // Remove from persisted sessions
    const currentSessions = loadSessions();
    const filtered = currentSessions.filter(s => {
      const session = sessionManager?.getSessions().find(x => x.id === id && x.name === s.name && x.cwd === s.cwd);
      return !session;
    });
    saveSessions(filtered);
  });

  ipcMain.handle('session:list-persisted', () => {
    return loadSessions();
  });

  ipcMain.on('session:input', (_e, id: string, data: string) => {
    sessionManager?.sendInput(id, data);
  });

  ipcMain.on('session:resize', (_e, id: string, cols: number, rows: number) => {
    sessionManager?.resizeSession(id, cols, rows);
  });

  ipcMain.handle('session:kill', (_e, id: string) => {
    sessionManager?.killSession(id);
    saveSessions(getSessionsStateToSave());
  });

  ipcMain.handle('session:list', () => sessionManager?.getSessions() ?? []);

  ipcMain.handle('session:open-review', (_e, cwd: string) => {
    const settings = loadSettings();
    const cmd = settings.reviewTool.replace('{path}', `"${cwd}"`);
    exec(cmd, (err) => {
      if (err) console.error('Failed to open review tool:', err.message);
    });
  });

  ipcMain.handle('session:pick-dir', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle('settings:get', () => loadSettings());

  ipcMain.handle('settings:set', (_e, settings: AppSettings) => {
    saveSettings(settings);
    if (sessionManager) sessionManager.idleTimeout = settings.idleTimeout;
  });
}

function getSessionsStateToSave(): SessionState[] {
  const persistedIds = sessionManager?.getPersistedSessionIds() ?? [];
  const allSessions = sessionManager?.getSessions() ?? [];
  return persistedIds
    .map(id => allSessions.find(s => s.id === id))
    .filter((s): s is Session => s !== undefined)
    .map(s => ({ name: s.name, cmd: s.cmd, cwd: s.cwd, shellType: s.shellType, sshHost: s.sshHost }));
}

function createWindow(): void {
  const settings = loadSettings();
  sessionManager = new SessionManager(settings.idleTimeout);

  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  sessionManager.on('output', (id: string, data: string) => {
    mainWindow?.webContents.send('session:output', id, data);
  });

  sessionManager.on('sessionUpdate', (sessions: unknown) => {
    mainWindow?.webContents.send('session:list-update', sessions);
  });

  void mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));

  // Restore persisted sessions after window loads
  mainWindow.webContents.on('did-finish-load', () => {
    const persistedSessions = loadSessions();
    persistedSessions.forEach(sessionState => {
      const id = sessionManager?.createSession(sessionState.name, sessionState.cmd, sessionState.cwd, sessionState.shellType, sessionState.sshHost);
      if (id) {
        sessionManager?.markSessionAsPersisted(id);
      }
    });
  });
}

setupIpc();

void app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
