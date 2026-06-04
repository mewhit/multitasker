"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.setStorageDirectory = setStorageDirectory;
exports.normalizeClientMetadata = normalizeClientMetadata;
exports.loadSettings = loadSettings;
exports.saveSettings = saveSettings;
exports.loadSessions = loadSessions;
exports.saveSessions = saveSessions;
exports.loadManualTasks = loadManualTasks;
exports.saveManualTasks = saveManualTasks;
exports.loadRecurringTasks = loadRecurringTasks;
exports.saveRecurringTasks = saveRecurringTasks;
exports.loadSlackNotifications = loadSlackNotifications;
exports.saveSlackNotifications = saveSlackNotifications;
exports.loadGoogleCalendarAuth = loadGoogleCalendarAuth;
exports.saveGoogleCalendarAuth = saveGoogleCalendarAuth;
exports.clearGoogleCalendarAuth = clearGoogleCalendarAuth;
exports.loadGoogleCalendarConnections = loadGoogleCalendarConnections;
exports.saveGoogleCalendarConnections = saveGoogleCalendarConnections;
exports.clearGoogleCalendarConnections = clearGoogleCalendarConnections;
exports.loadGoogleCalendarEvents = loadGoogleCalendarEvents;
exports.saveGoogleCalendarEvents = saveGoogleCalendarEvents;
exports.clearGoogleCalendarEvents = clearGoogleCalendarEvents;
exports.loadWindowState = loadWindowState;
exports.saveWindowState = saveWindowState;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const DEFAULT_SETTINGS = {
    reviewTool: 'code {path}',
    defaultShell: process.platform === 'win32' ? 'powershell' : 'bash',
    googleCalendar: {
        calendarId: 'primary',
        lookAheadDays: 7,
        enabled: false,
        ownedCalendarsOnly: true,
    },
    githubReview: {
        enabled: false,
        owner: '',
        repo: '',
        pollMinutes: 5,
    },
};
const DATA_DIR_ENV = 'MULTITASKER_DATA_DIR';
let storageDirectoryOverride = '';
function setStorageDirectory(directory) {
    storageDirectoryOverride = directory.trim();
}
function isLocalShellType(value) {
    return value === 'powershell' || value === 'bash';
}
function isShellType(value) {
    return isLocalShellType(value) || value === 'ssh';
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function normalizeSettings(value) {
    if (!isRecord(value))
        return getDefaultSettings();
    const rawReviewTool = value['reviewTool'];
    const rawDefaultShell = value['defaultShell'];
    const reviewTool = typeof rawReviewTool === 'string' && rawReviewTool.trim()
        ? rawReviewTool
        : DEFAULT_SETTINGS.reviewTool;
    const defaultShell = isLocalShellType(rawDefaultShell)
        ? rawDefaultShell
        : DEFAULT_SETTINGS.defaultShell;
    return {
        reviewTool,
        defaultShell,
        googleCalendar: normalizeGoogleCalendarSettings(value['googleCalendar']),
        githubReview: normalizeGitHubReviewSettings(value['githubReview']),
    };
}
function getDefaultSettings() {
    return {
        ...DEFAULT_SETTINGS,
        googleCalendar: { ...DEFAULT_SETTINGS.googleCalendar },
    };
}
function normalizeGoogleCalendarSettings(value) {
    if (!isRecord(value))
        return { ...DEFAULT_SETTINGS.googleCalendar };
    const calendarId = readTrimmedString(value, 'calendarId') || DEFAULT_SETTINGS.googleCalendar.calendarId;
    const lookAheadDays = readFiniteNumber(value, 'lookAheadDays');
    const settings = {
        calendarId,
        lookAheadDays: lookAheadDays !== null
            ? Math.max(1, Math.min(365, Math.floor(lookAheadDays)))
            : DEFAULT_SETTINGS.googleCalendar.lookAheadDays,
        enabled: value['enabled'] === true,
        ownedCalendarsOnly: value['ownedCalendarsOnly'] !== false,
    };
    return settings;
}
function normalizeGitHubReviewSettings(value) {
    if (!isRecord(value))
        return { ...DEFAULT_SETTINGS.githubReview };
    const owner = readTrimmedString(value, 'owner');
    const repo = readTrimmedString(value, 'repo');
    const pollMinutes = readFiniteNumber(value, 'pollMinutes');
    return {
        enabled: value['enabled'] === true,
        owner,
        repo,
        pollMinutes: pollMinutes !== null
            ? Math.max(1, Math.min(60, Math.floor(pollMinutes)))
            : DEFAULT_SETTINGS.githubReview.pollMinutes,
    };
}
function normalizeSessionState(value) {
    if (!isRecord(value))
        return null;
    const rawId = value['id'];
    const rawName = value['name'];
    const rawCmd = value['cmd'];
    const rawCwd = value['cwd'];
    const rawShellType = value['shellType'];
    const rawSshCommand = value['sshCommand'] ?? value['sshHost'];
    const rawSshOptions = value['sshOptions'];
    const rawTerminalRef = value['terminalRef'];
    const terminalPid = readFiniteNumber(value, 'terminalPid');
    const cwd = typeof rawCwd === 'string' ? rawCwd.trim() : '';
    const shellType = isShellType(rawShellType) ? rawShellType : DEFAULT_SETTINGS.defaultShell;
    const sshCommand = typeof rawSshCommand === 'string' ? rawSshCommand.trim() : '';
    if (shellType === 'ssh') {
        if (!sshCommand)
            return null;
    }
    else if (!cwd) {
        return null;
    }
    const name = typeof rawName === 'string' && rawName.trim()
        ? rawName
        : node_path_1.default.basename(cwd) || sshCommand || 'Session';
    const cmd = typeof rawCmd === 'string' ? rawCmd : '';
    const id = typeof rawId === 'string' && rawId.trim() ? rawId.trim() : undefined;
    const terminalRef = typeof rawTerminalRef === 'string' && rawTerminalRef.trim()
        ? rawTerminalRef.trim()
        : undefined;
    const sshOptions = normalizeSessionSshOptions(rawSshOptions);
    const clientMetadata = normalizeClientMetadata(value['clientMetadata']);
    const session = {
        name,
        cmd,
        cwd,
        shellType,
        ...(sshCommand ? { sshCommand } : {}),
        ...(sshOptions ? { sshOptions } : {}),
        ...(terminalRef ? { terminalRef } : {}),
        ...(terminalPid !== null ? { terminalPid } : {}),
        ...(clientMetadata ? { clientMetadata } : {}),
    };
    if (id)
        return { id, ...session };
    return session;
}
function normalizeSessionSshOptions(value) {
    if (!isRecord(value))
        return undefined;
    const host = typeof value['host'] === 'string' ? value['host'].trim() : '';
    const username = typeof value['username'] === 'string' ? value['username'].trim() : '';
    if (!host || !username)
        return undefined;
    const opts = { host, username };
    const rawPort = value['port'];
    if (typeof rawPort === 'number' && Number.isFinite(rawPort) && rawPort > 0)
        opts.port = rawPort;
    const rawKey = value['privateKeyPath'];
    if (typeof rawKey === 'string' && rawKey.trim())
        opts.privateKeyPath = rawKey.trim();
    const rawAgent = value['agent'];
    if (typeof rawAgent === 'string' && rawAgent.trim())
        opts.agent = rawAgent.trim();
    const rawInit = value['initCommand'];
    if (typeof rawInit === 'string' && rawInit.trim())
        opts.initCommand = rawInit.trim();
    return opts;
}
function normalizeClientMetadata(value) {
    if (!isRecord(value))
        return undefined;
    const kind = typeof value['kind'] === 'string' ? value['kind'].trim() : '';
    if (kind !== 'vscode')
        return undefined;
    const meta = { kind: 'vscode' };
    const workspace = value['workspace'];
    if (typeof workspace === 'string' && workspace.trim())
        meta.workspace = workspace.trim();
    const ipcHook = value['ipcHook'];
    if (typeof ipcHook === 'string' && ipcHook.trim())
        meta.ipcHook = ipcHook.trim();
    const pid = value['pid'];
    if (typeof pid === 'number' && Number.isFinite(pid) && pid > 0)
        meta.pid = pid;
    const version = value['version'];
    if (typeof version === 'string' && version.trim())
        meta.version = version.trim();
    const termProgram = value['termProgram'];
    if (typeof termProgram === 'string' && termProgram.trim())
        meta.termProgram = termProgram.trim();
    return meta;
}
function normalizeManualTask(value) {
    if (!isRecord(value))
        return null;
    const id = readTrimmedString(value, 'id');
    const text = readTrimmedString(value, 'text');
    const createdAt = readFiniteNumber(value, 'createdAt');
    if (!id || !text || createdAt === null)
        return null;
    return { id, text, createdAt };
}
function normalizeRecurringTask(value) {
    if (!isRecord(value))
        return null;
    const id = readTrimmedString(value, 'id');
    const text = readTrimmedString(value, 'text');
    const time = readTrimmedString(value, 'time');
    const createdAt = readFiniteNumber(value, 'createdAt');
    if (!id || !text || !isRecurringTime(time) || createdAt === null)
        return null;
    const frequency = normalizeRecurringFrequency(value['frequency']);
    const daysOfWeek = normalizeRecurringDays(value['daysOfWeek']);
    if (frequency === 'weekly' && daysOfWeek.length === 0)
        return null;
    const task = {
        id,
        text,
        time,
        frequency,
        daysOfWeek,
        createdAt,
        enabled: value['enabled'] !== false,
    };
    if (frequency === 'daily' && task.daysOfWeek.length === 0)
        task.daysOfWeek = [0, 1, 2, 3, 4, 5, 6];
    if (frequency === 'interval') {
        const intervalDays = normalizeRecurringIntervalDays(value['intervalDays']);
        if (intervalDays === null)
            return null;
        task.intervalDays = intervalDays;
        const anchorDate = normalizeDateKey(readTrimmedString(value, 'anchorDate')) || getLocalDateKey(new Date(createdAt));
        task.anchorDate = anchorDate;
    }
    if (frequency === 'monthly') {
        const dayOfMonth = normalizeRecurringDayOfMonth(value['dayOfMonth']);
        if (dayOfMonth === null)
            return null;
        task.dayOfMonth = dayOfMonth;
    }
    const lastGeneratedDate = readTrimmedString(value, 'lastGeneratedDate');
    const normalizedLastGeneratedDate = normalizeDateKey(lastGeneratedDate);
    if (normalizedLastGeneratedDate)
        task.lastGeneratedDate = normalizedLastGeneratedDate;
    return task;
}
function normalizeRecurringFrequency(value) {
    return value === 'daily' || value === 'interval' || value === 'monthly' ? value : 'weekly';
}
function normalizeRecurringDays(value) {
    if (!Array.isArray(value))
        return [];
    const days = value
        .filter((day) => typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6);
    return [...new Set(days)].sort((a, b) => a - b);
}
function normalizeRecurringIntervalDays(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 3650 ? value : null;
}
function normalizeRecurringDayOfMonth(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 31 ? value : null;
}
function normalizeDateKey(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
}
function getLocalDateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
function isRecurringTime(value) {
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}
function normalizeWindowState(value) {
    if (!isRecord(value))
        return null;
    const x = readFiniteNumber(value, 'x');
    const y = readFiniteNumber(value, 'y');
    const width = readFiniteNumber(value, 'width');
    const height = readFiniteNumber(value, 'height');
    const isMaximized = value['isMaximized'];
    if (x === null || y === null || width === null || height === null)
        return null;
    if (width <= 0 || height <= 0)
        return null;
    return {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
        isMaximized: typeof isMaximized === 'boolean' ? isMaximized : false,
    };
}
function normalizeSlackNotification(value) {
    if (!isRecord(value))
        return null;
    const id = readTrimmedString(value, 'id');
    const text = readTrimmedString(value, 'text') || '(no text)';
    const receivedAt = readFiniteNumber(value, 'receivedAt');
    if (!id || receivedAt === null)
        return null;
    const notification = { id, text, receivedAt };
    addOptionalSlackString(notification, 'teamId', readTrimmedString(value, 'teamId'));
    addOptionalSlackString(notification, 'teamName', readTrimmedString(value, 'teamName'));
    addOptionalSlackString(notification, 'channelId', readTrimmedString(value, 'channelId'));
    addOptionalSlackString(notification, 'channelName', readTrimmedString(value, 'channelName'));
    addOptionalSlackString(notification, 'channelType', readTrimmedString(value, 'channelType'));
    addOptionalSlackString(notification, 'userId', readTrimmedString(value, 'userId'));
    addOptionalSlackString(notification, 'userName', readTrimmedString(value, 'userName'));
    addOptionalSlackString(notification, 'ts', readTrimmedString(value, 'ts'));
    addOptionalSlackString(notification, 'threadTs', readTrimmedString(value, 'threadTs'));
    addOptionalSlackString(notification, 'permalink', readTrimmedString(value, 'permalink'));
    const messageCount = readFiniteNumber(value, 'messageCount');
    if (messageCount !== null && messageCount > 1)
        notification.messageCount = Math.floor(messageCount);
    const priorityRank = readFiniteNumber(value, 'priorityRank');
    if (priorityRank !== null)
        notification.priorityRank = Math.max(0, Math.min(4, Math.floor(priorityRank)));
    const priorityLabel = readTrimmedString(value, 'priorityLabel');
    if (isSlackNotificationPriorityLabel(priorityLabel))
        notification.priorityLabel = priorityLabel;
    return notification;
}
function normalizeGoogleCalendarAuth(value) {
    if (!isRecord(value))
        return null;
    const accessToken = readTrimmedString(value, 'accessToken');
    const refreshToken = readTrimmedString(value, 'refreshToken');
    const expiresAt = readFiniteNumber(value, 'expiresAt');
    if (!accessToken || !refreshToken || expiresAt === null)
        return null;
    const auth = { accessToken, refreshToken, expiresAt };
    const tokenType = readTrimmedString(value, 'tokenType');
    if (tokenType)
        auth.tokenType = tokenType;
    const scope = readTrimmedString(value, 'scope');
    if (scope)
        auth.scope = scope;
    return auth;
}
function normalizeGoogleCalendarConnection(value) {
    if (!isRecord(value))
        return null;
    const id = readTrimmedString(value, 'id');
    const calendarId = readTrimmedString(value, 'calendarId') || DEFAULT_SETTINGS.googleCalendar.calendarId;
    const lookAheadDays = readFiniteNumber(value, 'lookAheadDays');
    const connectedAt = readFiniteNumber(value, 'connectedAt');
    const auth = normalizeGoogleCalendarAuth(value['auth']);
    if (!id || connectedAt === null || !auth)
        return null;
    const connection = {
        id,
        calendarId,
        lookAheadDays: lookAheadDays !== null
            ? Math.max(1, Math.min(365, Math.floor(lookAheadDays)))
            : DEFAULT_SETTINGS.googleCalendar.lookAheadDays,
        enabled: value['enabled'] !== false,
        connectedAt,
        auth,
    };
    const accountEmail = readTrimmedString(value, 'accountEmail');
    if (accountEmail)
        connection.accountEmail = accountEmail;
    const accountName = readTrimmedString(value, 'accountName');
    if (accountName)
        connection.accountName = accountName;
    const lastSyncedAt = readFiniteNumber(value, 'lastSyncedAt');
    if (lastSyncedAt !== null)
        connection.lastSyncedAt = lastSyncedAt;
    const authError = readTrimmedString(value, 'authError');
    if (authError)
        connection.authError = authError;
    return connection;
}
function normalizeGoogleCalendarEvent(value) {
    if (!isRecord(value))
        return null;
    const id = readTrimmedString(value, 'id');
    const connectionId = readTrimmedString(value, 'connectionId');
    const calendarId = readTrimmedString(value, 'calendarId');
    const summary = readTrimmedString(value, 'summary') || '(no title)';
    const start = readTrimmedString(value, 'start');
    const end = readTrimmedString(value, 'end');
    const startMs = readFiniteNumber(value, 'startMs');
    const endMs = readFiniteNumber(value, 'endMs');
    if (!id || !connectionId || !calendarId || !start || !end || startMs === null || endMs === null)
        return null;
    const event = {
        id,
        connectionId,
        calendarId,
        summary,
        start,
        end,
        startMs,
        endMs,
        allDay: value['allDay'] === true,
    };
    const accountEmail = readTrimmedString(value, 'accountEmail');
    if (accountEmail)
        event.accountEmail = accountEmail;
    const accountName = readTrimmedString(value, 'accountName');
    if (accountName)
        event.accountName = accountName;
    const htmlLink = readTrimmedString(value, 'htmlLink');
    if (htmlLink)
        event.htmlLink = htmlLink;
    const location = readTrimmedString(value, 'location');
    if (location)
        event.location = location;
    const updated = readTrimmedString(value, 'updated');
    if (updated)
        event.updated = updated;
    return event;
}
function isSlackNotificationPriorityLabel(value) {
    return value === 'mention' ||
        value === 'dm' ||
        value === 'thread_mention' ||
        value === 'thread_written' ||
        value === 'other';
}
function readFiniteNumber(record, key) {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function readTrimmedString(record, key) {
    const value = record[key];
    return typeof value === 'string' ? value.trim() : '';
}
function addOptionalSlackString(notification, key, value) {
    if (value)
        notification[key] = value;
}
function getSettingsPath() {
    return node_path_1.default.join(getStorageDirectory(), 'settings.json');
}
function getSessionsPath() {
    return node_path_1.default.join(getStorageDirectory(), 'sessions.json');
}
function getWindowStatePath() {
    return node_path_1.default.join(getStorageDirectory(), 'window-state.json');
}
function getSlackNotificationsPath() {
    return node_path_1.default.join(getStorageDirectory(), 'slack-notifications.json');
}
function getManualTasksPath() {
    return node_path_1.default.join(getStorageDirectory(), 'manual-tasks.json');
}
function getRecurringTasksPath() {
    return node_path_1.default.join(getStorageDirectory(), 'recurring-tasks.json');
}
function getGoogleCalendarAuthPath() {
    return node_path_1.default.join(getStorageDirectory(), 'google-calendar-auth.json');
}
function getGoogleCalendarConnectionsPath() {
    return node_path_1.default.join(getStorageDirectory(), 'google-calendar-connections.json');
}
function getGoogleCalendarEventsPath() {
    return node_path_1.default.join(getStorageDirectory(), 'google-calendar-events.json');
}
function getStorageDirectory() {
    return storageDirectoryOverride ||
        process.env[DATA_DIR_ENV]?.trim() ||
        node_path_1.default.join(process.cwd(), '.multitasker-data');
}
function writeJsonFile(filePath, value) {
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(filePath), { recursive: true });
    node_fs_1.default.writeFileSync(filePath, JSON.stringify(value, null, 2));
}
function deleteJsonFile(filePath) {
    try {
        node_fs_1.default.rmSync(filePath, { force: true });
    }
    catch {
        // Best-effort cleanup; the next save will recreate the file.
    }
}
function loadSettings() {
    try {
        const raw = node_fs_1.default.readFileSync(getSettingsPath(), 'utf-8');
        return normalizeSettings(JSON.parse(raw));
    }
    catch {
        return getDefaultSettings();
    }
}
function saveSettings(settings) {
    writeJsonFile(getSettingsPath(), normalizeSettings(settings));
}
function loadSessions() {
    try {
        const raw = node_fs_1.default.readFileSync(getSessionsPath(), 'utf-8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        return parsed
            .map(normalizeSessionState)
            .filter((session) => session !== null);
    }
    catch {
        return [];
    }
}
function saveSessions(sessions) {
    writeJsonFile(getSessionsPath(), sessions);
}
function loadManualTasks() {
    try {
        const raw = node_fs_1.default.readFileSync(getManualTasksPath(), 'utf-8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        return parsed
            .map(normalizeManualTask)
            .filter((task) => task !== null);
    }
    catch {
        return [];
    }
}
function saveManualTasks(tasks) {
    writeJsonFile(getManualTasksPath(), tasks.map(normalizeManualTask).filter(Boolean));
}
function loadRecurringTasks() {
    try {
        const raw = node_fs_1.default.readFileSync(getRecurringTasksPath(), 'utf-8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        return parsed
            .map(normalizeRecurringTask)
            .filter((task) => task !== null);
    }
    catch {
        return [];
    }
}
function saveRecurringTasks(tasks) {
    writeJsonFile(getRecurringTasksPath(), tasks.map(normalizeRecurringTask).filter(Boolean));
}
function loadSlackNotifications() {
    try {
        const raw = node_fs_1.default.readFileSync(getSlackNotificationsPath(), 'utf-8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        return parsed
            .map(normalizeSlackNotification)
            .filter((notification) => notification !== null);
    }
    catch {
        return [];
    }
}
function saveSlackNotifications(notifications) {
    writeJsonFile(getSlackNotificationsPath(), notifications.map(normalizeSlackNotification).filter(Boolean));
}
function loadGoogleCalendarAuth() {
    try {
        const raw = node_fs_1.default.readFileSync(getGoogleCalendarAuthPath(), 'utf-8');
        return normalizeGoogleCalendarAuth(JSON.parse(raw));
    }
    catch {
        return null;
    }
}
function saveGoogleCalendarAuth(auth) {
    writeJsonFile(getGoogleCalendarAuthPath(), normalizeGoogleCalendarAuth(auth));
}
function clearGoogleCalendarAuth() {
    deleteJsonFile(getGoogleCalendarAuthPath());
}
function loadGoogleCalendarConnections() {
    try {
        const raw = node_fs_1.default.readFileSync(getGoogleCalendarConnectionsPath(), 'utf-8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        return parsed
            .map(normalizeGoogleCalendarConnection)
            .filter((connection) => connection !== null);
    }
    catch {
        const legacyAuth = loadGoogleCalendarAuth();
        if (!legacyAuth)
            return [];
        const settings = loadSettings().googleCalendar;
        return [{
                id: 'legacy-primary',
                calendarId: settings.calendarId,
                lookAheadDays: settings.lookAheadDays,
                enabled: true,
                connectedAt: Date.now(),
                auth: legacyAuth,
            }];
    }
}
function saveGoogleCalendarConnections(connections) {
    writeJsonFile(getGoogleCalendarConnectionsPath(), connections.map(normalizeGoogleCalendarConnection).filter(Boolean));
}
function clearGoogleCalendarConnections() {
    deleteJsonFile(getGoogleCalendarConnectionsPath());
}
function loadGoogleCalendarEvents() {
    try {
        const raw = node_fs_1.default.readFileSync(getGoogleCalendarEventsPath(), 'utf-8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        return parsed
            .map(normalizeGoogleCalendarEvent)
            .filter((event) => event !== null);
    }
    catch {
        return [];
    }
}
function saveGoogleCalendarEvents(events) {
    writeJsonFile(getGoogleCalendarEventsPath(), events.map(normalizeGoogleCalendarEvent).filter(Boolean));
}
function clearGoogleCalendarEvents() {
    deleteJsonFile(getGoogleCalendarEventsPath());
}
function loadWindowState() {
    try {
        const raw = node_fs_1.default.readFileSync(getWindowStatePath(), 'utf-8');
        return normalizeWindowState(JSON.parse(raw));
    }
    catch {
        return null;
    }
}
function saveWindowState(state) {
    writeJsonFile(getWindowStatePath(), normalizeWindowState(state));
}
