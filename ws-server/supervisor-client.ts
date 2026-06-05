import { EventEmitter } from 'events';
import * as net from 'net';
import { AUTH_TOKEN } from '../shell/core/constants';
import { log } from './logger';
import type { SessionInfo, SshConnectOptions } from '../shell/core/protocol';
import {
  IPC_MAX_LINE_BYTES,
  NdjsonLineBuffer,
  parseIpcServerMessage,
  type IpcClientMessage,
  type IpcServerMessage,
} from '../shell/ipc/protocol';

const CONNECT_RETRY_MIN_MS = 100;
const CONNECT_RETRY_MAX_MS = 2000;
const REQUEST_TIMEOUT_MS = 8000;
const SCROLLBACK_BYTES_PER_SESSION = 256 * 1024;

export interface PtyExitInfo {
  exitCode: number;
  signal: number | null;
}

export interface CreateOpts {
  sessionId?: string;
  shell?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  track?: boolean;
}

interface ScrollbackBuffer {
  chunks: Array<{ bytes: number; data: string }>;
  totalBytes: number;
}

interface PendingRequest {
  resolve: (msg: IpcServerMessage) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  /** Expected response types that resolve this request. */
  resolveOn: ReadonlySet<IpcServerMessage['type']>;
}

export declare interface SupervisorClient {
  on(event: 'ready', listener: (sessions: SessionInfo[]) => void): this;
  on(event: 'output', listener: (sessionId: string, data: string) => void): this;
  on(event: 'exit', listener: (sessionId: string, info: PtyExitInfo) => void): this;
  on(event: 'created', listener: (session: SessionInfo) => void): this;
  on(event: 'removed', listener: (sessionId: string) => void): this;
  on(event: 'disconnected', listener: () => void): this;
}

/**
 * Talks to the long-lived supervisor process over the local IPC pipe. Owns
 * a small per-session scrollback buffer so additional WS clients attaching
 * to an already-subscribed session can replay history without round-tripping
 * to the supervisor.
 */
export class SupervisorClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private buf = new NdjsonLineBuffer(IPC_MAX_LINE_BYTES);
  private destroyed = false;
  private nextReqId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly sessionCache = new Map<string, SessionInfo>();
  private readonly subscribed = new Set<string>();
  private readonly localScrollback = new Map<string, ScrollbackBuffer>();
  private retryDelay = CONNECT_RETRY_MIN_MS;
  private firstReadyResolve: ((sessions: SessionInfo[]) => void) | null = null;
  private firstReadyPromise: Promise<SessionInfo[]>;

  constructor(private readonly pipePath: string) {
    super();
    this.firstReadyPromise = new Promise<SessionInfo[]>((resolve) => {
      this.firstReadyResolve = resolve;
    });
  }

  /** Resolves with the initial session list once connected & authenticated. */
  waitForReady(): Promise<SessionInfo[]> {
    return this.firstReadyPromise;
  }

  /** Begin connecting; retries with exponential backoff. */
  start(): void {
    this.connect();
  }

  stop(): void {
    this.destroyed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('supervisor client stopped'));
    }
    this.pending.clear();
    if (this.socket && !this.socket.destroyed) {
      try {
        this.socket.destroy();
      } catch {
        // ignore
      }
    }
    this.socket = null;
  }

  getSession(sessionId: string): SessionInfo | undefined {
    return this.sessionCache.get(sessionId);
  }

  list(): SessionInfo[] {
    return Array.from(this.sessionCache.values());
  }

  scrollbackFor(sessionId: string): string {
    const buf = this.localScrollback.get(sessionId);
    if (!buf || buf.chunks.length === 0) return '';
    return buf.chunks.map((c) => c.data).join('');
  }

  async create(opts: CreateOpts): Promise<SessionInfo> {
    const reply = await this.request(
      { type: 'create', ...opts },
      new Set(['created', 'error'])
    );
    if (reply.type === 'error') throw new Error(`${reply.code}: ${reply.message}`);
    if (reply.type !== 'created') throw new Error('unexpected reply to create');
    this.sessionCache.set(reply.session.sessionId, reply.session);
    return reply.session;
  }

  async createSsh(opts: {
    sessionId?: string;
    ssh: SshConnectOptions;
    cols?: number;
    rows?: number;
  }): Promise<SessionInfo> {
    const reply = await this.request(
      {
        type: 'create_ssh',
        ssh: opts.ssh,
        ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
        ...(opts.cols !== undefined ? { cols: opts.cols } : {}),
        ...(opts.rows !== undefined ? { rows: opts.rows } : {}),
      },
      new Set(['created', 'error'])
    );
    if (reply.type === 'error') throw new Error(`${reply.code}: ${reply.message}`);
    if (reply.type !== 'created') throw new Error('unexpected reply to create_ssh');
    this.sessionCache.set(reply.session.sessionId, reply.session);
    return reply.session;
  }

  /**
   * Ensure the supervisor is streaming output for this session. Returns the
   * full scrollback known so far (from the supervisor's ring buffer on first
   * subscribe, or from our local buffer on subsequent calls).
   */
  async ensureSubscribed(sessionId: string): Promise<{ session: SessionInfo; scrollback: string }> {
    if (this.subscribed.has(sessionId)) {
      const cached = this.sessionCache.get(sessionId);
      if (!cached) throw new Error(`session ${sessionId} not in cache`);
      return { session: cached, scrollback: this.scrollbackFor(sessionId) };
    }
    const reply = await this.request(
      { type: 'subscribe', sessionId },
      new Set(['subscribed', 'error'])
    );
    if (reply.type === 'error') throw new Error(`${reply.code}: ${reply.message}`);
    if (reply.type !== 'subscribed') throw new Error('unexpected reply to subscribe');
    this.subscribed.add(sessionId);
    this.sessionCache.set(reply.sessionId, reply.session);
    // Seed local buffer with the supervisor's scrollback so future WS clients
    // can be served without round-tripping.
    if (reply.scrollback.length > 0) {
      this.localScrollback.set(sessionId, { chunks: [], totalBytes: 0 });
      this.appendLocalScrollback(sessionId, reply.scrollback);
    } else {
      this.localScrollback.set(sessionId, { chunks: [], totalBytes: 0 });
    }
    return { session: reply.session, scrollback: reply.scrollback };
  }

  unsubscribe(sessionId: string): void {
    if (!this.subscribed.has(sessionId)) return;
    this.subscribed.delete(sessionId);
    this.localScrollback.delete(sessionId);
    this.send({ type: 'unsubscribe', sessionId });
  }

  input(sessionId: string, data: string): void {
    this.send({ type: 'input', sessionId, data });
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.send({ type: 'resize', sessionId, cols, rows });
  }

  kill(sessionId: string, signal?: string): void {
    this.send({ type: 'kill', sessionId, ...(signal !== undefined ? { signal } : {}) });
  }

  // ---- internals ----

  private appendLocalScrollback(sessionId: string, data: string): void {
    const buf = this.localScrollback.get(sessionId);
    if (!buf) return;
    const bytes = Buffer.byteLength(data, 'utf8');
    buf.chunks.push({ bytes, data });
    buf.totalBytes += bytes;
    while (buf.totalBytes > SCROLLBACK_BYTES_PER_SESSION && buf.chunks.length > 1) {
      const removed = buf.chunks.shift();
      if (removed) buf.totalBytes -= removed.bytes;
    }
  }

  private connect(): void {
    if (this.destroyed) return;
    const socket = net.createConnection({ path: this.pipePath });
    socket.setEncoding('utf8');
    this.socket = socket;
    this.buf = new NdjsonLineBuffer(IPC_MAX_LINE_BYTES);

    socket.once('connect', () => {
      log.info('supervisor client connected', { pipePath: this.pipePath });
      this.retryDelay = CONNECT_RETRY_MIN_MS;
      const hello: IpcClientMessage = { type: 'hello' };
      if (AUTH_TOKEN) hello.token = AUTH_TOKEN;
      socket.write(JSON.stringify(hello) + '\n');
    });

    socket.on('data', (chunk) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const { lines, tooLong } = this.buf.push(text);
      if (tooLong) {
        log.warn('supervisor sent oversized ipc line, dropping connection');
        socket.destroy(new Error('oversized ipc line'));
        return;
      }
      for (const line of lines) {
        const parsed = parseIpcServerMessage(line);
        if ('_error' in parsed) {
          log.warn('bad ipc message from supervisor', { error: parsed._error });
          continue;
        }
        this.handleMessage(parsed);
      }
    });

    socket.on('error', (err) => {
      log.warn('supervisor client socket error', { error: err.message });
    });

    socket.on('close', () => {
      this.socket = null;
      this.subscribed.clear();
      this.localScrollback.clear();
      // Fail any pending requests so callers don't hang.
      for (const [reqId, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('supervisor connection closed'));
        this.pending.delete(reqId);
      }
      this.emit('disconnected');
      if (this.destroyed) return;
      log.info('supervisor client disconnected, reconnecting', { delayMs: this.retryDelay });
      const delay = this.retryDelay;
      this.retryDelay = Math.min(this.retryDelay * 2, CONNECT_RETRY_MAX_MS);
      setTimeout(() => this.connect(), delay);
    });
  }

  private handleMessage(msg: IpcServerMessage): void {
    switch (msg.type) {
      case 'hello': {
        // Supervisor will follow with a `sessions` snapshot triggered by our hello.
        return;
      }
      case 'sessions': {
        this.sessionCache.clear();
        for (const s of msg.sessions) this.sessionCache.set(s.sessionId, s);
        if (this.firstReadyResolve) {
          this.firstReadyResolve(msg.sessions);
          this.firstReadyResolve = null;
        }
        this.emit('ready', msg.sessions);
        // Also resolve a pending list() request, if any.
        this.resolvePending(msg);
        return;
      }
      case 'created': {
        this.sessionCache.set(msg.session.sessionId, msg.session);
        this.emit('created', msg.session);
        this.resolvePending(msg);
        return;
      }
      case 'subscribed': {
        this.sessionCache.set(msg.session.sessionId, msg.session);
        this.resolvePending(msg);
        return;
      }
      case 'unsubscribed': {
        this.resolvePending(msg);
        return;
      }
      case 'output': {
        if (this.subscribed.has(msg.sessionId)) {
          this.appendLocalScrollback(msg.sessionId, msg.data);
        }
        this.emit('output', msg.sessionId, msg.data);
        return;
      }
      case 'exit': {
        this.emit('exit', msg.sessionId, { exitCode: msg.exitCode, signal: msg.signal });
        return;
      }
      case 'removed': {
        this.sessionCache.delete(msg.sessionId);
        this.subscribed.delete(msg.sessionId);
        this.localScrollback.delete(msg.sessionId);
        this.emit('removed', msg.sessionId);
        return;
      }
      case 'authenticated': {
        this.resolvePending(msg);
        return;
      }
      case 'error': {
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          this.resolvePending(msg);
        } else {
          log.warn('supervisor reported error', { code: msg.code, message: msg.message });
        }
        return;
      }
      default: {
        const _exhaustive: never = msg;
        void _exhaustive;
        return;
      }
    }
  }

  private resolvePending(msg: IpcServerMessage): void {
    if (msg.type === 'error' && msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        p.resolve(msg);
      }
      return;
    }
    // Find a pending request whose resolveOn set includes this message type
    // and whose id matches (if the message carries one).
    const carriedId = (msg as { id?: string }).id;
    if (carriedId !== undefined) {
      const p = this.pending.get(carriedId);
      if (p && p.resolveOn.has(msg.type)) {
        clearTimeout(p.timer);
        this.pending.delete(carriedId);
        p.resolve(msg);
      }
    }
  }

  private send(msg: IpcClientMessage): void {
    if (!this.socket || this.socket.destroyed) {
      log.warn('dropping ipc message: not connected', { type: msg.type });
      return;
    }
    try {
      this.socket.write(JSON.stringify(msg) + '\n');
    } catch (e) {
      log.warn('ipc send failed', { error: (e as Error).message });
    }
  }

  private request(
    msg: IpcClientMessage,
    resolveOn: ReadonlySet<IpcServerMessage['type']>
  ): Promise<IpcServerMessage> {
    const id = `r${this.nextReqId++}`;
    const full: IpcClientMessage = { ...(msg as object), id } as IpcClientMessage;
    return new Promise<IpcServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`ipc request '${msg.type}' timed out`));
        }
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer, resolveOn });
      if (!this.socket || this.socket.destroyed) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('supervisor not connected'));
        return;
      }
      try {
        this.socket.write(JSON.stringify(full) + '\n');
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }
}
