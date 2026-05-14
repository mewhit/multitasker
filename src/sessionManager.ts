import * as pty from 'node-pty';
import { EventEmitter } from 'node:events';
import { exec } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ShellType } from './settings';

export type { ShellType };
export type SessionStatus = 'running' | 'waiting' | 'error' | 'stopped';

export interface Session {
  id: string;
  name: string;
  cmd: string;
  cwd: string;
  shellType: ShellType;
  sshHost: string;
  status: SessionStatus;
  lastOutput: number;
  pid: number;
  gitChanges: boolean;
}

interface SessionEntry {
  session: Session;
  ptyProc: pty.IPty;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const STATUS_PRIORITY: Record<SessionStatus, number> = {
  waiting: 0,
  error: 1,
  running: 2,
  stopped: 3,
};

export class SessionManager extends EventEmitter {
  idleTimeout: number;
  private sessions = new Map<string, SessionEntry>();
  private persistedSessions = new Set<string>();

  constructor(idleTimeout = 800) {
    super();
    this.idleTimeout = idleTimeout;
  }

  markSessionAsPersisted(id: string): void {
    this.persistedSessions.add(id);
  }

  getPersistedSessionIds(): string[] {
    return Array.from(this.persistedSessions).filter(id => this.sessions.has(id));
  }

  createSession(name: string, cmd: string, cwd: string, shellType: ShellType = 'powershell', sshHost = ''): string {
    const id = randomUUID();

    let shell: string;
    let shellArgs: string[];
    if (shellType === 'ssh') {
      shell = 'ssh';
      shellArgs = [sshHost];
    } else if (shellType === 'bash') {
      shell = 'bash';
      shellArgs = [];
    } else {
      shell = 'powershell.exe';
      shellArgs = [];
    }

    const effectiveCwd = cwd || process.env['USERPROFILE'] || process.env['HOME'] || '/';

    const ptyProc = pty.spawn(shell, shellArgs, {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: effectiveCwd,
      env: process.env as Record<string, string>,
    });

    const session: Session = {
      id,
      name,
      cmd,
      cwd: effectiveCwd,
      shellType,
      sshHost,
      status: 'running',
      lastOutput: Date.now(),
      pid: ptyProc.pid,
      gitChanges: false,
    };

    const entry: SessionEntry = { session, ptyProc, idleTimer: null };
    this.sessions.set(id, entry);

    ptyProc.onData((data: string) => {
      session.lastOutput = Date.now();
      if (session.status !== 'running') {
        session.status = 'running';
        this.emit('sessionUpdate', this.getSessions());
      }
      this.resetIdleTimer(entry);
      if (shellType !== 'ssh') this.parseCwd(data, session);
      this.emit('output', id, data);
    });

    ptyProc.onExit(({ exitCode }: { exitCode: number }) => {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      session.status = exitCode === 0 ? 'stopped' : 'error';
      this.emit('sessionUpdate', this.getSessions());
    });

    if (cmd.trim()) {
      ptyProc.write(cmd + '\r');
    }

    this.emit('sessionUpdate', this.getSessions());
    return id;
  }

  private resetIdleTimer(entry: SessionEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (entry.session.status === 'running') {
        entry.session.status = 'waiting';
        this.emit('sessionUpdate', this.getSessions());
        if (entry.session.shellType !== 'ssh') void this.checkGitChanges(entry);
      }
    }, this.idleTimeout);
  }

  private parseCwd(data: string, session: Session): void {
    // Windows PowerShell: PS C:\some\path>
    const psMatch = /PS ([A-Za-z]:[^\r\n>]+)>/.exec(data);
    if (psMatch?.[1]) {
      session.cwd = psMatch[1].trim();
      return;
    }
    // Unix bash/zsh: user@host:/path$ or ~/path$
    const unixMatch = /(?:[\w-]+@[\w-]+:)?([~/][^\r\n$#]*)[$#]/.exec(data);
    if (unixMatch?.[1]) {
      const home = process.env['HOME'] ?? '';
      session.cwd = unixMatch[1].replace('~', home).trim();
    }
  }

  private checkGitChanges(entry: SessionEntry): Promise<void> {
    return new Promise((resolve) => {
      exec('git status --porcelain', { cwd: entry.session.cwd }, (err, stdout) => {
        entry.session.gitChanges = !err && stdout.trim().length > 0;
        this.emit('sessionUpdate', this.getSessions());
        resolve();
      });
    });
  }

  sendInput(id: string, data: string): void {
    this.sessions.get(id)?.ptyProc.write(data);
  }

  resizeSession(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.ptyProc.resize(cols, rows);
  }

  killSession(id: string): void {
    const entry = this.sessions.get(id);
    if (!entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.ptyProc.kill();
    this.sessions.delete(id);
    this.emit('sessionUpdate', this.getSessions());
  }

  getSessions(): Session[] {
    return [...this.sessions.values()]
      .map(e => ({ ...e.session }))
      .sort((a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status]);
  }
}
