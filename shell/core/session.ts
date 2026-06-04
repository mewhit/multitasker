// Common surface for any backend session (local PTY or remote SSH shell).
// Both PtySession and SshSession implement this so the rest of the
// supervisor/gateway code doesn't need to know which one it's talking to.
//
// We don't define an abstract base class because Node's EventEmitter doesn't
// compose well with abstract methods; instead, we duck-type via this
// interface and let each implementation extend EventEmitter directly.

import type { EventEmitter } from 'events';

export interface SessionExitInfo {
  exitCode: number;
  signal: number | null;
}

export type SessionKind = 'pty' | 'ssh';

export interface ISession extends EventEmitter {
  readonly sessionId: string;
  readonly kind: SessionKind;
  /** For pty: shell binary path. For ssh: `ssh://user@host:port` (display only). */
  readonly shell: string;
  /** For pty: local working dir. For ssh: '' unless we ever learn the remote one. */
  readonly cwd: string;
  readonly createdAt: string;
  /** For pty: child OS pid. For ssh: 0 (no local process). */
  readonly pid: number;
  cols: number;
  rows: number;
  alive: boolean;
  exitInfo: SessionExitInfo | null;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
