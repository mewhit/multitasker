import { contextBridge, ipcRenderer } from 'electron';

export type ShellType = 'powershell' | 'bash' | 'ssh';

export interface Session {
  id: string;
  name: string;
  cmd: string;
  cwd: string;
  shellType: ShellType;
  sshHost: string;
  status: 'running' | 'waiting' | 'error' | 'stopped';
  lastOutput: number;
  pid: number;
  gitChanges: boolean;
}

export interface AppSettings {
  reviewTool: string;
  idleTimeout: number;
  defaultShell: ShellType;
}

export interface SessionState {
  name: string;
  cmd: string;
  cwd: string;
  shellType: ShellType;
  sshHost: string;
}

contextBridge.exposeInMainWorld('electronAPI', {
  createSession: (name: string, cmd: string, cwd: string, shellType: ShellType, sshHost: string): Promise<string> =>
    ipcRenderer.invoke('session:create', name, cmd, cwd, shellType, sshHost),

  sendInput: (id: string, data: string): void =>
    ipcRenderer.send('session:input', id, data),

  resizeSession: (id: string, cols: number, rows: number): void =>
    ipcRenderer.send('session:resize', id, cols, rows),

  killSession: (id: string): Promise<void> =>
    ipcRenderer.invoke('session:kill', id),

  openReview: (cwd: string): Promise<void> =>
    ipcRenderer.invoke('session:open-review', cwd),

  pickDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke('session:pick-dir'),

  getSessions: (): Promise<Session[]> =>
    ipcRenderer.invoke('session:list'),

  onOutput: (cb: (id: string, data: string) => void): void => {
    ipcRenderer.on('session:output', (_event, id: string, data: string) => cb(id, data));
  },

  onListUpdate: (cb: (sessions: Session[]) => void): void => {
    ipcRenderer.on('session:list-update', (_event, sessions: Session[]) => cb(sessions));
  },

  getSettings: (): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:get'),

  setSettings: (settings: AppSettings): Promise<void> =>
    ipcRenderer.invoke('settings:set', settings),

  persistSession: (id: string): Promise<void> =>
    ipcRenderer.invoke('session:persist', id),

  unpersistSession: (id: string): Promise<void> =>
    ipcRenderer.invoke('session:unpersist', id),

  getPersistedSessions: (): Promise<SessionState[]> =>
    ipcRenderer.invoke('session:list-persisted'),
});
