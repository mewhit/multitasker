import { contextBridge, ipcRenderer } from 'electron';

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
  priorityLabel?: string;
}

export interface ManualTask {
  id: string;
  text: string;
  createdAt: number;
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
  enabled: boolean;
  lastGeneratedDate?: string;
}

contextBridge.exposeInMainWorld('electronAPI', {
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

  removeSession: (id: string): Promise<void> =>
    ipcRenderer.invoke('session:remove', id),

  pauseSession: (id: string): Promise<Session | null> =>
    ipcRenderer.invoke('session:pause', id),

  renameSession: (id: string, name: string): Promise<Session | null> =>
    ipcRenderer.invoke('session:rename', id, name),

  openReview: (cwd: string): Promise<void> =>
    ipcRenderer.invoke('session:open-review', cwd),

  pickDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke('session:pick-dir'),

  getSessions: (): Promise<Session[]> =>
    ipcRenderer.invoke('session:list'),

  onListUpdate: (cb: (sessions: Session[]) => void): void => {
    ipcRenderer.on('session:list-update', (_event, sessions: Session[]) => cb(sessions));
  },

  getManualTasks: (): Promise<ManualTask[]> =>
    ipcRenderer.invoke('manual-task:list'),

  addManualTask: (text: string): Promise<ManualTask | null> =>
    ipcRenderer.invoke('manual-task:add', text),

  removeManualTask: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('manual-task:remove', id),

  onManualTaskListUpdate: (cb: (tasks: ManualTask[]) => void): void => {
    ipcRenderer.on('manual-task:list-update', (_event, tasks: ManualTask[]) => cb(tasks));
  },

  getRecurringTasks: (): Promise<RecurringTask[]> =>
    ipcRenderer.invoke('recurring-task:list'),

  addRecurringTask: (text: string, time: string, schedule: RecurringTaskSchedule | number[]): Promise<RecurringTask | null> =>
    ipcRenderer.invoke('recurring-task:add', text, time, schedule),

  removeRecurringTask: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('recurring-task:remove', id),

  onRecurringTaskListUpdate: (cb: (tasks: RecurringTask[]) => void): void => {
    ipcRenderer.on('recurring-task:list-update', (_event, tasks: RecurringTask[]) => cb(tasks));
  },

  getSlackNotifications: (): Promise<SlackNotification[]> =>
    ipcRenderer.invoke('slack:list'),

  clearSlackNotifications: (): Promise<void> =>
    ipcRenderer.invoke('slack:clear'),

  removeSlackNotification: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('slack:remove', id),

  openSlackNotification: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('slack:open', id),

  startSlackAuth: (): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('slack:start-auth'),

  startSlackListener: (): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('slack:start-listener'),

  getSlackListenerStatus: (): Promise<{ ok: boolean; message: string } | null> =>
    ipcRenderer.invoke('slack:get-listener-status'),

  onSlackNotification: (cb: (notification: SlackNotification) => void): void => {
    ipcRenderer.on('slack:notification', (_event, notification: SlackNotification) => cb(notification));
  },

  onSlackListUpdate: (cb: (notifications: SlackNotification[]) => void): void => {
    ipcRenderer.on('slack:list-update', (_event, notifications: SlackNotification[]) => cb(notifications));
  },

  onSlackAuthStatus: (cb: (payload: { ok: boolean; message: string }) => void): void => {
    ipcRenderer.on('slack:auth-status', (_event, payload: { ok: boolean; message: string }) => cb(payload));
  },

  onSlackListenerStatus: (cb: (payload: { ok: boolean; message: string }) => void): void => {
    ipcRenderer.on('slack:listener-status', (_event, payload: { ok: boolean; message: string }) => cb(payload));
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

  getSettings: (): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:get'),

  setSettings: (settings: AppSettings): Promise<void> =>
    ipcRenderer.invoke('settings:set', settings),
});
