"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld('electronAPI', {
    createSession: (name, cmd, cwd, shellType, sshCommand = '') => electron_1.ipcRenderer.invoke('session:create', name, cmd, cwd, shellType, sshCommand),
    createShellPty: (cwd, name) => electron_1.ipcRenderer.invoke('shell:create-pty', cwd, name),
    createShellSsh: (opts) => electron_1.ipcRenderer.invoke('shell:create-ssh', opts),
    reconnectShellSsh: (sessionId) => electron_1.ipcRenderer.invoke('shell:reconnect-ssh', sessionId),
    focusVscode: (sessionId) => electron_1.ipcRenderer.invoke('shell:focus-vscode', sessionId),
    getShellServerConfig: () => electron_1.ipcRenderer.invoke('shell:get-config'),
    removeSession: (id) => electron_1.ipcRenderer.invoke('session:remove', id),
    pauseSession: (id) => electron_1.ipcRenderer.invoke('session:pause', id),
    renameSession: (id, name) => electron_1.ipcRenderer.invoke('session:rename', id, name),
    openReview: (cwd) => electron_1.ipcRenderer.invoke('session:open-review', cwd),
    pickDirectory: () => electron_1.ipcRenderer.invoke('session:pick-dir'),
    getSessions: () => electron_1.ipcRenderer.invoke('session:list'),
    onListUpdate: (cb) => {
        electron_1.ipcRenderer.on('session:list-update', (_event, sessions) => cb(sessions));
    },
    getManualTasks: () => electron_1.ipcRenderer.invoke('manual-task:list'),
    addManualTask: (text, createdAt) => electron_1.ipcRenderer.invoke('manual-task:add', text, createdAt),
    removeManualTask: (id) => electron_1.ipcRenderer.invoke('manual-task:remove', id),
    onManualTaskListUpdate: (cb) => {
        electron_1.ipcRenderer.on('manual-task:list-update', (_event, tasks) => cb(tasks));
    },
    getRecurringTasks: () => electron_1.ipcRenderer.invoke('recurring-task:list'),
    addRecurringTask: (text, time, schedule) => electron_1.ipcRenderer.invoke('recurring-task:add', text, time, schedule),
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
    getGoogleCalendarEvents: () => electron_1.ipcRenderer.invoke('google-calendar:list'),
    getGoogleCalendarStatus: () => electron_1.ipcRenderer.invoke('google-calendar:status'),
    connectGoogleCalendar: () => electron_1.ipcRenderer.invoke('google-calendar:connect'),
    disconnectGoogleCalendar: (id) => electron_1.ipcRenderer.invoke('google-calendar:disconnect', id),
    refreshGoogleCalendar: () => electron_1.ipcRenderer.invoke('google-calendar:refresh'),
    openGoogleCalendarEvent: (id) => electron_1.ipcRenderer.invoke('google-calendar:open', id),
    onGoogleCalendarListUpdate: (cb) => {
        electron_1.ipcRenderer.on('google-calendar:list-update', (_event, events) => cb(events));
    },
    onGoogleCalendarStatusUpdate: (cb) => {
        electron_1.ipcRenderer.on('google-calendar:status-update', (_event, status) => cb(status));
    },
    getSettings: () => electron_1.ipcRenderer.invoke('settings:get'),
    setSettings: (settings) => electron_1.ipcRenderer.invoke('settings:set', settings),
});
