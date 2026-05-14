"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld('electronAPI', {
    createSession: (name, cmd, cwd, shellType, sshHost) => electron_1.ipcRenderer.invoke('session:create', name, cmd, cwd, shellType, sshHost),
    sendInput: (id, data) => electron_1.ipcRenderer.send('session:input', id, data),
    resizeSession: (id, cols, rows) => electron_1.ipcRenderer.send('session:resize', id, cols, rows),
    killSession: (id) => electron_1.ipcRenderer.invoke('session:kill', id),
    openReview: (cwd) => electron_1.ipcRenderer.invoke('session:open-review', cwd),
    pickDirectory: () => electron_1.ipcRenderer.invoke('session:pick-dir'),
    getSessions: () => electron_1.ipcRenderer.invoke('session:list'),
    onOutput: (cb) => {
        electron_1.ipcRenderer.on('session:output', (_event, id, data) => cb(id, data));
    },
    onListUpdate: (cb) => {
        electron_1.ipcRenderer.on('session:list-update', (_event, sessions) => cb(sessions));
    },
    getSettings: () => electron_1.ipcRenderer.invoke('settings:get'),
    setSettings: (settings) => electron_1.ipcRenderer.invoke('settings:set', settings),
    persistSession: (id) => electron_1.ipcRenderer.invoke('session:persist', id),
    unpersistSession: (id) => electron_1.ipcRenderer.invoke('session:unpersist', id),
    getPersistedSessions: () => electron_1.ipcRenderer.invoke('session:list-persisted'),
});
