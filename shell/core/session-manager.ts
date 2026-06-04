import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { PtySession, type PtySessionOptions } from './pty-session';
import { SshSession, type SshSessionOptions } from './ssh-session';
import type { ISession, SessionExitInfo } from './session';
import type { SessionInfo } from './protocol';

export type CreatePtyOptions = Omit<PtySessionOptions, 'sessionId'> & {
  type?: 'pty';
  sessionId?: string;
  track?: boolean;
};

export type CreateSshOptions = Omit<SshSessionOptions, 'sessionId'> & {
  type: 'ssh';
  sessionId?: string;
  track?: boolean;
};

export type CreateOptions = CreatePtyOptions | CreateSshOptions;

export declare interface SessionManager {
  on(event: 'data', listener: (sessionId: string, data: string) => void): this;
  on(event: 'exit', listener: (sessionId: string, info: SessionExitInfo) => void): this;
  on(event: 'created', listener: (session: ISession) => void): this;
  on(event: 'removed', listener: (sessionId: string) => void): this;
}

export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, ISession>();
  private readonly subscribers = new Map<string, Set<string>>(); // sessionId -> set of clientIds
  private readonly untracked = new Set<string>(); // sessionIds that opted out of bridge tracking

  create(opts: CreateOptions): ISession {
    const sessionId = opts.sessionId ?? randomUUID();
    if (this.sessions.has(sessionId)) {
      throw new Error(`session ${sessionId} already exists`);
    }
    let session: ISession;
    if (opts.type === 'ssh') {
      const { type: _type, sessionId: _sid, track: _track, ...rest } = opts;
      session = new SshSession({ ...rest, sessionId });
      // SSH sessions are never bridged into the multitasker task tracker —
      // they don't have a meaningful local cwd or shellType.
      this.untracked.add(sessionId);
    } else {
      const { type: _type, sessionId: _sid, track: _track, ...rest } = opts;
      session = new PtySession({ ...rest, sessionId });
      if (opts.track === false) this.untracked.add(sessionId);
    }
    this.sessions.set(sessionId, session);
    this.subscribers.set(sessionId, new Set());

    session.on('data', (data: string) => {
      this.emit('data', sessionId, data);
    });
    session.on('exit', (info: SessionExitInfo) => {
      this.emit('exit', sessionId, info);
      // Keep session metadata around briefly so clients can read exit;
      // remove after a tick.
      setImmediate(() => {
        this.sessions.delete(sessionId);
        this.subscribers.delete(sessionId);
        this.untracked.delete(sessionId);
        this.emit('removed', sessionId);
      });
    });

    this.emit('created', session);
    return session;
  }

  isTracked(sessionId: string): boolean {
    return !this.untracked.has(sessionId);
  }

  get(sessionId: string): ISession | undefined {
    return this.sessions.get(sessionId);
  }

  list(): SessionInfo[] {
    const out: SessionInfo[] = [];
    for (const s of this.sessions.values()) {
      out.push({
        sessionId: s.sessionId,
        pid: s.pid,
        shell: s.shell,
        cwd: s.cwd,
        cols: s.cols,
        rows: s.rows,
        createdAt: s.createdAt,
        alive: s.alive,
        subscribers: this.subscribers.get(s.sessionId)?.size ?? 0,
        kind: s.kind,
      });
    }
    return out;
  }

  attach(sessionId: string, clientId: string): boolean {
    const subs = this.subscribers.get(sessionId);
    if (!subs) return false;
    subs.add(clientId);
    return true;
  }

  detach(sessionId: string, clientId: string): boolean {
    const subs = this.subscribers.get(sessionId);
    if (!subs) return false;
    return subs.delete(clientId);
  }

  detachAll(clientId: string): void {
    for (const subs of this.subscribers.values()) {
      subs.delete(clientId);
    }
  }

  subscribersOf(sessionId: string): ReadonlySet<string> {
    return this.subscribers.get(sessionId) ?? new Set();
  }

  killAll(signal?: string): void {
    for (const s of this.sessions.values()) {
      s.kill(signal);
    }
  }
}
