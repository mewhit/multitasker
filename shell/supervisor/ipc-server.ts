import { randomUUID } from 'crypto';
import * as net from 'net';
import { monitorEventLoopDelay } from 'perf_hooks';
import {
  AUTH_TOKEN,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  defaultShell,
} from '../core/constants';
import { log } from '../core/logger';
import type { PtyExitInfo } from '../core/pty-session';
import type { ISession } from '../core/session';
import type { SessionInfo } from '../core/protocol';
import { SessionManager } from '../core/session-manager';
import {
  IPC_MAX_LINE_BYTES,
  IPC_PROTOCOL_VERSION,
  NdjsonLineBuffer,
  parseIpcClientMessage,
  type IpcClientMessage,
  type IpcErrorCode,
  type IpcServerMessage,
} from '../ipc/protocol';

const SCROLLBACK_BYTES_PER_SESSION = 256 * 1024;
const MAX_SOCKET_BACKLOG_BYTES = 4 * 1024 * 1024;
const SOCKET_BACKLOG_WARN_BYTES = 256 * 1024;
const SOCKET_BACKLOG_WARN_INTERVAL_MS = 1000;

interface ScrollbackBuffer {
  chunks: Array<{ bytes: number; data: string }>;
  totalBytes: number;
}

interface Connection {
  id: string;
  socket: net.Socket;
  authenticated: boolean;
  buf: NdjsonLineBuffer;
  paused: boolean;
  /** Sessions this connection has subscribed to (live output fan-out). */
  subscriptions: Set<string>;
  /** Last time we warned about a large backlog, throttle log spam. */
  lastBacklogWarnAt: number;
}

function infoFrom(s: ISession, subscribers: number): SessionInfo {
  return {
    sessionId: s.sessionId,
    pid: s.pid,
    shell: s.shell,
    cwd: s.cwd,
    cols: s.cols,
    rows: s.rows,
    createdAt: s.createdAt,
    alive: s.alive,
    subscribers,
    kind: s.kind,
  };
}

export interface IpcServer {
  close(): Promise<void>;
}

export function startIpcServer(
  pipePath: string,
  sessions: SessionManager
): Promise<IpcServer> {
  const conns = new Map<string, Connection>();
  /** sessionId -> set of connection ids subscribed. */
  const subscribers = new Map<string, Set<string>>();
  /** sessionId -> ring buffer. */
  const scrollback = new Map<string, ScrollbackBuffer>();

  // Event-loop delay monitor for the supervisor process. If the supervisor's
  // loop stalls, pty reads back up and both viewers see lag. This is always
  // on and only logs when there's actual lag worth reporting.
  const elDelay = monitorEventLoopDelay({ resolution: 10 });
  elDelay.enable();
  const elLogTimer = setInterval(() => {
    const maxMs = elDelay.max / 1e6;
    const p99Ms = elDelay.percentile(99) / 1e6;
    const meanMs = elDelay.mean / 1e6;
    if (maxMs >= 50 || p99Ms >= 25) {
      log.warn('supervisor event loop lag', {
        meanMs: Number(meanMs.toFixed(2)),
        p99Ms: Number(p99Ms.toFixed(2)),
        maxMs: Number(maxMs.toFixed(2)),
        conns: conns.size,
        sessions: subscribers.size,
      });
    }
    elDelay.reset();
  }, 1000);
  if (typeof (elLogTimer as { unref?: () => void }).unref === 'function') {
    (elLogTimer as { unref: () => void }).unref();
  }


  function ensureBuffers(sessionId: string): void {
    if (!subscribers.has(sessionId)) subscribers.set(sessionId, new Set());
    if (!scrollback.has(sessionId)) {
      scrollback.set(sessionId, { chunks: [], totalBytes: 0 });
    }
  }

  function dropBuffers(sessionId: string): void {
    subscribers.delete(sessionId);
    scrollback.delete(sessionId);
  }

  function appendScrollback(sessionId: string, data: string): void {
    const buf = scrollback.get(sessionId);
    if (!buf) return;
    const bytes = Buffer.byteLength(data, 'utf8');
    buf.chunks.push({ bytes, data });
    buf.totalBytes += bytes;
    while (buf.totalBytes > SCROLLBACK_BYTES_PER_SESSION && buf.chunks.length > 1) {
      const removed = buf.chunks.shift();
      if (removed) buf.totalBytes -= removed.bytes;
    }
  }

  function snapshotScrollback(sessionId: string): string {
    const buf = scrollback.get(sessionId);
    if (!buf || buf.chunks.length === 0) return '';
    return buf.chunks.map((c) => c.data).join('');
  }

  function checkBacklog(conn: Connection): void {
    const backlog = conn.socket.writableLength;
    if (backlog > SOCKET_BACKLOG_WARN_BYTES) {
      const now = Date.now();
      if (now - conn.lastBacklogWarnAt > SOCKET_BACKLOG_WARN_INTERVAL_MS) {
        conn.lastBacklogWarnAt = now;
        log.warn('ipc backlog growing', {
          connId: conn.id,
          backlog,
          subs: conn.subscriptions.size,
        });
      }
    }
    if (backlog > MAX_SOCKET_BACKLOG_BYTES) {
      log.warn('ipc backlog exceeded, dropping gateway connection', {
        connId: conn.id,
        backlog,
      });
      conn.socket.destroy(new Error('ipc backlog exceeded'));
    }
  }

  function sendRaw(conn: Connection, msg: IpcServerMessage): void {
    if (conn.socket.destroyed) return;
    const line = JSON.stringify(msg) + '\n';
    const ok = conn.socket.write(line);
    if (!ok) conn.paused = true;
    checkBacklog(conn);
  }

  function sendError(
    conn: Connection,
    code: IpcErrorCode,
    message: string,
    extra?: { sessionId?: string; id?: string }
  ): void {
    const msg: IpcServerMessage = {
      type: 'error',
      code,
      message,
      ...(extra?.sessionId !== undefined ? { sessionId: extra.sessionId } : {}),
      ...(extra?.id !== undefined ? { id: extra.id } : {}),
    };
    sendRaw(conn, msg);
  }

  function broadcast(msg: IpcServerMessage): void {
    const line = JSON.stringify(msg) + '\n';
    for (const c of conns.values()) {
      if (!c.authenticated || c.socket.destroyed) continue;
      const ok = c.socket.write(line);
      if (!ok) c.paused = true;
      checkBacklog(c);
    }
  }

  function fanOutOutput(sessionId: string, data: string): void {
    const subs = subscribers.get(sessionId);
    if (!subs || subs.size === 0) return;
    const msg: IpcServerMessage = { type: 'output', sessionId, data };
    const line = JSON.stringify(msg) + '\n';
    for (const cid of subs) {
      const c = conns.get(cid);
      if (!c || c.socket.destroyed) continue;
      const ok = c.socket.write(line);
      if (!ok) c.paused = true;
      checkBacklog(c);
    }
  }

  // Throttled per-session output rate logger. Logs once per second when there
  // has been any output, so we can correlate "i typed but nothing showed" with
  // whether the PTY actually produced bytes.
  const outputStats = new Map<
    string,
    { bytes: number; chunks: number; firstAt: number }
  >();
  function trackOutputStats(sessionId: string, bytes: number): void {
    const now = Date.now();
    let s = outputStats.get(sessionId);
    if (!s) {
      s = { bytes: 0, chunks: 0, firstAt: now };
      outputStats.set(sessionId, s);
    }
    s.bytes += bytes;
    s.chunks += 1;
    if (now - s.firstAt >= 1000) {
      const subs = subscribers.get(sessionId);
      log.debug('pty output rate', {
        sessionId,
        bytes: s.bytes,
        chunks: s.chunks,
        subs: subs ? subs.size : 0,
        windowMs: now - s.firstAt,
      });
      outputStats.delete(sessionId);
    }
  }

  // Wire SessionManager events. These run synchronously within the PTY data
  // dispatch tick, so any subscribe handler executing in this same tick is
  // already done before the next data event arrives — that gives us the
  // atomic "snapshot + subscribed + live" ordering invariant.
  sessions.on('created', (s) => {
    ensureBuffers(s.sessionId);
    broadcast({ type: 'created', session: infoFrom(s, 0) });
  });
  sessions.on('data', (sessionId, data) => {
    appendScrollback(sessionId, data);
    fanOutOutput(sessionId, data);
    trackOutputStats(sessionId, data.length);
  });
  sessions.on('exit', (sessionId, info: PtyExitInfo) => {
    const subs = subscribers.get(sessionId);
    if (subs && subs.size > 0) {
      const msg: IpcServerMessage = {
        type: 'exit',
        sessionId,
        exitCode: info.exitCode,
        signal: info.signal,
      };
      const line = JSON.stringify(msg) + '\n';
      for (const cid of subs) {
        const c = conns.get(cid);
        if (c && !c.socket.destroyed) c.socket.write(line);
      }
    }
  });
  sessions.on('removed', (sessionId) => {
    dropBuffers(sessionId);
    broadcast({ type: 'removed', sessionId });
  });

  function handleMessage(conn: Connection, msg: IpcClientMessage): void {
    if (msg.type === 'hello') {
      if (!AUTH_TOKEN || msg.token === AUTH_TOKEN) {
        conn.authenticated = true;
        sendRaw(conn, {
          type: 'hello',
          protocolVersion: IPC_PROTOCOL_VERSION,
          supervisorPid: process.pid,
          requiresAuth: !!AUTH_TOKEN,
          authenticated: true,
          defaults: { shell: defaultShell(), cols: DEFAULT_COLS, rows: DEFAULT_ROWS },
        });
        // Also send the existing session list so the gateway can rebuild state.
        sendRaw(conn, {
          type: 'sessions',
          sessions: sessions.list(),
          ...(msg.id !== undefined ? { id: msg.id } : {}),
        });
        return;
      }
      sendError(conn, 'unauthorized', 'invalid token', {
        ...(msg.id !== undefined ? { id: msg.id } : {}),
      });
      return;
    }
    if (!conn.authenticated) {
      sendError(conn, 'unauthorized', 'send `hello` first', {
        ...(msg.id !== undefined ? { id: msg.id } : {}),
      });
      return;
    }
    switch (msg.type) {
      case 'list': {
        sendRaw(conn, {
          type: 'sessions',
          sessions: sessions.list(),
          ...(msg.id !== undefined ? { id: msg.id } : {}),
        });
        return;
      }
      case 'create': {
        try {
          const session = sessions.create({
            ...(msg.sessionId !== undefined ? { sessionId: msg.sessionId } : {}),
            ...(msg.shell !== undefined ? { shell: msg.shell } : {}),
            ...(msg.args !== undefined ? { args: msg.args } : {}),
            ...(msg.cwd !== undefined ? { cwd: msg.cwd } : {}),
            ...(msg.env !== undefined ? { env: msg.env } : {}),
            ...(msg.cols !== undefined ? { cols: msg.cols } : {}),
            ...(msg.rows !== undefined ? { rows: msg.rows } : {}),
            ...(msg.track !== undefined ? { track: msg.track } : {}),
          });
          // Reply only to the requester; other gateways got the broadcast.
          sendRaw(conn, {
            type: 'created',
            session: infoFrom(session, 0),
            ...(msg.id !== undefined ? { id: msg.id } : {}),
          });
        } catch (e) {
          sendError(conn, 'spawn_failed', (e as Error).message, {
            ...(msg.id !== undefined ? { id: msg.id } : {}),
          });
        }
        return;
      }
      case 'create_ssh': {
        try {
          if (!msg.ssh || typeof msg.ssh.host !== 'string' || typeof msg.ssh.username !== 'string') {
            sendError(conn, 'invalid_message', 'create_ssh requires ssh.host and ssh.username', {
              ...(msg.id !== undefined ? { id: msg.id } : {}),
            });
            return;
          }
          const session = sessions.create({
            type: 'ssh',
            ...(msg.sessionId !== undefined ? { sessionId: msg.sessionId } : {}),
            host: msg.ssh.host,
            username: msg.ssh.username,
            ...(msg.ssh.port !== undefined ? { port: msg.ssh.port } : {}),
            ...(msg.ssh.privateKeyPath !== undefined ? { privateKeyPath: msg.ssh.privateKeyPath } : {}),
            ...(msg.ssh.passphrase !== undefined ? { passphrase: msg.ssh.passphrase } : {}),
            ...(msg.ssh.agent !== undefined ? { agent: msg.ssh.agent } : {}),
            ...(msg.ssh.initCommand !== undefined ? { initCommand: msg.ssh.initCommand } : {}),
            ...(msg.cols !== undefined ? { cols: msg.cols } : {}),
            ...(msg.rows !== undefined ? { rows: msg.rows } : {}),
          });
          sendRaw(conn, {
            type: 'created',
            session: infoFrom(session, 0),
            ...(msg.id !== undefined ? { id: msg.id } : {}),
          });
        } catch (e) {
          sendError(conn, 'spawn_failed', (e as Error).message, {
            ...(msg.id !== undefined ? { id: msg.id } : {}),
          });
        }
        return;
      }
      case 'subscribe': {
        const session = sessions.get(msg.sessionId);
        if (!session) {
          sendError(conn, 'unknown_session', `no such session: ${msg.sessionId}`, {
            sessionId: msg.sessionId,
            ...(msg.id !== undefined ? { id: msg.id } : {}),
          });
          return;
        }
        // Atomic: capture scrollback, send subscribed, then register as
        // subscriber — all within this tick, so no PTY data event runs in
        // between. Output produced after this point will be enqueued AFTER
        // the subscribed message on the same socket.
        const scrollbackData = snapshotScrollback(msg.sessionId);
        sendRaw(conn, {
          type: 'subscribed',
          sessionId: msg.sessionId,
          session: infoFrom(
            session,
            (subscribers.get(msg.sessionId)?.size ?? 0) + 1
          ),
          scrollback: scrollbackData,
          ...(msg.id !== undefined ? { id: msg.id } : {}),
        });
        ensureBuffers(msg.sessionId);
        subscribers.get(msg.sessionId)!.add(conn.id);
        conn.subscriptions.add(msg.sessionId);
        return;
      }
      case 'unsubscribe': {
        subscribers.get(msg.sessionId)?.delete(conn.id);
        conn.subscriptions.delete(msg.sessionId);
        sendRaw(conn, {
          type: 'unsubscribed',
          sessionId: msg.sessionId,
          ...(msg.id !== undefined ? { id: msg.id } : {}),
        });
        return;
      }
      case 'input': {
        const s = sessions.get(msg.sessionId);
        if (!s) {
          sendError(conn, 'unknown_session', `no such session: ${msg.sessionId}`, {
            sessionId: msg.sessionId,
            ...(msg.id !== undefined ? { id: msg.id } : {}),
          });
          return;
        }
        if (process.env['SHELL_DEBUG']) {
          log.info('ipc input', {
            connId: conn.id,
            sessionId: msg.sessionId,
            bytes: msg.data.length,
            alive: s.alive,
          });
        }
        s.write(msg.data);
        return;
      }
      case 'resize': {
        const s = sessions.get(msg.sessionId);
        if (!s) {
          sendError(conn, 'unknown_session', `no such session: ${msg.sessionId}`, {
            sessionId: msg.sessionId,
            ...(msg.id !== undefined ? { id: msg.id } : {}),
          });
          return;
        }
        s.resize(msg.cols, msg.rows);
        return;
      }
      case 'kill': {
        const s = sessions.get(msg.sessionId);
        if (!s) {
          sendError(conn, 'unknown_session', `no such session: ${msg.sessionId}`, {
            sessionId: msg.sessionId,
            ...(msg.id !== undefined ? { id: msg.id } : {}),
          });
          return;
        }
        s.kill(msg.signal);
        return;
      }
      default: {
        const _exhaustive: never = msg;
        void _exhaustive;
        sendError(conn, 'invalid_message', 'unknown message type');
        return;
      }
    }
  }

  function onConnection(socket: net.Socket): void {
    socket.setNoDelay(true);
    socket.setEncoding('utf8');
    const id = randomUUID();
    const conn: Connection = {
      id,
      socket,
      authenticated: !AUTH_TOKEN ? false : false, // require explicit hello either way
      buf: new NdjsonLineBuffer(IPC_MAX_LINE_BYTES),
      paused: false,
      subscriptions: new Set(),
      lastBacklogWarnAt: 0,
    };
    // If no auth token, the supervisor still requires a `hello` to bootstrap
    // (sends back the session list). So we don't pre-authenticate here.
    conns.set(id, conn);
    log.info('ipc gateway connected', { connId: id });

    socket.on('drain', () => {
      conn.paused = false;
    });
    socket.on('data', (chunk) => {
      const { lines, tooLong } = conn.buf.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      if (tooLong) {
        sendError(conn, 'line_too_long', `ipc line exceeded ${IPC_MAX_LINE_BYTES} bytes`);
      }
      for (const line of lines) {
        const parsed = parseIpcClientMessage(line);
        if ('_error' in parsed) {
          sendError(conn, 'invalid_message', parsed._error);
          continue;
        }
        try {
          handleMessage(conn, parsed);
        } catch (e) {
          log.error('ipc handler threw', { connId: id, error: (e as Error).message });
          sendError(conn, 'internal_error', (e as Error).message);
        }
      }
    });
    socket.on('error', (err) => {
      log.warn('ipc socket error', { connId: id, error: err.message });
    });
    socket.on('close', () => {
      for (const sid of conn.subscriptions) {
        subscribers.get(sid)?.delete(id);
      }
      conns.delete(id);
      log.info('ipc gateway disconnected', { connId: id });
    });
  }

  const server = net.createServer(onConnection);

  return new Promise<IpcServer>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      reject(
        new Error(
          err.code === 'EADDRINUSE'
            ? `another supervisor is already listening on ${pipePath}`
            : `failed to bind ipc pipe ${pipePath}: ${err.message}`
        )
      );
    });
    server.listen(pipePath, () => {
      log.info('supervisor ipc listening', { pipePath, requiresAuth: !!AUTH_TOKEN });
      server.removeAllListeners('error');
      server.on('error', (err) => log.error('ipc server error', { error: err.message }));
      resolve({
        close(): Promise<void> {
          return new Promise<void>((res) => {
            for (const c of conns.values()) {
              try {
                c.socket.destroy();
              } catch {
                // ignore
              }
            }
            server.close(() => res());
          });
        },
      });
    });
  });
}
