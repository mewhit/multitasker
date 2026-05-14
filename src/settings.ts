import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export type ShellType = 'powershell' | 'bash' | 'ssh';

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

const DEFAULT_SETTINGS: AppSettings = {
  reviewTool: 'code {path}',
  idleTimeout: 800,
  defaultShell: process.platform === 'win32' ? 'powershell' : 'bash',
};

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

function getSessionsPath(): string {
  return path.join(app.getPath('userData'), 'sessions.json');
}

export function loadSettings(): AppSettings {
  try {
    const raw = fs.readFileSync(getSettingsPath(), 'utf-8');
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AppSettings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AppSettings): void {
  fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2));
}

export function loadSessions(): SessionState[] {
  try {
    const raw = fs.readFileSync(getSessionsPath(), 'utf-8');
    return JSON.parse(raw) as SessionState[];
  } catch {
    return [];
  }
}

export function saveSessions(sessions: SessionState[]): void {
  fs.writeFileSync(getSessionsPath(), JSON.stringify(sessions, null, 2));
}
