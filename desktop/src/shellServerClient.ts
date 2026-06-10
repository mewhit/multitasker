import { WebSocket } from 'ws';

const DEFAULT_SHELL_SERVER_URL = 'ws://127.0.0.1:4321';
const CONNECT_TIMEOUT_MS = 4000;
const REQUEST_TIMEOUT_MS = 6000;

export interface CreateShellPtyOptions {
  shell?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  /** When true (default), the shell server's multitasker bridge will register
   *  the new PTY as a task on its own. Set to false when the caller will
   *  register the task itself (e.g. the desktop main process). */
  track?: boolean;
  /** Optional token if the shell server requires SHELL_AUTH_TOKEN. */
  token?: string;
}

export interface CreatedShellPty {
  sessionId: string;
  pid: number;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
}

export interface KillShellSessionOptions {
  sessionId: string;
  signal?: string;
  token?: string;
}

export function getShellServerUrl(): string {
  return process.env['MULTITASKER_SHELL_SERVER_URL']?.trim() || DEFAULT_SHELL_SERVER_URL;
}

/**
 * Opens a short-lived WebSocket to the shell server, asks it to spawn a new
 * PTY, and resolves with the resulting session info. The connection is closed
 * once the response (or an error) arrives.
 */
export interface CreateShellSshOptions {
  host: string;
  username: string;
  port?: number;
  privateKeyPath?: string;
  passphrase?: string;
  agent?: string;
  initCommand?: string;
  cols?: number;
  rows?: number;
  token?: string;
  /** Request that the supervisor use this exact session id. Used by SSH
   *  auto-reconnect after an Electron restart so the desktop session id
   *  stays stable across the resurrection. */
  sessionId?: string;
}

export function createShellSsh(opts: CreateShellSshOptions): Promise<CreatedShellPty> {
  const url = getShellServerUrl();
  return new Promise<CreatedShellPty>((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, value?: CreatedShellPty): void => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(requestTimer);
      try { ws.close(); } catch { /* ignore */ }
      if (err) reject(err);
      else if (value) resolve(value);
    };
    const ws = new WebSocket(url);
    const connectTimer = setTimeout(
      () => finish(new Error(`shell server connect timeout (${url})`)),
      CONNECT_TIMEOUT_MS
    );
    const requestTimer = setTimeout(
      () => finish(new Error('shell server request timeout')),
      REQUEST_TIMEOUT_MS
    );
    ws.on('error', (err) => finish(err));
    ws.on('close', () => { if (!settled) finish(new Error('shell server closed connection')); });
    ws.on('message', (raw) => {
      let msg: unknown;
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      const m = msg as { type?: string };
      if (m.type === 'ready') {
        clearTimeout(connectTimer);
        const ready = msg as { requiresAuth?: boolean; authenticated?: boolean };
        if (ready.requiresAuth && !ready.authenticated) {
          if (!opts.token) {
            finish(new Error('shell server requires auth token (set MULTITASKER_SHELL_AUTH_TOKEN)'));
            return;
          }
          ws.send(JSON.stringify({ type: 'hello', token: opts.token }));
          return;
        }
        sendCreate();
        return;
      }
      if (m.type === 'authenticated') { sendCreate(); return; }
      if (m.type === 'session_created') {
        const c = msg as CreatedShellPty;
        finish(null, {
          sessionId: c.sessionId,
          pid: c.pid,
          shell: c.shell,
          cwd: c.cwd,
          cols: c.cols,
          rows: c.rows,
        });
        return;
      }
      if (m.type === 'error') {
        const e = msg as { code?: string; message?: string };
        finish(new Error(`shell server error [${e.code ?? '?'}]: ${e.message ?? 'unknown'}`));
        return;
      }
    });
    function sendCreate(): void {
      const ssh: Record<string, unknown> = { host: opts.host, username: opts.username };
      if (opts.port !== undefined) ssh['port'] = opts.port;
      if (opts.privateKeyPath !== undefined) ssh['privateKeyPath'] = opts.privateKeyPath;
      if (opts.passphrase !== undefined) ssh['passphrase'] = opts.passphrase;
      if (opts.agent !== undefined) ssh['agent'] = opts.agent;
      if (opts.initCommand !== undefined && opts.initCommand.trim()) ssh['initCommand'] = opts.initCommand.trim();
      const payload: Record<string, unknown> = { type: 'create_ssh_session', attach: false, ssh };
      if (opts.sessionId !== undefined && opts.sessionId.trim()) payload['sessionId'] = opts.sessionId.trim();
      if (opts.cols !== undefined) payload['cols'] = opts.cols;
      if (opts.rows !== undefined) payload['rows'] = opts.rows;
      ws.send(JSON.stringify(payload));
    }
  });
}

export function createShellPty(opts: CreateShellPtyOptions = {}): Promise<CreatedShellPty> {
  const url = getShellServerUrl();
  return new Promise<CreatedShellPty>((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, value?: CreatedShellPty): void => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(requestTimer);
      try {
        ws.close();
      } catch {
        // ignore
      }
      if (err) reject(err);
      else if (value) resolve(value);
    };

    const ws = new WebSocket(url);

    const connectTimer = setTimeout(
      () => finish(new Error(`shell server connect timeout (${url})`)),
      CONNECT_TIMEOUT_MS
    );
    const requestTimer = setTimeout(
      () => finish(new Error('shell server request timeout')),
      REQUEST_TIMEOUT_MS
    );

    ws.on('error', (err) => finish(err));
    ws.on('close', () => {
      if (!settled) finish(new Error('shell server closed connection'));
    });
    ws.on('message', (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      const m = msg as { type?: string };
      if (m.type === 'ready') {
        clearTimeout(connectTimer);
        const ready = msg as { requiresAuth?: boolean; authenticated?: boolean };
        if (ready.requiresAuth && !ready.authenticated) {
          if (!opts.token) {
            finish(new Error('shell server requires auth token (set MULTITASKER_SHELL_AUTH_TOKEN)'));
            return;
          }
          ws.send(JSON.stringify({ type: 'hello', token: opts.token }));
          return;
        }
        sendCreate();
        return;
      }
      if (m.type === 'authenticated') {
        sendCreate();
        return;
      }
      if (m.type === 'session_created') {
        const c = msg as CreatedShellPty;
        finish(null, {
          sessionId: c.sessionId,
          pid: c.pid,
          shell: c.shell,
          cwd: c.cwd,
          cols: c.cols,
          rows: c.rows,
        });
        return;
      }
      if (m.type === 'error') {
        const e = msg as { code?: string; message?: string };
        finish(new Error(`shell server error [${e.code ?? '?'}]: ${e.message ?? 'unknown'}`));
        return;
      }
    });

    function sendCreate(): void {
      const payload: Record<string, unknown> = { type: 'create_session', attach: false, track: opts.track ?? true };
      if (opts.shell !== undefined) payload['shell'] = opts.shell;
      if (opts.args !== undefined) payload['args'] = opts.args;
      if (opts.cwd !== undefined) payload['cwd'] = opts.cwd;
      if (opts.env !== undefined) payload['env'] = opts.env;
      if (opts.cols !== undefined) payload['cols'] = opts.cols;
      if (opts.rows !== undefined) payload['rows'] = opts.rows;
      ws.send(JSON.stringify(payload));
    }
  });
}

export function killShellSession(opts: KillShellSessionOptions): Promise<void> {
  const url = getShellServerUrl();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(requestTimer);
      try {
        ws.close();
      } catch {
        // ignore
      }
      if (err) reject(err);
      else resolve();
    };

    const ws = new WebSocket(url);
    const connectTimer = setTimeout(
      () => finish(new Error(`shell server connect timeout (${url})`)),
      CONNECT_TIMEOUT_MS
    );
    const requestTimer = setTimeout(
      () => finish(new Error('shell server request timeout')),
      REQUEST_TIMEOUT_MS
    );

    ws.on('error', (err) => finish(err));
    ws.on('close', () => {
      if (!settled) finish(new Error('shell server closed connection'));
    });
    ws.on('message', (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      const m = msg as { type?: string; code?: string; message?: string };
      if (m.type === 'ready') {
        clearTimeout(connectTimer);
        const ready = msg as { requiresAuth?: boolean; authenticated?: boolean };
        if (ready.requiresAuth && !ready.authenticated) {
          if (!opts.token) {
            finish(new Error('shell server requires auth token (set SHELL_AUTH_TOKEN)'));
            return;
          }
          ws.send(JSON.stringify({ type: 'hello', token: opts.token }));
          return;
        }
        sendKill();
        return;
      }
      if (m.type === 'authenticated') {
        sendKill();
        return;
      }
      if (m.type === 'error') {
        if (m.code === 'unknown_session') {
          finish();
          return;
        }
        finish(new Error(`shell server error [${m.code ?? '?'}]: ${m.message ?? 'unknown'}`));
      }
    });

    function sendKill(): void {
      const payload: Record<string, unknown> = { type: 'kill', sessionId: opts.sessionId };
      if (opts.signal !== undefined) payload['signal'] = opts.signal;
      ws.send(JSON.stringify(payload));
      finish();
    }
  });
}
