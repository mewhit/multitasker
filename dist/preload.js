"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld('electronAPI', {
    createSession: (name, cmd, cwd, shellType, sshCommand = '') => electron_1.ipcRenderer.invoke('session:create', name, cmd, cwd, shellType, sshCommand),
    removeSession: (id) => electron_1.ipcRenderer.invoke('session:remove', id),
    renameSession: (id, name) => electron_1.ipcRenderer.invoke('session:rename', id, name),
    openReview: (cwd) => electron_1.ipcRenderer.invoke('session:open-review', cwd),
    openVsCode: (session) => electron_1.ipcRenderer.invoke('editor:open-vscode', session),
    pickDirectory: () => electron_1.ipcRenderer.invoke('session:pick-dir'),
    getSessions: () => electron_1.ipcRenderer.invoke('session:list'),
    onListUpdate: (cb) => {
        electron_1.ipcRenderer.on('session:list-update', (_event, sessions) => cb(sessions));
    },
    onVsCodeFocusFailed: (cb) => {
        electron_1.ipcRenderer.on('editor:vscode-focus-failed', (_event, payload) => cb(payload));
    },
    getManualTasks: () => electron_1.ipcRenderer.invoke('manual-task:list'),
    addManualTask: (text) => electron_1.ipcRenderer.invoke('manual-task:add', text),
    removeManualTask: (id) => electron_1.ipcRenderer.invoke('manual-task:remove', id),
    onManualTaskListUpdate: (cb) => {
        electron_1.ipcRenderer.on('manual-task:list-update', (_event, tasks) => cb(tasks));
    },
    getRecurringTasks: () => electron_1.ipcRenderer.invoke('recurring-task:list'),
    addRecurringTask: (text, time, daysOfWeek) => electron_1.ipcRenderer.invoke('recurring-task:add', text, time, daysOfWeek),
    removeRecurringTask: (id) => electron_1.ipcRenderer.invoke('recurring-task:remove', id),
    onRecurringTaskListUpdate: (cb) => {
        electron_1.ipcRenderer.on('recurring-task:list-update', (_event, tasks) => cb(tasks));
    },
    getSlackNotifications: () => electron_1.ipcRenderer.invoke('slack:list'),
    clearSlackNotifications: () => electron_1.ipcRenderer.invoke('slack:clear'),
    removeSlackNotification: (id) => electron_1.ipcRenderer.invoke('slack:remove', id),
    openSlackNotification: (id) => electron_1.ipcRenderer.invoke('slack:open', id),
    startSlackAuth: () => electron_1.ipcRenderer.invoke('slack:start-auth'),
    startSlackListener: () => electron_1.ipcRenderer.invoke('slack:start-listener'),
    getSlackListenerStatus: () => electron_1.ipcRenderer.invoke('slack:get-listener-status'),
    onSlackNotification: (cb) => {
        electron_1.ipcRenderer.on('slack:notification', (_event, notification) => cb(notification));
    },
    onSlackListUpdate: (cb) => {
        electron_1.ipcRenderer.on('slack:list-update', (_event, notifications) => cb(notifications));
    },
    onSlackAuthStatus: (cb) => {
        electron_1.ipcRenderer.on('slack:auth-status', (_event, payload) => cb(payload));
    },
    onSlackListenerStatus: (cb) => {
        electron_1.ipcRenderer.on('slack:listener-status', (_event, payload) => cb(payload));
    },
    getSettings: () => electron_1.ipcRenderer.invoke('settings:get'),
    setSettings: (settings) => electron_1.ipcRenderer.invoke('settings:set', settings),
});
