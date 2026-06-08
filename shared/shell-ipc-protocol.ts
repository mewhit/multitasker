import type { SessionInfo, SshConnectOptions } from './shell-protocol';

export const IPC_PROTOCOL_VERSION = 1;

/** Maximum NDJSON line length accepted on the IPC pipe (1 MiB). */
export const IPC_MAX_LINE_BYTES = 1024 * 1024;

export type IpcErrorCode =
  | 'invalid_message'
  | 'unauthorized'
  | 'unknown_session'
  | 'spawn_failed'
  | 'line_too_long'
  | 'internal_error';

/** Messages sent from the gateway WS server to the supervisor. */
export type IpcClientMessage =
  | { type: 'hello'; id?: string; token?: string }
  | { type: 'list'; id?: string }
  | {
      type: 'create';
      id?: string;
      sessionId?: string;
      shell?: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      cols?: number;
      rows?: number;
      track?: boolean;
    }
  | {
      type: 'create_ssh';
      id?: string;
      sessionId?: string;
      ssh: SshConnectOptions;
      cols?: number;
      rows?: number;
    }
  | { type: 'subscribe'; id?: string; sessionId: string }
  | { type: 'unsubscribe'; id?: string; sessionId: string }
  | { type: 'input'; id?: string; sessionId: string; data: string }
  | { type: 'resize'; id?: string; sessionId: string; cols: number; rows: number }
  | { type: 'kill'; id?: string; sessionId: string; signal?: string };

/** Messages sent from the supervisor to the gateway WS server. */
export type IpcServerMessage =
  | {
      type: 'hello';
      protocolVersion: number;
      supervisorPid: number;
      requiresAuth: boolean;
      authenticated: boolean;
      defaults: { shell: string; cols: number; rows: number };
    }
  | { type: 'authenticated'; id?: string }
  | { type: 'sessions'; id?: string; sessions: SessionInfo[] }
  | { type: 'created'; id?: string; session: SessionInfo }
  | {
      type: 'subscribed';
      id?: string;
      sessionId: string;
      session: SessionInfo;
      scrollback: string;
    }
  | { type: 'unsubscribed'; id?: string; sessionId: string }
  | { type: 'output'; sessionId: string; data: string }
  | { type: 'exit'; sessionId: string; exitCode: number; signal: number | null }
  | { type: 'removed'; sessionId: string }
  | {
      type: 'error';
      id?: string;
      code: IpcErrorCode;
      message: string;
      sessionId?: string;
    };

export function parseIpcClientMessage(raw: string): IpcClientMessage | { _error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { _error: `invalid json: ${(e as Error).message}` };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { _error: 'message must be a JSON object' };
  }
  const obj = parsed as { type?: unknown };
  if (typeof obj.type !== 'string') {
    return { _error: 'missing string `type`' };
  }
  return parsed as IpcClientMessage;
}

export function parseIpcServerMessage(raw: string): IpcServerMessage | { _error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { _error: `invalid json: ${(e as Error).message}` };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { _error: 'message must be a JSON object' };
  }
  const obj = parsed as { type?: unknown };
  if (typeof obj.type !== 'string') {
    return { _error: 'missing string `type`' };
  }
  return parsed as IpcServerMessage;
}

/**
 * Stateful line splitter for NDJSON over a stream. Accumulates incoming
 * chunks and yields complete lines, enforcing a max line length to
 * protect against unbounded memory growth from a misbehaving peer.
 */
export class NdjsonLineBuffer {
  private buf = '';
  private overflow = false;
  constructor(private readonly maxLineBytes: number) {}

  push(chunk: string): { lines: string[]; tooLong: boolean } {
    const lines: string[] = [];
    let tooLong = false;
    this.buf += chunk;
    for (;;) {
      const idx = this.buf.indexOf('\n');
      if (idx < 0) {
        if (this.buf.length > this.maxLineBytes) {
          this.overflow = true;
          this.buf = '';
          tooLong = true;
        }
        break;
      }
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (this.overflow) {
        this.overflow = false;
        tooLong = true;
        continue;
      }
      const trimmed = line.replace(/\r$/, '');
      if (trimmed.length > 0) lines.push(trimmed);
    }
    return { lines, tooLong };
  }
}
