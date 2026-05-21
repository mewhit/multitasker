import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export type LocalShellType = 'powershell' | 'bash';
export type ShellType = LocalShellType | 'ssh';

export interface AppSettings {
  reviewTool: string;
  defaultShell: LocalShellType;
}

export interface SessionState {
  id?: string;
  name: string;
  cmd: string;
  cwd: string;
  shellType: ShellType;
  sshCommand?: string;
  vscodeWindowId?: string;
  terminalRef?: string;
  terminalPid?: number;
}

export interface ManualTaskState {
  id: string;
  text: string;
  createdAt: number;
}

export interface RecurringTaskState {
  id: string;
  text: string;
  time: string;
  daysOfWeek: number[];
  createdAt: number;
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
};

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
  if (!isRecord(value)) return { ...DEFAULT_SETTINGS };
  const rawReviewTool = value['reviewTool'];
  const rawDefaultShell = value['defaultShell'];
  const reviewTool = typeof rawReviewTool === 'string' && rawReviewTool.trim()
    ? rawReviewTool
    : DEFAULT_SETTINGS.reviewTool;
  const defaultShell = isLocalShellType(rawDefaultShell)
    ? rawDefaultShell
    : DEFAULT_SETTINGS.defaultShell;
  return { reviewTool, defaultShell };
}

function normalizeSessionState(value: unknown): SessionState | null {
  if (!isRecord(value)) return null;

  const rawId = value['id'];
  const rawName = value['name'];
  const rawCmd = value['cmd'];
  const rawCwd = value['cwd'];
  const rawShellType = value['shellType'];
  const rawSshCommand = value['sshCommand'] ?? value['sshHost'];
  const rawVsCodeWindowId = value['vscodeWindowId'];
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
  const vscodeWindowId = typeof rawVsCodeWindowId === 'string' && rawVsCodeWindowId.trim()
    ? rawVsCodeWindowId.trim()
    : undefined;
  const terminalRef = typeof rawTerminalRef === 'string' && rawTerminalRef.trim()
    ? rawTerminalRef.trim()
    : undefined;
  const session = {
    name,
    cmd,
    cwd,
    shellType,
    ...(sshCommand ? { sshCommand } : {}),
    ...(vscodeWindowId ? { vscodeWindowId } : {}),
    ...(terminalRef ? { terminalRef } : {}),
    ...(terminalPid !== null ? { terminalPid } : {}),
  };

  if (id) return { id, ...session };
  return session;
}

function normalizeManualTask(value: unknown): ManualTaskState | null {
  if (!isRecord(value)) return null;

  const id = readTrimmedString(value, 'id');
  const text = readTrimmedString(value, 'text');
  const createdAt = readFiniteNumber(value, 'createdAt');
  if (!id || !text || createdAt === null) return null;

  return { id, text, createdAt };
}

function normalizeRecurringTask(value: unknown): RecurringTaskState | null {
  if (!isRecord(value)) return null;

  const id = readTrimmedString(value, 'id');
  const text = readTrimmedString(value, 'text');
  const time = readTrimmedString(value, 'time');
  const createdAt = readFiniteNumber(value, 'createdAt');
  const daysOfWeek = normalizeRecurringDays(value['daysOfWeek']);
  if (!id || !text || !isRecurringTime(time) || daysOfWeek.length === 0 || createdAt === null) return null;

  const task: RecurringTaskState = {
    id,
    text,
    time,
    daysOfWeek,
    createdAt,
    enabled: value['enabled'] !== false,
  };
  const lastGeneratedDate = readTrimmedString(value, 'lastGeneratedDate');
  if (/^\d{4}-\d{2}-\d{2}$/.test(lastGeneratedDate)) task.lastGeneratedDate = lastGeneratedDate;
  return task;
}

function normalizeRecurringDays(value: unknown): number[] {
  if (!Array.isArray(value)) return [];

  const days = value
    .filter((day): day is number => typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6);
  return [...new Set(days)].sort((a, b) => a - b);
}

function isRecurringTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
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

function normalizeSlackNotification(value: unknown): SlackNotificationState | null {
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
  return path.join(app.getPath('userData'), 'settings.json');
}

function getSessionsPath(): string {
  return path.join(app.getPath('userData'), 'sessions.json');
}

function getWindowStatePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function getSlackNotificationsPath(): string {
  return path.join(app.getPath('userData'), 'slack-notifications.json');
}

function getManualTasksPath(): string {
  return path.join(app.getPath('userData'), 'manual-tasks.json');
}

function getRecurringTasksPath(): string {
  return path.join(app.getPath('userData'), 'recurring-tasks.json');
}

export function loadSettings(): AppSettings {
  try {
    const raw = fs.readFileSync(getSettingsPath(), 'utf-8');
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AppSettings): void {
  fs.writeFileSync(getSettingsPath(), JSON.stringify(normalizeSettings(settings), null, 2));
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
  fs.writeFileSync(getSessionsPath(), JSON.stringify(sessions, null, 2));
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
  fs.writeFileSync(
    getManualTasksPath(),
    JSON.stringify(tasks.map(normalizeManualTask).filter(Boolean), null, 2)
  );
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
  fs.writeFileSync(
    getRecurringTasksPath(),
    JSON.stringify(tasks.map(normalizeRecurringTask).filter(Boolean), null, 2)
  );
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
  fs.writeFileSync(
    getSlackNotificationsPath(),
    JSON.stringify(notifications.map(normalizeSlackNotification).filter(Boolean), null, 2)
  );
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
  fs.writeFileSync(getWindowStatePath(), JSON.stringify(normalizeWindowState(state), null, 2));
}
