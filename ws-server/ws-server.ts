import { randomUUID } from 'crypto';
import type { IncomingMessage } from 'http';
import { monitorEventLoopDelay } from 'perf_hooks';
import { WebSocket, WebSocketServer } from 'ws';
import {
  AUTH_TOKEN,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  HOST,
  PORT,
  PROTOCOL_VERSION,
  defaultShell,
} from '../shared/shell-constants';
import { log } from './logger';
import {
  MULTITASKER_BACKEND_URL,
  MULTITASKER_INTEGRATION_ENABLED,
  MULTITASKER_SHELL_NAME_PREFIX,
} from './constants';
import { MultitaskerClient } from './multitasker-client';
import {
  parseClientMessage,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
} from '../shared/shell-protocol';
import { SupervisorClient } from './supervisor-client';
import { OutputAnalyzer, debugLogAgentStatus, type AgentStatusChange } from './output-analyzer';
import {
  HttpSessionsClient,
  type DesktopSessionInfo,
} from './http-sessions-client';

interface Client {
  id: string;
  ws: WebSocket;
  authenticated: boolean;
  remote: string;
  sourceApp: string;
  lastBufferWarnAt: number;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const WS_BUFFER_WARN_BYTES = 256 * 1024;
const WS_BUFFER_WARN_INTERVAL_MS = 1000;
const WS_BUFFER_DROP_BYTES = 8 * 1024 * 1024;
const WS_BUFFER_DROP_BYTES_DESKTOP = 64 * 1024 * 1024;

// Per-session, per-client desired terminal size. When multiple clients
// attach to the same PTY (e.g. xterm in multitasker + bridge-cli hosted
// in a VS Code terminal), each one sends its own dimensions. Without
// coordination the PTY flips between sizes on every resize, causing the
// agent's TUI to redraw at conflicting widths.
const clientDesiredSizes = new Map<string, Map<string, { cols: number; rows: number }>>();
const effectiveSizes = new Map<string, { cols: number; rows: number }>();

function isBashLikeShell(shellPath: string | undefined | null): boolean {
  if (!shellPath) return false;
  const base = String(shellPath).toLowerCase().split(/[\\/]/).pop() ?? '';
  return /(?:^|[._-])(?:bash|zsh|sh|fish|wsl)(?:\.exe)?$/.test(base);
}

function classifyShell(shellPath: string): 'powershell' | 'bash' {
  return isBashLikeShell(shellPath) ? 'bash' : 'powershell';
}

function safeWsSend(client: Client, payload: string): void {
  if (client.ws.readyState !== WebSocket.OPEN) return;
  client.ws.send(payload);
  const buffered = client.ws.bufferedAmount;
  const dropThreshold = client.sourceApp === 'desktop'
    ? WS_BUFFER_DROP_BYTES_DESKTOP
    : WS_BUFFER_DROP_BYTES;
  if (buffered > WS_BUFFER_WARN_BYTES) {
    const now = Date.now();
    if (now - client.lastBufferWarnAt > WS_BUFFER_WARN_INTERVAL_MS) {
      client.lastBufferWarnAt = now;
      log.warn('ws buffer growing', {
        clientId: client.id,
        sourceApp: client.sourceApp,
        bufferedAmount: buffered,
      });
    }
  }
  if (buffered > dropThreshold) {
    log.warn('ws buffer exceeded, terminating client', {
      clientId: client.id,
      sourceApp: client.sourceApp,
      bufferedAmount: buffered,
      dropThreshold,
    });
    try {
      client.ws.terminate();
    } catch {
      /* ignore */
    }
  }
}

export interface WsServerHandle {
  close: () => Promise<void>;
}

export function startWsServer(supervisor: SupervisorClient): WsServerHandle {
  const clients = new Map<string, Client>();
  /** sessionId -> set of WS client ids currently subscribed. */
  const sessionSubscribers = new Map<string, Set<string>>();
  /** clientId -> set of session ids that client is subscribed to. */
  const clientSubscriptions = new Map<string, Set<string>>();
  /** sessionId -> set of client ids watching status for this session. */
  const statusWatchers = new Map<string, Set<string>>();
  /** clientId -> set of session ids this client watches for status. */
  const clientStatusWatches = new Map<string, Set<string>>();
  const analyzer = new OutputAnalyzer();
  const httpSessions = new HttpSessionsClient();
  const multitasker = MULTITASKER_INTEGRATION_ENABLED
    ? new MultitaskerClient(MULTITASKER_BACKEND_URL)
    : null;

  // Event-loop delay monitor: samples the lag between scheduled timer fires
  // and actual fires. If this spikes when both viewers are attached, the
  // gateway loop is being blocked by something on the hotpath. Always on,
  // very cheap (~0 overhead).
  const elDelay = monitorEventLoopDelay({ resolution: 10 });
  elDelay.enable();
  const elLogTimer = setInterval(() => {
    const maxMs = elDelay.max / 1e6;
    const p99Ms = elDelay.percentile(99) / 1e6;
    const meanMs = elDelay.mean / 1e6;
    if (maxMs >= 50 || p99Ms >= 25) {
      log.warn('event loop lag', {
        meanMs: Number(meanMs.toFixed(2)),
        p99Ms: Number(p99Ms.toFixed(2)),
        maxMs: Number(maxMs.toFixed(2)),
        subs: clients.size,
        sessions: sessionSubscribers.size,
      });
    }
    elDelay.reset();
  }, 1000);
  if (typeof (elLogTimer as { unref?: () => void }).unref === 'function') {
    (elLogTimer as { unref: () => void }).unref();
  }


  const wss = new WebSocketServer({
    host: HOST,
    port: PORT,
    perMessageDeflate: false,
    verifyClient: (info, cb) => {
      const ip = info.req.socket.remoteAddress ?? '';
      if (!LOOPBACK.has(ip)) {
        log.warn('rejected non-loopback connection', { ip });
        cb(false, 403, 'forbidden');
        return;
      }
      cb(true);
    },
  });

  function subscribersOf(sessionId: string): Set<string> {
    let s = sessionSubscribers.get(sessionId);
    if (!s) {
      s = new Set();
      sessionSubscribers.set(sessionId, s);
    }
    return s;
  }

  function statusWatchersOf(sessionId: string): Set<string> {
    let s = statusWatchers.get(sessionId);
    if (!s) {
      s = new Set();
      statusWatchers.set(sessionId, s);
    }
    return s;
  }

  function shouldKeepSupervisorSubscription(sessionId: string): boolean {
    const subs = sessionSubscribers.get(sessionId);
    if (subs && subs.size > 0) return true;
    const watchers = statusWatchers.get(sessionId);
    return !!(watchers && watchers.size > 0);
  }

  function addSubscription(clientId: string, sessionId: string): void {
    subscribersOf(sessionId).add(clientId);
    let s = clientSubscriptions.get(clientId);
    if (!s) {
      s = new Set();
      clientSubscriptions.set(clientId, s);
    }
    s.add(sessionId);
  }

  function removeSubscription(clientId: string, sessionId: string): void {
    const subs = sessionSubscribers.get(sessionId);
    if (subs) {
      subs.delete(clientId);
      if (subs.size === 0) {
        sessionSubscribers.delete(sessionId);
        if (!shouldKeepSupervisorSubscription(sessionId)) {
          supervisor.unsubscribe(sessionId);
        }
      }
    }
    clientSubscriptions.get(clientId)?.delete(sessionId);
    forgetClientSize(clientId, sessionId);
  }

  function removeAllSubscriptions(clientId: string): void {
    const set = clientSubscriptions.get(clientId);
    if (!set) return;
    for (const sessionId of set) {
      const subs = sessionSubscribers.get(sessionId);
      if (subs) {
        subs.delete(clientId);
        if (subs.size === 0) {
          sessionSubscribers.delete(sessionId);
          if (!shouldKeepSupervisorSubscription(sessionId)) {
            supervisor.unsubscribe(sessionId);
          }
        }
      }
      forgetClientSize(clientId, sessionId);
    }
    clientSubscriptions.delete(clientId);
  }

  function addStatusWatch(clientId: string, sessionId: string): void {
    statusWatchersOf(sessionId).add(clientId);
    let set = clientStatusWatches.get(clientId);
    if (!set) {
      set = new Set();
      clientStatusWatches.set(clientId, set);
    }
    set.add(sessionId);
  }

  function removeStatusWatch(clientId: string, sessionId: string): void {
    const watchers = statusWatchers.get(sessionId);
    if (watchers) {
      watchers.delete(clientId);
      if (watchers.size === 0) {
        statusWatchers.delete(sessionId);
        if (!shouldKeepSupervisorSubscription(sessionId)) {
          supervisor.unsubscribe(sessionId);
        }
      }
    }
    clientStatusWatches.get(clientId)?.delete(sessionId);
  }

  function removeAllStatusWatches(clientId: string): void {
    const set = clientStatusWatches.get(clientId);
    if (!set) return;
    for (const sessionId of set) {
      const watchers = statusWatchers.get(sessionId);
      if (watchers) {
        watchers.delete(clientId);
        if (watchers.size === 0) {
          statusWatchers.delete(sessionId);
          if (!shouldKeepSupervisorSubscription(sessionId)) {
            supervisor.unsubscribe(sessionId);
          }
        }
      }
    }
    clientStatusWatches.delete(clientId);
  }

  function statusRecipientIds(sessionId: string): Set<string> {
    const out = new Set<string>();
    const subs = sessionSubscribers.get(sessionId);
    if (subs) {
      for (const cid of subs) out.add(cid);
    }
    const watchers = statusWatchers.get(sessionId);
    if (watchers) {
      for (const cid of watchers) out.add(cid);
    }
    return out;
  }

  function forgetClientSize(clientId: string, sessionId: string): void {
    const perClient = clientDesiredSizes.get(sessionId);
    if (!perClient) return;
    if (!perClient.delete(clientId)) return;
    if (perClient.size === 0) {
      clientDesiredSizes.delete(sessionId);
      effectiveSizes.delete(sessionId);
      return;
    }
    recomputeEffectiveSize(sessionId);
  }

  function applyClientResize(clientId: string, sessionId: string, cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return;
    let perClient = clientDesiredSizes.get(sessionId);
    if (!perClient) {
      perClient = new Map();
      clientDesiredSizes.set(sessionId, perClient);
    }
    perClient.set(clientId, { cols: Math.floor(cols), rows: Math.floor(rows) });
    recomputeEffectiveSize(sessionId);
  }

  function recomputeEffectiveSize(sessionId: string): void {
    const perClient = clientDesiredSizes.get(sessionId);
    if (!perClient || perClient.size === 0) return;
    // Take the min cols/rows across all attached clients so the PTY fits
    // in everyone's viewport. The larger client shows blank padding but
    // the agent's TUI renders correctly for both â€” no resize flapping.
    let minCols = Number.POSITIVE_INFINITY;
    let minRows = Number.POSITIVE_INFINITY;
    for (const sz of perClient.values()) {
      if (sz.cols < minCols) minCols = sz.cols;
      if (sz.rows < minRows) minRows = sz.rows;
    }
    if (!Number.isFinite(minCols) || !Number.isFinite(minRows)) return;
    const next = { cols: minCols, rows: minRows };
    const prev = effectiveSizes.get(sessionId);
    if (prev && prev.cols === next.cols && prev.rows === next.rows) return;
    effectiveSizes.set(sessionId, next);
    supervisor.resize(sessionId, next.cols, next.rows);
    analyzer.resize(sessionId, next.cols, next.rows);
    log.debug('pty resized (min across clients)', {
      sessionId,
      cols: next.cols,
      rows: next.rows,
      clients: perClient.size,
    });
  }

  // Throttled per-session output rate logger (WS side).
  const wsOutputStats = new Map<
    string,
    { bytes: number; chunks: number; firstAt: number }
  >();
  function trackWsOutput(sessionId: string, bytes: number, subCount: number): void {
    const now = Date.now();
    let s = wsOutputStats.get(sessionId);
    if (!s) {
      s = { bytes: 0, chunks: 0, firstAt: now };
      wsOutputStats.set(sessionId, s);
    }
    s.bytes += bytes;
    s.chunks += 1;
    if (now - s.firstAt >= 1000) {
      log.debug('ws output rate', {
        sourceApp: 'shell-supervisor',
        sessionId,
        bytes: s.bytes,
        chunks: s.chunks,
        subs: subCount,
        windowMs: now - s.firstAt,
      });
      wsOutputStats.delete(sessionId);
    }
  }

  /**
   * Broadcast an analyzer-emitted status change to all subscribers of the
   * session and to the multitasker http-server. Used by the idle-timeout
   * tick; the inline supervisor.on('output') / onInput paths predate this
   * helper and remain inlined to minimize blast radius.
   */
  function broadcastStatusChange(sessionId: string, change: AgentStatusChange): void {
    debugLogAgentStatus(sessionId, change);
    const occurredAt = Date.now();
    const statusMsg: ServerMessage = {
      type: 'agent_status',
      sessionId,
      status: change.status,
      agentKind: change.agentKind,
      occurredAt,
      ...(change.reason ? { reason: change.reason } : {}),
      ...(change.matchedText ? { matchedText: change.matchedText } : {}),
    };
    const serialized = JSON.stringify(statusMsg);
    const recipients = statusRecipientIds(sessionId);
    for (const cid of recipients) {
      const c = clients.get(cid);
      if (c) safeWsSend(c, serialized);
    }
    if (multitasker) {
      void multitasker.sendAgentStatus({
        shellSessionId: sessionId,
        status: change.status,
        agentKind: change.agentKind,
        occurredAt,
        ...(change.reason ? { reason: change.reason } : {}),
        ...(change.matchedText ? { matchedText: change.matchedText } : {}),
      });
    }
  }

  // Broadcast desktop session_updated event to all connected clients
  function broadcastDesktopSessionUpdated(session: DesktopSessionInfo): void {
    log.info('desktop session updated', { sourceApp: 'http-server', sessionId: session.id, status: session.status });
    const msg: ServerMessage = {
      type: 'desktop_session_updated',
      session,
    };
    const serialized = JSON.stringify(msg);
    for (const c of clients.values()) {
      safeWsSend(c, serialized);
    }
  }

  // Broadcast desktop session_removed event to all connected clients
  function broadcastDesktopSessionRemoved(sessionId: string): void {
    log.info('desktop session removed', { sourceApp: 'http-server', sessionId });
    const msg: ServerMessage = {
      type: 'desktop_session_removed',
      sessionId,
    };
    const serialized = JSON.stringify(msg);
    for (const c of clients.values()) {
      safeWsSend(c, serialized);
    }
  }

  async function sendDesktopSessionsSnapshot(
    client: Client,
    requestId?: string
  ): Promise<void> {
    const sessions = await httpSessions.listSessions();
    send(client, {
      type: 'desktop_sessions',
      sessions,
      ...(requestId !== undefined ? { id: requestId } : {}),
    });
  }


  // Periodic sweep: demote sessions that have been silently parked in
  // 'working' back to 'needs_input' after IDLE_TIMEOUT_MS of nothing happening.
  // Without this, the UI shows "running" forever for any session whose first
  // output didn't match a running indicator (typical for plain shells).
  //
  // Set MULTITASKER_DISABLE_ANALYZER=1 to skip status detection entirely
  // (useful to confirm whether the headless-xterm VT parse is the source
  // of any perceived input lag). When disabled, sessions stay 'working'
  // forever from the UI's POV â€” but raw output keeps flowing normally.
  const ANALYZER_DISABLED = process.env['MULTITASKER_DISABLE_ANALYZER'] === '1';
  if (ANALYZER_DISABLED) {
    log.info('analyzer disabled via MULTITASKER_DISABLE_ANALYZER=1');
  }
  const idleSweepTimer = setInterval(() => {
    if (ANALYZER_DISABLED) return;
    void analyzer.tick().then((changes) => {
      for (const { sessionId, change } of changes) {
        broadcastStatusChange(sessionId, change);
      }
    });
  }, 2000);
  if (typeof (idleSweepTimer as { unref?: () => void }).unref === 'function') {
    (idleSweepTimer as { unref: () => void }).unref();
  }

  // Coalesce PTY output per session before fan-out. TUIs like Codex flush
  // tiny chunks (sometimes 1â€“10B each, dozens per frame). Without batching,
  // every chunk costs one JSON.stringify + one ws.send per attached client
  // + one analyzer.onOutput (which writes into a headless xterm). With two
  // clients (e.g. bridge-cli inside VS Code + xterm.js in multitasker)
  // that pegs the event loop and shows up as input lag on BOTH viewers.
  //
  // We accumulate strings per session and flush on the next macrotask via
  // setImmediate, or earlier if we cross OUTPUT_COALESCE_FLUSH_BYTES. The
  // delay is sub-millisecond in practice (~1 event-loop tick), so it's
  // invisible to a human typing â€” but it collapses bursts of N tiny chunks
  // into a single fan-out, cutting per-byte overhead by an order of
  // magnitude when an agent's TUI is animating.
  const OUTPUT_COALESCE_FLUSH_BYTES = 64 * 1024;
  interface PendingOutput {
    parts: string[];
    bytes: number;
    scheduled: boolean;
  }
  const pendingOutput = new Map<string, PendingOutput>();

  function flushOutput(sessionId: string): void {
    const pending = pendingOutput.get(sessionId);
    if (!pending) return;
    pendingOutput.delete(sessionId);
    if (pending.parts.length === 0) return;
    const data = pending.parts.length === 1 ? pending.parts[0]! : pending.parts.join('');
    const subs = sessionSubscribers.get(sessionId);
    const subCount = subs ? subs.size : 0;
    if (subCount > 0) {
      const msg: ServerMessage = { type: 'output', sessionId, data };
      const serialized = JSON.stringify(msg);
      for (const cid of subs!) {
        const c = clients.get(cid);
        if (c) safeWsSend(c, serialized);
      }
    }
    trackWsOutput(sessionId, data.length, subCount);
    const change = ANALYZER_DISABLED ? null : analyzer.onOutput(sessionId, data);
    if (change) {
      broadcastStatusChange(sessionId, change);
    }
  }

  // Fan out PTY output from the supervisor to attached WS clients (coalesced).
  supervisor.on('output', (sessionId, data) => {
    if (!data || data.length === 0) return;
    let pending = pendingOutput.get(sessionId);
    if (!pending) {
      pending = { parts: [], bytes: 0, scheduled: false };
      pendingOutput.set(sessionId, pending);
    }
    pending.parts.push(data);
    pending.bytes += data.length;
    if (pending.bytes >= OUTPUT_COALESCE_FLUSH_BYTES) {
      flushOutput(sessionId);
      return;
    }
    if (!pending.scheduled) {
      pending.scheduled = true;
      setImmediate(() => flushOutput(sessionId));
    }
  });

  supervisor.on('exit', (sessionId, info) => {
    log.info('supervisor session exit', {
      sourceApp: 'shell-supervisor',
      sessionId,
      exitCode: info.exitCode,
      signal: info.signal,
    });
    // Flush any pending coalesced output so the 'exit' frame doesn't race
    // ahead of the final bytes the PTY produced before exiting.
    flushOutput(sessionId);
    analyzer.reset(sessionId);
    const subs = sessionSubscribers.get(sessionId);
    if (!subs || subs.size === 0) return;
    const msg: ServerMessage = {
      type: 'exit',
      sessionId,
      exitCode: info.exitCode,
      signal: info.signal,
    };
    const serialized = JSON.stringify(msg);
    for (const cid of subs) {
      const c = clients.get(cid);
      if (c) safeWsSend(c, serialized);
    }
  });

  supervisor.on('removed', (sessionId) => {
    log.info('supervisor session removed', { sourceApp: 'shell-supervisor', sessionId });
    pendingOutput.delete(sessionId);
    analyzer.reset(sessionId);
    sessionSubscribers.delete(sessionId);
    statusWatchers.delete(sessionId);
    clientDesiredSizes.delete(sessionId);
    effectiveSizes.delete(sessionId);
    for (const set of clientSubscriptions.values()) set.delete(sessionId);
    for (const set of clientStatusWatches.values()) set.delete(sessionId);
    if (multitasker) {
      void multitasker.removeSession(sessionId);
    }
  });

  supervisor.on('disconnected', () => {
    log.warn('supervisor disconnected; closing all ws clients', { sourceApp: 'shell-supervisor' });
    for (const c of clients.values()) {
      try {
        c.ws.close(1011, 'supervisor disconnected');
      } catch {
        // ignore
      }
    }
    sessionSubscribers.clear();
    clientSubscriptions.clear();
    statusWatchers.clear();
    clientStatusWatches.clear();
    clientDesiredSizes.clear();
    effectiveSizes.clear();
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const clientId = randomUUID();
    const client: Client = {
      id: clientId,
      ws,
      authenticated: !AUTH_TOKEN,
      remote: req.socket.remoteAddress ?? 'unknown',
      sourceApp: detectClientSourceApp(req),
      lastBufferWarnAt: 0,
    };
    clients.set(clientId, client);
    log.info('client connected', { sourceApp: client.sourceApp, clientId, remote: client.remote });

    const ready: ServerMessage = {
      type: 'ready',
      protocolVersion: PROTOCOL_VERSION,
      serverPid: process.pid,
      requiresAuth: !!AUTH_TOKEN,
      authenticated: client.authenticated,
      defaults: { shell: defaultShell(), cols: DEFAULT_COLS, rows: DEFAULT_ROWS },
    };
    ws.send(JSON.stringify(ready));

    ws.on('message', (raw) => {
      const text = typeof raw === 'string' ? raw : raw.toString('utf8');
      const parsed = parseClientMessage(text);
      if ('_error' in parsed) {
        sendError(client, 'invalid_message', parsed._error);
        return;
      }
      handleMessage(client, parsed).catch((e: unknown) => {
        log.error('handler threw', { sourceApp: client.sourceApp, clientId, error: (e as Error).message });
        sendError(client, 'internal_error', (e as Error).message);
      });
    });

    ws.on('close', () => {
      log.info('client disconnected', { sourceApp: client.sourceApp, clientId });
      removeAllSubscriptions(clientId);
      removeAllStatusWatches(clientId);
      clients.delete(clientId);
    });

    ws.on('error', (err) => {
      log.warn('client socket error', { sourceApp: client.sourceApp, clientId, error: err.message });
    });
  });

  wss.on('listening', () => {
    log.info('shell ws server listening', { host: HOST, port: PORT, requiresAuth: !!AUTH_TOKEN });
  });

  wss.on('error', (err) => {
    log.error('ws server error', { error: err.message });
  });

  function send(client: Client, msg: ServerMessage): void {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(msg));
    }
  }

  function sendError(
    client: Client,
    code: ErrorCode,
    message: string,
    extra?: { sessionId?: string; id?: string }
  ): void {
    const msg: ServerMessage = {
      type: 'error',
      code,
      message,
      ...(extra?.sessionId !== undefined ? { sessionId: extra.sessionId } : {}),
      ...(extra?.id !== undefined ? { id: extra.id } : {}),
    };
    send(client, msg);
  }

  function normalizeOccurredAt(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return Date.now();
    }
    return value;
  }

  function detectClientSourceApp(req: IncomingMessage): string {
    const userAgent = String(req.headers['user-agent'] ?? '').toLowerCase();
    if (userAgent.includes('electron')) return 'desktop';
    if (userAgent.includes('node')) return 'node-ws-client';
    return 'ws-client';
  }

  function sourceAppForClientMessage(client: Client, msg: ClientMessage): string {
    if (msg.type === 'create_session' && msg.clientMetadata?.kind === 'vscode') {
      return 'bridge-cli/vscode';
    }
    return client.sourceApp;
  }

  function broadcastSessionEvent(sessionId: string, msg: ServerMessage): void {
    const serialized = JSON.stringify(msg);
    const subs = sessionSubscribers.get(sessionId);
    if (!subs) return;
    for (const cid of subs) {
      const c = clients.get(cid);
      if (c) safeWsSend(c, serialized);
    }
  }

  function requireAuth(client: Client, msg: ClientMessage): boolean {
    if (client.authenticated) return true;
    sendError(client, 'unauthorized', 'authenticate with a `hello` message first', {
      ...(msg.id !== undefined ? { id: msg.id } : {}),
    });
    return false;
  }

  async function attachClientToSession(
    client: Client,
    sessionId: string,
    requestId: string | undefined
  ): Promise<void> {
    let info;
    try {
      const { session, scrollback } = await supervisor.ensureSubscribed(sessionId);
      info = session;
      addSubscription(client.id, sessionId);
      send(client, {
        type: 'attached',
        sessionId,
        pid: info.pid,
        shell: info.shell,
        cwd: info.cwd,
        cols: info.cols,
        rows: info.rows,
        ...(info.kind !== undefined ? { kind: info.kind } : {}),
        ...(requestId !== undefined ? { id: requestId } : {}),
      });
      log.info('ws attached', { sourceApp: client.sourceApp, clientId: client.id, sessionId, pid: info.pid, scrollbackBytes: scrollback.length });
      if (scrollback.length > 0) {
        send(client, { type: 'output', sessionId, data: scrollback, replay: true });
      }
    } catch (e) {
      log.warn('ws attach failed', { sourceApp: client.sourceApp, clientId: client.id, sessionId, error: (e as Error).message });
      sendError(client, 'unknown_session', (e as Error).message, {
        sessionId,
        ...(requestId !== undefined ? { id: requestId } : {}),
      });
    }
  }

  async function handleMessage(client: Client, msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case 'hello': {
        if (!AUTH_TOKEN) {
          client.authenticated = true;
          send(client, { type: 'authenticated', ...(msg.id !== undefined ? { id: msg.id } : {}) });
          await sendDesktopSessionsSnapshot(client);
          return;
        }
        if (msg.token === AUTH_TOKEN) {
          client.authenticated = true;
          send(client, { type: 'authenticated', ...(msg.id !== undefined ? { id: msg.id } : {}) });
          await sendDesktopSessionsSnapshot(client);
        } else {
          sendError(client, 'unauthorized', 'invalid token', {
            ...(msg.id !== undefined ? { id: msg.id } : {}),
          });
        }
        return;
      }
      case 'ping': {
        send(client, { type: 'pong', ...(msg.id !== undefined ? { id: msg.id } : {}) });
        return;
      }
      case 'list_sessions': {
        if (!requireAuth(client, msg)) return;
        send(client, {
          type: 'sessions',
          sessions: supervisor.list().map((s) => ({
            ...s,
            subscribers: sessionSubscribers.get(s.sessionId)?.size ?? 0,
          })),
          ...(msg.id !== undefined ? { id: msg.id } : {}),
        });
        return;
      }
      case 'list_desktop_sessions': {
        if (!requireAuth(client, msg)) return;
        await sendDesktopSessionsSnapshot(client, msg.id);
        return;
      }
      case 'create_session': {
        if (!requireAuth(client, msg)) return;
        try {
          const session = await supervisor.create({
            ...(msg.sessionId !== undefined ? { sessionId: msg.sessionId } : {}),
            ...(msg.shell !== undefined ? { shell: msg.shell } : {}),
            ...(msg.args !== undefined ? { args: msg.args } : {}),
            ...(msg.cwd !== undefined ? { cwd: msg.cwd } : {}),
            ...(msg.env !== undefined ? { env: msg.env } : {}),
            ...(msg.cols !== undefined ? { cols: msg.cols } : {}),
            ...(msg.rows !== undefined ? { rows: msg.rows } : {}),
            ...(msg.track !== undefined ? { track: msg.track } : {}),
          });
          // Hint the analyzer about the command being run (e.g. `codex`) so it
          // can pin the agent kind before the first output arrives.
          const cmdHint = [msg.shell, ...(msg.args ?? [])].filter(Boolean).join(' ');
          if (cmdHint) analyzer.onCommandLine(session.sessionId, cmdHint);
          // Forward client metadata (e.g. VS Code env) to the multitasker
          // http-server. We post async â€” if it races with the supervisor's
          // own /api/session/create, the http-server stores it in a pending
          // map and applies it once the session exists.
          if (msg.clientMetadata && multitasker) {
            void multitasker.sendClientMetadata({
              shellSessionId: session.sessionId,
              clientMetadata: msg.clientMetadata,
            });
          }
          if (multitasker && msg.track !== false && session.kind !== 'ssh') {
            const shortId = session.sessionId.slice(0, 8);
            const name = `${MULTITASKER_SHELL_NAME_PREFIX} ${shortId}`;
            void multitasker.createSession({
              name,
              cmd: '',
              cwd: session.cwd,
              shellType: classifyShell(session.shell),
              shellSessionId: session.sessionId,
              requestedId: session.sessionId,
            });
          }
          send(client, {
            type: 'session_created',
            sessionId: session.sessionId,
            pid: session.pid,
            shell: session.shell,
            cwd: session.cwd,
            cols: session.cols,
            rows: session.rows,
            ...(session.kind !== undefined ? { kind: session.kind } : {}),
            ...(msg.id !== undefined ? { id: msg.id } : {}),
          });
          if (msg.attach !== false) {
            await attachClientToSession(client, session.sessionId, undefined);
          }
        } catch (e) {
          sendError(client, 'spawn_failed', (e as Error).message, {
            ...(msg.id !== undefined ? { id: msg.id } : {}),
          });
        }
        return;
      }
      case 'create_ssh_session': {
        if (!requireAuth(client, msg)) return;
        try {
          const session = await supervisor.createSsh({
            ...(msg.sessionId !== undefined ? { sessionId: msg.sessionId } : {}),
            ssh: msg.ssh,
            ...(msg.cols !== undefined ? { cols: msg.cols } : {}),
            ...(msg.rows !== undefined ? { rows: msg.rows } : {}),
          });
          send(client, {
            type: 'session_created',
            sessionId: session.sessionId,
            pid: session.pid,
            shell: session.shell,
            cwd: session.cwd,
            cols: session.cols,
            rows: session.rows,
            ...(session.kind !== undefined ? { kind: session.kind } : {}),
            ...(msg.id !== undefined ? { id: msg.id } : {}),
          });
          if (msg.attach !== false) {
            await attachClientToSession(client, session.sessionId, undefined);
          }
        } catch (e) {
          sendError(client, 'spawn_failed', (e as Error).message, {
            ...(msg.id !== undefined ? { id: msg.id } : {}),
          });
        }
        return;
      }
      case 'attach': {
        if (!requireAuth(client, msg)) return;
        const session = supervisor.getSession(msg.sessionId);
        if (!session) {
          sendError(client, 'unknown_session', `no such session: ${msg.sessionId}`, {
            sessionId: msg.sessionId,
            ...(msg.id !== undefined ? { id: msg.id } : {}),
          });
          return;
        }
        await attachClientToSession(client, msg.sessionId, msg.id);
        return;
      }
      case 'watch_status': {
        if (!requireAuth(client, msg)) return;
        const session = supervisor.getSession(msg.sessionId);
        if (!session) {
          sendError(client, 'unknown_session', `no such session: ${msg.sessionId}`, {
            sessionId: msg.sessionId,
            ...(msg.id !== undefined ? { id: msg.id } : {}),
          });
          return;
        }
        addStatusWatch(client.id, msg.sessionId);
        try {
          await supervisor.ensureSubscribed(msg.sessionId);
        } catch (e) {
          removeStatusWatch(client.id, msg.sessionId);
          sendError(client, 'unknown_session', (e as Error).message, {
            sessionId: msg.sessionId,
            ...(msg.id !== undefined ? { id: msg.id } : {}),
          });
        }
        return;
      }
      case 'unwatch_status': {
        if (!requireAuth(client, msg)) return;
        removeStatusWatch(client.id, msg.sessionId);
        return;
      }
      case 'detach': {
        if (!requireAuth(client, msg)) return;
        removeSubscription(client.id, msg.sessionId);
        send(client, {
          type: 'detached',
          sessionId: msg.sessionId,
          ...(msg.id !== undefined ? { id: msg.id } : {}),
        });
        return;
      }
      case 'user_typing': {
        if (!requireAuth(client, msg)) return;
        if (!supervisor.getSession(msg.sessionId)) {
          sendError(client, 'unknown_session', `no such session: ${msg.sessionId}`, {
            sessionId: msg.sessionId,
            ...(msg.id !== undefined ? { id: msg.id } : {}),
          });
          return;
        }
        const occurredAt = normalizeOccurredAt(msg.occurredAt);
        analyzer.onUserTyping(msg.sessionId, !!msg.isTyping, occurredAt);
        log.info('user_typing', {
          sourceApp: sourceAppForClientMessage(client, msg),
          clientId: client.id,
          sessionId: msg.sessionId,
          isTyping: !!msg.isTyping,
          occurredAt,
        });
        broadcastSessionEvent(msg.sessionId, {
          type: 'user_typing',
          sessionId: msg.sessionId,
          isTyping: !!msg.isTyping,
          occurredAt,
          sourceClientId: client.id,
        });
        return;
      }
      case 'terminal_focus': {
        if (!requireAuth(client, msg)) return;
        if (!supervisor.getSession(msg.sessionId)) {
          sendError(client, 'unknown_session', `no such session: ${msg.sessionId}`, {
            sessionId: msg.sessionId,
            ...(msg.id !== undefined ? { id: msg.id } : {}),
          });
          return;
        }
        const occurredAt = normalizeOccurredAt(msg.occurredAt);
        analyzer.onTerminalFocus(msg.sessionId, !!msg.focused, occurredAt);
        log.info('terminal_focus', {
          sourceApp: sourceAppForClientMessage(client, msg),
          clientId: client.id,
          sessionId: msg.sessionId,
          focused: !!msg.focused,
          occurredAt,
        });
        broadcastSessionEvent(msg.sessionId, {
          type: 'terminal_focus',
          sessionId: msg.sessionId,
          focused: !!msg.focused,
          occurredAt,
          sourceClientId: client.id,
        });
        return;
      }
      case 'input': {
        if (!requireAuth(client, msg)) return;
        // Translate BS (0x08) â†’ DEL (0x7F) for non-bash shells. PSReadLine
        // on Windows binds Ctrl+H (== ASCII BS 0x08) to BackwardKillWord
        // (delete previous word), while DEL (0x7F) is what it expects for
        // the Backspace key (BackwardDeleteChar). Some clients (including
        // older bridge-cli builds) helpfully convert their xterm DEL into
        // BS thinking they're "normalizing"; that actually CAUSES the
        // word-delete bug. We re-normalize here so every input source
        // ends up sending DEL for the Backspace key.
        const sessionForInput = supervisor.getSession(msg.sessionId);
        if (
          sessionForInput &&
          msg.data.indexOf('\x08') !== -1 &&
          !isBashLikeShell(sessionForInput.shell)
        ) {
          msg.data = msg.data.replace(/\x08/g, '\x7f');
        }
        // Hotpath: no per-keystroke logging. Codex/Claude TUIs were laggy
        // because each keystroke triggered synchronous stderr + file writes.
        // Tell the output analyzer that the user typed something â€” it uses
        // this as an independent signal to suppress stale needs_input
        // detections from the visual regex (and to force a running
        // transition when the user clearly answered a prompt).
        const userInputChange = analyzer.onInput(msg.sessionId, msg.data);
        if (userInputChange) {
          broadcastStatusChange(msg.sessionId, userInputChange);
        }
        supervisor.input(msg.sessionId, msg.data);
        return;
      }
      case 'resize': {
        if (!requireAuth(client, msg)) return;
        if (!supervisor.getSession(msg.sessionId)) {
          sendError(client, 'unknown_session', `no such session: ${msg.sessionId}`, {
            sessionId: msg.sessionId,
            ...(msg.id !== undefined ? { id: msg.id } : {}),
          });
          return;
        }
        applyClientResize(client.id, msg.sessionId, msg.cols, msg.rows);
        return;
      }
      case 'kill': {
        if (!requireAuth(client, msg)) return;
        if (!supervisor.getSession(msg.sessionId)) {
          sendError(client, 'unknown_session', `no such session: ${msg.sessionId}`, {
            sessionId: msg.sessionId,
            ...(msg.id !== undefined ? { id: msg.id } : {}),
          });
          return;
        }
        supervisor.kill(msg.sessionId, msg.signal);
        return;
      }
      case 'rename_session': {
        if (!requireAuth(client, msg)) return;
        const updated = await httpSessions.renameSession(msg.sessionId, msg.name);
        if (updated) {
          send(client, { type: 'desktop_session_updated', session: updated, ...(msg.id !== undefined ? { id: msg.id } : {}) });
          broadcastDesktopSessionUpdated(updated);
        } else {
          sendError(client, 'unknown_session', `failed to rename session: ${msg.sessionId}`, {
            sessionId: msg.sessionId,
            ...(msg.id !== undefined ? { id: msg.id } : {}),
          });
        }
        return;
      }
      case 'remove_session': {
        if (!requireAuth(client, msg)) return;
        const success = await httpSessions.removeSession(msg.sessionId);
        if (success) {
          send(client, { type: 'desktop_session_removed', sessionId: msg.sessionId, ...(msg.id !== undefined ? { id: msg.id } : {}) });
          broadcastDesktopSessionRemoved(msg.sessionId);
        } else {
          sendError(client, 'unknown_session', `failed to remove session: ${msg.sessionId}`, {
            sessionId: msg.sessionId,
            ...(msg.id !== undefined ? { id: msg.id } : {}),
          });
        }
        return;
      }
      case 'touch_session': {
        if (!requireAuth(client, msg)) return;
        const updated = await httpSessions.touchSession(msg.sessionId);
        if (updated) {
          send(client, { type: 'desktop_session_updated', session: updated, ...(msg.id !== undefined ? { id: msg.id } : {}) });
          broadcastDesktopSessionUpdated(updated);
        } else {
          sendError(client, 'unknown_session', `failed to touch session: ${msg.sessionId}`, {
            sessionId: msg.sessionId,
            ...(msg.id !== undefined ? { id: msg.id } : {}),
          });
        }
        return;
      }
      default: {
        const _exhaustive: never = msg;
        void _exhaustive;
        sendError(client, 'invalid_message', `unknown message type`);
        return;
      }
    }
  }

  async function close(): Promise<void> {
    clearInterval(idleSweepTimer);
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
      for (const c of clients.values()) {
        try {
          c.ws.close();
        } catch {
          // ignore
        }
      }
    });
  }

  return { close };
}
