import { contextBridge, ipcRenderer } from 'electron';
import type { NextUpItem } from '../../../shared/next-up';

export type LocalShellType = 'powershell' | 'bash';
export type ShellType = LocalShellType | 'ssh';
export type TerminalCaptureState = 'waiting_for_execution' | 'capturing' | 'unavailable';

export interface Session {
  id: string;
  name: string;
  cmd: string;
  cwd: string;
  shellType: ShellType;
  sshCommand?: string;
  status: 'waiting' | 'starting' | 'running' | 'needs_attention' | 'paused' | 'error' | 'stopped' | 'detached';
  lastActivity: number;
  gitChanges: boolean;
  terminalExitCode?: number;
  terminalExitReason?: string;
  terminalRef?: string;
  terminalPid?: number;
  terminalCaptureState?: TerminalCaptureState;
  terminalCaptureReason?: string;
}

export interface AppSettings {
  reviewTool: string;
  defaultShell: LocalShellType;
  googleCalendar: GoogleCalendarSettings;
  githubReview: GitHubReviewSettings;
  installedPlugins: PluginId[];
}

export type PluginId = 'ai';

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

export interface GoogleCalendarEvent {
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

export interface GoogleCalendarStatus {
  connected: boolean;
  configured: boolean;
  enabled: boolean;
  calendarId: string;
  lookAheadDays: number;
  ownedCalendarsOnly: boolean;
  accountCount: number;
  eventCount: number;
  lastSyncedAt?: number;
  message: string;
  connections: GoogleCalendarConnectionStatus[];
}

export interface GoogleCalendarConnectionStatus {
  id: string;
  accountEmail?: string;
  accountName?: string;
  calendarId: string;
  lookAheadDays: number;
  enabled: boolean;
  connectedAt: number;
  lastSyncedAt?: number;
  authError?: string;
}

export interface GoogleCalendarAuthResult {
  ok: boolean;
  message: string;
  status: GoogleCalendarStatus;
}

export interface SlackAuthStatus {
  ok: boolean;
  message: string;
}

export interface SlackWorkspaceSummary {
  teamId: string;
  teamName: string;
  userId: string;
  botScopes: string[];
  userScopes: string[];
  connectedAt: number;
}

export interface JiraSiteStatus {
  cloudId: string;
  name: string;
  url: string;
}

export interface JiraStatus {
  configured: boolean;
  connected: boolean;
  site: JiraSiteStatus | null;
  preferredSiteUrl: string;
  jql: string;
  pollMinutes: number;
  trackedIssueCount: number;
  lastPolledAt?: number;
  lastError?: string;
}

export interface JiraActionResult {
  ok: boolean;
  message: string;
  status: JiraStatus;
}

export interface GitHubAccountStatus {
  login: string;
  avatarUrl: string;
  profileUrl: string;
}

export interface GitHubStatus {
  configured: boolean;
  oauthConfigured: boolean;
  connected: boolean;
  authMode: 'oauth' | 'token' | null;
  account: GitHubAccountStatus | null;
  pollMinutes: number;
  trackedReviewRequestCount: number;
  lastPolledAt?: number;
  lastError?: string;
}

export interface GitHubActionResult {
  ok: boolean;
  message: string;
  status: GitHubStatus;
}

export interface TerminalClipboardPaste {
  source: 'image' | 'text' | 'empty';
  text: string;
  filePath?: string;
}

export interface SessionState {
  id?: string;
  name: string;
  cmd: string;
  cwd: string;
  shellType: ShellType;
  sshCommand?: string;
  terminalRef?: string;
  terminalPid?: number;
}

export interface ManualTask {
  id: string;
  text: string;
  createdAt: number;
  priority?: number;
}

export interface SlackNotification {
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
  priorityLabel?: 'mention' | 'dm' | 'thread_mention' | 'thread_written' | 'other';
}

export interface SlackHistoryMessage {
  ts: string;
  text: string;
  userId?: string;
  userName: string;
  sentAt: number;
  selected: boolean;
}

export interface SlackConversationHistory {
  notificationId: string;
  title: string;
  kind: 'thread' | 'channel';
  messages: SlackHistoryMessage[];
}

export type RecurringTaskFrequency = 'weekly' | 'daily' | 'interval' | 'monthly';

export interface RecurringTaskSchedule {
  frequency: RecurringTaskFrequency;
  daysOfWeek?: number[];
  intervalDays?: number;
  dayOfMonth?: number;
}

export interface RecurringTask {
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

contextBridge.exposeInMainWorld('electronAPI', {
  getTimers: () => ipcRenderer.invoke('timer:list'),
  addTimer: (text: string, seconds: number, sound: import('../timerTasks.js').TimerSound) => ipcRenderer.invoke('timer:add', text, seconds, sound),
  removeTimer: (id: string) => ipcRenderer.invoke('timer:remove', id),
  onTimersUpdate: (callback: (tasks: import('../timerTasks.js').TimerTask[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, tasks: import('../timerTasks.js').TimerTask[]) => callback(tasks);
    ipcRenderer.on('timer:list-update', listener);
    return () => ipcRenderer.removeListener('timer:list-update', listener);
  },
  createSession: (name: string, cmd: string, cwd: string, shellType: ShellType, sshCommand = ''): Promise<Session | null> =>
    ipcRenderer.invoke('session:create', name, cmd, cwd, shellType, sshCommand),

  createShellPty: (cwd?: string, name?: string): Promise<Session | null> =>
    ipcRenderer.invoke('shell:create-pty', cwd, name),

  createShellSsh: (opts: { host: string; username: string; port?: number; privateKeyPath?: string; passphrase?: string; agent?: string; initCommand?: string; name?: string }): Promise<Session | null> =>
    ipcRenderer.invoke('shell:create-ssh', opts),

  reconnectShellSsh: (sessionId: string): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('shell:reconnect-ssh', sessionId),

  focusVscode: (sessionId: string): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('shell:focus-vscode', sessionId),

  getShellServerConfig: (): Promise<{ url: string; token: string }> =>
    ipcRenderer.invoke('shell:get-config'),

  readTerminalClipboard: (): Promise<TerminalClipboardPaste> =>
    ipcRenderer.invoke('clipboard:read-terminal-paste'),

  setWindowInputAttention: (active: boolean): void =>
    ipcRenderer.send('window:set-input-attention', active),

  requestWindowAttention: (): void =>
    ipcRenderer.send('window:request-attention'),

  removeSession: (id: string): Promise<void> =>
    ipcRenderer.invoke('session:remove', id),

  pauseSession: (id: string): Promise<Session | null> =>
    ipcRenderer.invoke('session:pause', id),

  resumeSession: (id: string): Promise<Session | null> =>
    ipcRenderer.invoke('session:resume', id),

  renameSession: (id: string, name: string): Promise<Session | null> =>
    ipcRenderer.invoke('session:rename', id, name),

  openReview: (cwd: string): Promise<void> =>
    ipcRenderer.invoke('session:open-review', cwd),

  pickDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke('session:pick-dir'),

  getSessions: (): Promise<Session[]> =>
    ipcRenderer.invoke('session:list'),

  getNextUp: (): Promise<NextUpItem[]> =>
    ipcRenderer.invoke('next-up:list'),

  setNextUpOrder: (keys: string[]): Promise<NextUpItem[]> =>
    ipcRenderer.invoke('next-up:set-order', keys),

  markNextUpDone: (key: string): Promise<NextUpItem[]> =>
    ipcRenderer.invoke('next-up:done', key),

  onNextUpListUpdate: (cb: (items: NextUpItem[]) => void): void => {
    ipcRenderer.on('next-up:list-update', (_event, items: NextUpItem[]) => cb(items));
  },

  onListUpdate: (cb: (sessions: Session[]) => void): void => {
    ipcRenderer.on('session:list-update', (_event, sessions: Session[]) => cb(sessions));
  },

  getManualTasks: (): Promise<ManualTask[]> =>
    ipcRenderer.invoke('manual-task:list'),

  addManualTask: (text: string, createdAt?: number, priority?: number): Promise<ManualTask | null> =>
    ipcRenderer.invoke('manual-task:add', text, createdAt, priority),

  removeManualTask: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('manual-task:remove', id),

  onManualTaskListUpdate: (cb: (tasks: ManualTask[]) => void): void => {
    ipcRenderer.on('manual-task:list-update', (_event, tasks: ManualTask[]) => cb(tasks));
  },

  getSlackNotifications: (): Promise<SlackNotification[]> =>
    ipcRenderer.invoke('slack-notification:list'),

  getSlackConversationHistory: (id: string): Promise<SlackConversationHistory> =>
    ipcRenderer.invoke('slack-notification:history', id),

  sendSlackMessage: (id: string, text: string): Promise<SlackHistoryMessage> =>
    ipcRenderer.invoke('slack-notification:send', id, text),

  openSlackNotification: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('slack-notification:open', id),

  removeSlackNotification: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('slack-notification:remove', id),

  clearSlackNotifications: (): Promise<boolean> =>
    ipcRenderer.invoke('slack-notification:clear'),

  onSlackNotification: (cb: (notification: SlackNotification) => void): void => {
    ipcRenderer.on('slack:notification', (_event, notification: SlackNotification) => cb(notification));
  },

  onSlackListUpdate: (cb: (notifications: SlackNotification[]) => void): void => {
    ipcRenderer.on('slack:list-update', (_event, notifications: SlackNotification[]) => cb(notifications));
  },

  getRecurringTasks: (): Promise<RecurringTask[]> =>
    ipcRenderer.invoke('recurring-task:list'),

  addRecurringTask: (text: string, time: string, schedule: RecurringTaskSchedule | number[], priority?: number): Promise<RecurringTask | null> =>
    ipcRenderer.invoke('recurring-task:add', text, time, schedule, priority),

  removeRecurringTask: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('recurring-task:remove', id),

  onRecurringTaskListUpdate: (cb: (tasks: RecurringTask[]) => void): void => {
    ipcRenderer.on('recurring-task:list-update', (_event, tasks: RecurringTask[]) => cb(tasks));
  },
  getGoogleCalendarEvents: (): Promise<GoogleCalendarEvent[]> =>
    ipcRenderer.invoke('google-calendar:list'),

  getGoogleCalendarStatus: (): Promise<GoogleCalendarStatus> =>
    ipcRenderer.invoke('google-calendar:status'),

  connectGoogleCalendar: (): Promise<GoogleCalendarAuthResult> =>
    ipcRenderer.invoke('google-calendar:connect'),

  disconnectGoogleCalendar: (id?: string): Promise<GoogleCalendarStatus> =>
    ipcRenderer.invoke('google-calendar:disconnect', id),

  refreshGoogleCalendar: (): Promise<GoogleCalendarStatus> =>
    ipcRenderer.invoke('google-calendar:refresh'),

  openGoogleCalendarEvent: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('google-calendar:open', id),

  onGoogleCalendarListUpdate: (cb: (events: GoogleCalendarEvent[]) => void): void => {
    ipcRenderer.on('google-calendar:list-update', (_event, events: GoogleCalendarEvent[]) => cb(events));
  },

  onGoogleCalendarStatusUpdate: (cb: (status: GoogleCalendarStatus) => void): void => {
    ipcRenderer.on('google-calendar:status-update', (_event, status: GoogleCalendarStatus) => cb(status));
  },

  startSlackAuth: (): Promise<SlackAuthStatus> =>
    ipcRenderer.invoke('slack:auth:start'),

  getSlackWorkspaces: (): Promise<SlackWorkspaceSummary[]> =>
    ipcRenderer.invoke('slack:workspace:list'),

  removeSlackWorkspace: (teamId: string): Promise<boolean> =>
    ipcRenderer.invoke('slack:workspace:remove', teamId),

  onSlackAuthStatus: (cb: (status: SlackAuthStatus) => void): void => {
    ipcRenderer.on('slack:auth-status', (_event, status: SlackAuthStatus) => cb(status));
  },

  getJiraStatus: (): Promise<JiraStatus> =>
    ipcRenderer.invoke('jira:status'),

  connectJira: (): Promise<JiraActionResult> =>
    ipcRenderer.invoke('jira:connect'),

  disconnectJira: (): Promise<JiraActionResult> =>
    ipcRenderer.invoke('jira:disconnect'),

  pollJira: (): Promise<JiraActionResult> =>
    ipcRenderer.invoke('jira:poll'),

  getGitHubStatus: (): Promise<GitHubStatus> =>
    ipcRenderer.invoke('github:status'),

  getGitHubPreviews: () => ipcRenderer.invoke('github:previews'),
  githubPreviewAction: (payload: unknown) => ipcRenderer.invoke('github:preview-action', payload),

  connectGitHub: (): Promise<GitHubActionResult> =>
    ipcRenderer.invoke('github:connect'),

  disconnectGitHub: (): Promise<GitHubActionResult> =>
    ipcRenderer.invoke('github:disconnect'),

  pollGitHub: (): Promise<GitHubActionResult> =>
    ipcRenderer.invoke('github:poll'),

  getInstalledPlugins: (): Promise<PluginId[]> =>
    ipcRenderer.invoke('plugin:list'),

  onOpenPluginManager: (cb: () => void): (() => void) => {
    const listener = () => cb();
    ipcRenderer.on('plugin:open-manager', listener);
    return () => { ipcRenderer.removeListener('plugin:open-manager', listener); };
  },

  setPluginInstalled: (pluginId: PluginId, installed: boolean): Promise<PluginId[]> =>
    ipcRenderer.invoke('plugin:set-installed', pluginId, installed),

  getSettings: (): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:get'),

  setSettings: (settings: AppSettings): Promise<void> =>
    ipcRenderer.invoke('settings:set', settings),
});
