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
  status: 'waiting' | 'starting' | 'running' | 'needs_attention' | 'error' | 'stopped' | 'detached';
  lastActivity: number;
  gitChanges: boolean;
  terminalExitCode?: number;
  terminalExitReason?: string;
  vscodeWindowId?: string;
  terminalRef?: string;
  terminalPid?: number;
  terminalCaptureState?: TerminalCaptureState;
  terminalCaptureReason?: string;
}

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
  terminalRef?: string;
  terminalPid?: number;
}

export interface VsCodeSessionRequest {
  id: string;
  name: string;
  cmd: string;
  cwd: string;
  shellType: ShellType;
  sshCommand?: string;
  vscodeWindowId?: string;
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

export interface RecurringTask {
  id: string;
  text: string;
  time: string;
  daysOfWeek: number[];
  createdAt: number;
  enabled: boolean;
  lastGeneratedDate?: string;
}

contextBridge.exposeInMainWorld('electronAPI', {
  createSession: (name: string, cmd: string, cwd: string, shellType: ShellType, sshCommand = ''): Promise<Session | null> =>
    ipcRenderer.invoke('session:create', name, cmd, cwd, shellType, sshCommand),

  removeSession: (id: string): Promise<void> =>
    ipcRenderer.invoke('session:remove', id),

  renameSession: (id: string, name: string): Promise<Session | null> =>
    ipcRenderer.invoke('session:rename', id, name),

  openReview: (cwd: string): Promise<void> =>
    ipcRenderer.invoke('session:open-review', cwd),

  openVsCode: (session: VsCodeSessionRequest): Promise<boolean> =>
    ipcRenderer.invoke('editor:open-vscode', session),

  pickDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke('session:pick-dir'),

  getSessions: (): Promise<Session[]> =>
    ipcRenderer.invoke('session:list'),

  onListUpdate: (cb: (sessions: Session[]) => void): void => {
    ipcRenderer.on('session:list-update', (_event, sessions: Session[]) => cb(sessions));
  },

  onVsCodeFocusFailed: (cb: (payload: { id: string; message: string; reason: string }) => void): void => {
    ipcRenderer.on('editor:vscode-focus-failed', (_event, payload: { id: string; message: string; reason: string }) => cb(payload));
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

  addRecurringTask: (text: string, time: string, daysOfWeek: number[]): Promise<RecurringTask | null> =>
    ipcRenderer.invoke('recurring-task:add', text, time, daysOfWeek),

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

  getSettings: (): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:get'),

  setSettings: (settings: AppSettings): Promise<void> =>
    ipcRenderer.invoke('settings:set', settings),
});
