import fs from 'node:fs';
import path from 'node:path';

export type LocalShellType = 'powershell' | 'bash';
export type ShellType = LocalShellType | 'ssh';

export interface AppSettings {
  reviewTool: string;
  defaultShell: LocalShellType;
  googleCalendar: GoogleCalendarSettings;
  githubReview: GitHubReviewSettings;
}

export interface GoogleCalendarSettings {
  calendarId: string;
  lookAheadDays: number;
  enabled: boolean;
  ownedCalendarsOnly: boolean;
}

export interface GitHubReviewSettings {
  enabled: boolean;
  owner: string;
  repo: string;
  pollMinutes: number;
}

export interface GoogleCalendarAuthState {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  tokenType?: string;
  scope?: string;
}

export interface GoogleCalendarConnectionState {
  id: string;
  accountEmail?: string;
  accountName?: string;
  calendarId: string;
  lookAheadDays: number;
  enabled: boolean;
  connectedAt: number;
  lastSyncedAt?: number;
  authError?: string;
  auth: GoogleCalendarAuthState;
}

export interface GoogleCalendarEventState {
  id: string;
  connectionId: string;
  accountEmail?: string;
  accountName?: string;
  calendarId: string;
  summary: string;
  start: string;
  end: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  htmlLink?: string;
  location?: string;
  updated?: string;
}

export interface SessionSshOptions {
  host: string;
  username: string;
  port?: number;
  privateKeyPath?: string;
  agent?: string;
  initCommand?: string;
}

export interface SessionState {
  id?: string;
  name: string;
  cmd: string;
  cwd: string;
  shellType: ShellType;
  sshCommand?: string;
  sshOptions?: SessionSshOptions;
  terminalRef?: string;
  terminalPid?: number;
  clientMetadata?: PersistedClientMetadata;
  status?: 'waiting' | 'starting' | 'running' | 'needs_attention' | 'error' | 'stopped' | 'detached';
}

export type PersistedClientMetadata = {
  kind: 'vscode';
  workspace?: string;
  ipcHook?: string;
  pid?: number;
  version?: string;
  termProgram?: string;
};

export interface ManualTaskState {
  id: string;
  text: string;
  createdAt: number;
  priority?: number;
}

export type RecurringTaskFrequency = 'weekly' | 'daily' | 'interval' | 'monthly';

export interface RecurringTaskState {
  id: string;
  text: string;
  time: string;
  frequency: RecurringTaskFrequency;
  daysOfWeek: number[];
  intervalDays?: number;
  dayOfMonth?: number;
  anchorDate?: string;
  createdAt: number;
  priority?: number;
  enabled: boolean;
  lastGeneratedDate?: string;
}

export interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

export type SlackNotificationPriorityLabel = 'mention' | 'dm' | 'thread_mention' | 'thread_written' | 'other';

export interface SlackNotificationState {
  id: string;
  teamId?: string;
  teamName?: string;
  channelId?: string;
  channelName?: string;
  channelType?: string;
  userId?: string;
  userName?: string;
  text: string;
  ts?: string;
  threadTs?: string;
  permalink?: string;
  receivedAt: number;
  messageCount?: number;
  priorityRank?: number;
  priorityLabel?: SlackNotificationPriorityLabel;
}

const DEFAULT_SETTINGS: AppSettings = {
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

export function setStorageDirectory(directory: string): void {
  storageDirectoryOverride = directory.trim();
}

function isLocalShellType(value: unknown): value is LocalShellType {
  return value === 'powershell' || value === 'bash';
}

function isShellType(value: unknown): value is ShellType {
  return isLocalShellType(value) || value === 'ssh';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeSettings(value: unknown): AppSettings {
  if (!isRecord(value)) return getDefaultSettings();
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

function getDefaultSettings(): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    googleCalendar: { ...DEFAULT_SETTINGS.googleCalendar },
  };
}

function normalizeGoogleCalendarSettings(value: unknown): GoogleCalendarSettings {
  if (!isRecord(value)) return { ...DEFAULT_SETTINGS.googleCalendar };

  const calendarId = readTrimmedString(value, 'calendarId') || DEFAULT_SETTINGS.googleCalendar.calendarId;
  const lookAheadDays = readFiniteNumber(value, 'lookAheadDays');
  const settings: GoogleCalendarSettings = {
    calendarId,
    lookAheadDays: lookAheadDays !== null
      ? Math.max(1, Math.min(365, Math.floor(lookAheadDays)))
      : DEFAULT_SETTINGS.googleCalendar.lookAheadDays,
    enabled: value['enabled'] === true,
    ownedCalendarsOnly: value['ownedCalendarsOnly'] !== false,
  };
  return settings;
}

function normalizeGitHubReviewSettings(value: unknown): GitHubReviewSettings {
  if (!isRecord(value)) return { ...DEFAULT_SETTINGS.githubReview };
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

function normalizeSessionState(value: unknown): SessionState | null {
  if (!isRecord(value)) return null;

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
    if (!sshCommand) return null;
  } else if (!cwd) {
    return null;
  }

  const name = typeof rawName === 'string' && rawName.trim()
    ? rawName
    : path.basename(cwd) || sshCommand || 'Session';
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

  if (id) return { id, ...session };
  return session;
}

function normalizeSessionSshOptions(value: unknown): SessionSshOptions | undefined {
  if (!isRecord(value)) return undefined;
  const host = typeof value['host'] === 'string' ? value['host'].trim() : '';
  const username = typeof value['username'] === 'string' ? value['username'].trim() : '';
  if (!host || !username) return undefined;
  const opts: SessionSshOptions = { host, username };
  const rawPort = value['port'];
  if (typeof rawPort === 'number' && Number.isFinite(rawPort) && rawPort > 0) opts.port = rawPort;
  const rawKey = value['privateKeyPath'];
  if (typeof rawKey === 'string' && rawKey.trim()) opts.privateKeyPath = rawKey.trim();
  const rawAgent = value['agent'];
  if (typeof rawAgent === 'string' && rawAgent.trim()) opts.agent = rawAgent.trim();
  const rawInit = value['initCommand'];
  if (typeof rawInit === 'string' && rawInit.trim()) opts.initCommand = rawInit.trim();
  return opts;
}

export function normalizeClientMetadata(value: unknown): PersistedClientMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const kind = typeof value['kind'] === 'string' ? value['kind'].trim() : '';
  if (kind !== 'vscode') return undefined;
  const meta: PersistedClientMetadata = { kind: 'vscode' };
  const workspace = value['workspace'];
  if (typeof workspace === 'string' && workspace.trim()) meta.workspace = workspace.trim();
  const ipcHook = value['ipcHook'];
  if (typeof ipcHook === 'string' && ipcHook.trim()) meta.ipcHook = ipcHook.trim();
  const pid = value['pid'];
  if (typeof pid === 'number' && Number.isFinite(pid) && pid > 0) meta.pid = pid;
  const version = value['version'];
  if (typeof version === 'string' && version.trim()) meta.version = version.trim();
  const termProgram = value['termProgram'];
  if (typeof termProgram === 'string' && termProgram.trim()) meta.termProgram = termProgram.trim();
  return meta;
}

function normalizeManualTask(value: unknown): ManualTaskState | null {
  if (!isRecord(value)) return null;

  const id = readTrimmedString(value, 'id');
  const text = readTrimmedString(value, 'text');
  const createdAt = readFiniteNumber(value, 'createdAt');
  if (!id || !text || createdAt === null) return null;

  const task: ManualTaskState = { id, text, createdAt };
  const priority = normalizeTaskPriority(value['priority'] ?? value['priorityRank']);
  if (priority !== undefined) task.priority = priority;
  return task;
}

function normalizeRecurringTask(value: unknown): RecurringTaskState | null {
  if (!isRecord(value)) return null;

  const id = readTrimmedString(value, 'id');
  const text = readTrimmedString(value, 'text');
  const time = readTrimmedString(value, 'time');
  const createdAt = readFiniteNumber(value, 'createdAt');
  if (!id || !text || !isRecurringTime(time) || createdAt === null) return null;

  const frequency = normalizeRecurringFrequency(value['frequency']);
  const daysOfWeek = normalizeRecurringDays(value['daysOfWeek']);
  if (frequency === 'weekly' && daysOfWeek.length === 0) return null;

  const task: RecurringTaskState = {
    id,
    text,
    time,
    frequency,
    daysOfWeek,
    createdAt,
    enabled: value['enabled'] !== false,
  };
  const priority = normalizeTaskPriority(value['priority'] ?? value['priorityRank']);
  if (priority !== undefined) task.priority = priority;
  if (frequency === 'daily' && task.daysOfWeek.length === 0) task.daysOfWeek = [0, 1, 2, 3, 4, 5, 6];

  if (frequency === 'interval') {
    const intervalDays = normalizeRecurringIntervalDays(value['intervalDays']);
    if (intervalDays === null) return null;
    task.intervalDays = intervalDays;
    const anchorDate = normalizeDateKey(readTrimmedString(value, 'anchorDate')) || getLocalDateKey(new Date(createdAt));
    task.anchorDate = anchorDate;
  }

  if (frequency === 'monthly') {
    const dayOfMonth = normalizeRecurringDayOfMonth(value['dayOfMonth']);
    if (dayOfMonth === null) return null;
    task.dayOfMonth = dayOfMonth;
  }

  const lastGeneratedDate = readTrimmedString(value, 'lastGeneratedDate');
  const normalizedLastGeneratedDate = normalizeDateKey(lastGeneratedDate);
  if (normalizedLastGeneratedDate) task.lastGeneratedDate = normalizedLastGeneratedDate;
  return task;
}

function normalizeRecurringFrequency(value: unknown): RecurringTaskFrequency {
  return value === 'daily' || value === 'interval' || value === 'monthly' ? value : 'weekly';
}

function normalizeRecurringDays(value: unknown): number[] {
  if (!Array.isArray(value)) return [];

  const days = value
    .filter((day): day is number => typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6);
  return [...new Set(days)].sort((a, b) => a - b);
}

function normalizeRecurringIntervalDays(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 3650 ? value : null;
}

function normalizeRecurringDayOfMonth(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 31 ? value : null;
}

function normalizeDateKey(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
}

function getLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isRecurringTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function normalizeTaskPriority(value: unknown): number | undefined {
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeWindowState(value: unknown): WindowState | null {
  if (!isRecord(value)) return null;
  const x = readFiniteNumber(value, 'x');
  const y = readFiniteNumber(value, 'y');
  const width = readFiniteNumber(value, 'width');
  const height = readFiniteNumber(value, 'height');
  const isMaximized = value['isMaximized'];

  if (x === null || y === null || width === null || height === null) return null;
  if (width <= 0 || height <= 0) return null;

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
    isMaximized: typeof isMaximized === 'boolean' ? isMaximized : false,
  };
}

export function normalizeSlackNotification(value: unknown): SlackNotificationState | null {
  if (!isRecord(value)) return null;

  const id = readTrimmedString(value, 'id');
  const text = readTrimmedString(value, 'text') || '(no text)';
  const receivedAt = readFiniteNumber(value, 'receivedAt');
  if (!id || receivedAt === null) return null;

  const notification: SlackNotificationState = { id, text, receivedAt };
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
  if (messageCount !== null && messageCount > 1) notification.messageCount = Math.floor(messageCount);
  const priorityRank = readFiniteNumber(value, 'priorityRank');
  if (priorityRank !== null) notification.priorityRank = Math.max(0, Math.min(4, Math.floor(priorityRank)));
  const priorityLabel = readTrimmedString(value, 'priorityLabel');
  if (isSlackNotificationPriorityLabel(priorityLabel)) notification.priorityLabel = priorityLabel;
  return notification;
}

function normalizeGoogleCalendarAuth(value: unknown): GoogleCalendarAuthState | null {
  if (!isRecord(value)) return null;

  const accessToken = readTrimmedString(value, 'accessToken');
  const refreshToken = readTrimmedString(value, 'refreshToken');
  const expiresAt = readFiniteNumber(value, 'expiresAt');
  if (!accessToken || !refreshToken || expiresAt === null) return null;

  const auth: GoogleCalendarAuthState = { accessToken, refreshToken, expiresAt };
  const tokenType = readTrimmedString(value, 'tokenType');
  if (tokenType) auth.tokenType = tokenType;
  const scope = readTrimmedString(value, 'scope');
  if (scope) auth.scope = scope;
  return auth;
}

function normalizeGoogleCalendarConnection(value: unknown): GoogleCalendarConnectionState | null {
  if (!isRecord(value)) return null;

  const id = readTrimmedString(value, 'id');
  const calendarId = readTrimmedString(value, 'calendarId') || DEFAULT_SETTINGS.googleCalendar.calendarId;
  const lookAheadDays = readFiniteNumber(value, 'lookAheadDays');
  const connectedAt = readFiniteNumber(value, 'connectedAt');
  const auth = normalizeGoogleCalendarAuth(value['auth']);
  if (!id || connectedAt === null || !auth) return null;

  const connection: GoogleCalendarConnectionState = {
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
  if (accountEmail) connection.accountEmail = accountEmail;
  const accountName = readTrimmedString(value, 'accountName');
  if (accountName) connection.accountName = accountName;
  const lastSyncedAt = readFiniteNumber(value, 'lastSyncedAt');
  if (lastSyncedAt !== null) connection.lastSyncedAt = lastSyncedAt;
  const authError = readTrimmedString(value, 'authError');
  if (authError) connection.authError = authError;
  return connection;
}

function normalizeGoogleCalendarEvent(value: unknown): GoogleCalendarEventState | null {
  if (!isRecord(value)) return null;

  const id = readTrimmedString(value, 'id');
  const connectionId = readTrimmedString(value, 'connectionId');
  const calendarId = readTrimmedString(value, 'calendarId');
  const summary = readTrimmedString(value, 'summary') || '(no title)';
  const start = readTrimmedString(value, 'start');
  const end = readTrimmedString(value, 'end');
  const startMs = readFiniteNumber(value, 'startMs');
  const endMs = readFiniteNumber(value, 'endMs');
  if (!id || !connectionId || !calendarId || !start || !end || startMs === null || endMs === null) return null;

  const event: GoogleCalendarEventState = {
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
  if (accountEmail) event.accountEmail = accountEmail;
  const accountName = readTrimmedString(value, 'accountName');
  if (accountName) event.accountName = accountName;
  const htmlLink = readTrimmedString(value, 'htmlLink');
  if (htmlLink) event.htmlLink = htmlLink;
  const location = readTrimmedString(value, 'location');
  if (location) event.location = location;
  const updated = readTrimmedString(value, 'updated');
  if (updated) event.updated = updated;
  return event;
}

function isSlackNotificationPriorityLabel(value: string): value is SlackNotificationPriorityLabel {
  return value === 'mention' ||
    value === 'dm' ||
    value === 'thread_mention' ||
    value === 'thread_written' ||
    value === 'other';
}

function readFiniteNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readTrimmedString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}

function addOptionalSlackString(
  notification: SlackNotificationState,
  key: Exclude<keyof SlackNotificationState, 'id' | 'text' | 'receivedAt' | 'messageCount' | 'priorityRank' | 'priorityLabel'>,
  value: string
): void {
  if (value) notification[key] = value;
}

function getSettingsPath(): string {
  return path.join(getStorageDirectory(), 'settings.json');
}

function getSessionsPath(): string {
  return path.join(getStorageDirectory(), 'sessions.json');
}

function getWindowStatePath(): string {
  return path.join(getStorageDirectory(), 'window-state.json');
}

function getSlackNotificationsPath(): string {
  return path.join(getStorageDirectory(), 'slack-notifications.json');
}

function getManualTasksPath(): string {
  return path.join(getStorageDirectory(), 'manual-tasks.json');
}

function getRecurringTasksPath(): string {
  return path.join(getStorageDirectory(), 'recurring-tasks.json');
}

function getGoogleCalendarAuthPath(): string {
  return path.join(getStorageDirectory(), 'google-calendar-auth.json');
}

function getGoogleCalendarConnectionsPath(): string {
  return path.join(getStorageDirectory(), 'google-calendar-connections.json');
}

function getGoogleCalendarEventsPath(): string {
  return path.join(getStorageDirectory(), 'google-calendar-events.json');
}

function getStorageDirectory(): string {
  return storageDirectoryOverride ||
    process.env[DATA_DIR_ENV]?.trim() ||
    path.join(process.cwd(), '.multitasker-data');
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function deleteJsonFile(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Best-effort cleanup; the next save will recreate the file.
  }
}

export function loadSettings(): AppSettings {
  try {
    const raw = fs.readFileSync(getSettingsPath(), 'utf-8');
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return getDefaultSettings();
  }
}

export function saveSettings(settings: AppSettings): void {
  writeJsonFile(getSettingsPath(), normalizeSettings(settings));
}

export function loadSessions(): SessionState[] {
  try {
    const raw = fs.readFileSync(getSessionsPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeSessionState)
      .filter((session): session is SessionState => session !== null);
  } catch {
    return [];
  }
}

export function saveSessions(sessions: SessionState[]): void {
  writeJsonFile(getSessionsPath(), sessions);
}

export function loadManualTasks(): ManualTaskState[] {
  try {
    const raw = fs.readFileSync(getManualTasksPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeManualTask)
      .filter((task): task is ManualTaskState => task !== null);
  } catch {
    return [];
  }
}

export function saveManualTasks(tasks: ManualTaskState[]): void {
  writeJsonFile(getManualTasksPath(), tasks.map(normalizeManualTask).filter(Boolean));
}

export function loadRecurringTasks(): RecurringTaskState[] {
  try {
    const raw = fs.readFileSync(getRecurringTasksPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeRecurringTask)
      .filter((task): task is RecurringTaskState => task !== null);
  } catch {
    return [];
  }
}

export function saveRecurringTasks(tasks: RecurringTaskState[]): void {
  writeJsonFile(getRecurringTasksPath(), tasks.map(normalizeRecurringTask).filter(Boolean));
}

export function loadSlackNotifications(): SlackNotificationState[] {
  try {
    const raw = fs.readFileSync(getSlackNotificationsPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeSlackNotification)
      .filter((notification): notification is SlackNotificationState => notification !== null);
  } catch {
    return [];
  }
}

export function saveSlackNotifications(notifications: SlackNotificationState[]): void {
  writeJsonFile(getSlackNotificationsPath(), notifications.map(normalizeSlackNotification).filter(Boolean));
}

export function loadGoogleCalendarAuth(): GoogleCalendarAuthState | null {
  try {
    const raw = fs.readFileSync(getGoogleCalendarAuthPath(), 'utf-8');
    return normalizeGoogleCalendarAuth(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveGoogleCalendarAuth(auth: GoogleCalendarAuthState): void {
  writeJsonFile(getGoogleCalendarAuthPath(), normalizeGoogleCalendarAuth(auth));
}

export function clearGoogleCalendarAuth(): void {
  deleteJsonFile(getGoogleCalendarAuthPath());
}

export function loadGoogleCalendarConnections(): GoogleCalendarConnectionState[] {
  try {
    const raw = fs.readFileSync(getGoogleCalendarConnectionsPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeGoogleCalendarConnection)
      .filter((connection): connection is GoogleCalendarConnectionState => connection !== null);
  } catch {
    const legacyAuth = loadGoogleCalendarAuth();
    if (!legacyAuth) return [];
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

export function saveGoogleCalendarConnections(connections: GoogleCalendarConnectionState[]): void {
  writeJsonFile(getGoogleCalendarConnectionsPath(), connections.map(normalizeGoogleCalendarConnection).filter(Boolean));
}

export function clearGoogleCalendarConnections(): void {
  deleteJsonFile(getGoogleCalendarConnectionsPath());
}

export function loadGoogleCalendarEvents(): GoogleCalendarEventState[] {
  try {
    const raw = fs.readFileSync(getGoogleCalendarEventsPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeGoogleCalendarEvent)
      .filter((event): event is GoogleCalendarEventState => event !== null);
  } catch {
    return [];
  }
}

export function saveGoogleCalendarEvents(events: GoogleCalendarEventState[]): void {
  writeJsonFile(getGoogleCalendarEventsPath(), events.map(normalizeGoogleCalendarEvent).filter(Boolean));
}

export function clearGoogleCalendarEvents(): void {
  deleteJsonFile(getGoogleCalendarEventsPath());
}

export function loadWindowState(): WindowState | null {
  try {
    const raw = fs.readFileSync(getWindowStatePath(), 'utf-8');
    return normalizeWindowState(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveWindowState(state: WindowState): void {
  writeJsonFile(getWindowStatePath(), normalizeWindowState(state));
}
