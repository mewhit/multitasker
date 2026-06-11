type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
type Logger = {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
  debug(msg: string, meta?: unknown): void;
};

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

function resolveLevel(): LogLevel {
  const raw = (process.env['SHELL_LOG_LEVEL'] ?? '').trim().toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' || raw === 'silent') {
    return raw;
  }
  // Back-compat: SHELL_DEBUG=1 implies debug level.
  if (process.env['SHELL_DEBUG']) return 'debug';
  return 'info';
}

const currentLevel = LEVEL_ORDER[resolveLevel()];

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= currentLevel;
}

function ts(): string {
  return new Date().toISOString();
}

function fmt(component: string, level: string, msg: string, meta?: unknown, defaultSourceApp = ''): string {
  const sourceApp = extractSourceApp(meta) || defaultSourceApp;
  const base = sourceApp
    ? `[${ts()}]-[${component}]-[${sourceApp}]-[${level}] ${msg}`
    : `[${ts()}] [${component}] [${level}] ${msg}`;
  if (meta === undefined) return base;
  try {
    const serializedMeta = JSON.stringify(logMeta(meta));
    return serializedMeta === undefined ? base : `${base} ${serializedMeta}`;
  } catch {
    return `${base} <unserializable meta>`;
  }
}

function extractSourceApp(meta: unknown): string {
  if (!meta || typeof meta !== 'object') return '';
  const record = meta as Record<string, unknown>;
  const value = record['sourceApp'] ?? record['appName'];
  return typeof value === 'string' ? value.trim() : '';
}

function logMeta(meta: unknown): unknown {
  if (!meta || typeof meta !== 'object') return meta;
  const record = meta as Record<string, unknown>;
  if (!('sourceApp' in record) && !('appName' in record)) return meta;
  const { sourceApp: _sourceApp, appName: _appName, ...rest } = record;
  void _sourceApp;
  void _appName;
  if (Object.keys(rest).length === 0) return undefined;
  return rest;
}

// Per-session files are Markdown so they are readable as plain text and can be
// colourized by Markdown previews without writing raw ANSI escapes to disk.
function fmtSessionLine(component: string, level: string, msg: string, meta?: unknown): string {
  const metaObj = (meta && typeof meta === 'object') ? meta as Record<string, unknown> : null;
  const metaStr = meta !== undefined ? markdownInline((() => { try { return JSON.stringify(meta); } catch { return '<unserializable>'; } })()) : '';
  const now = new Date();
  const header = `- \`${timeOnly(now)}\` ${markdownLevel(level)} <span style="color:#64748b">[${markdownInline(component)}]</span>`;
  const statusHeader = `- \`${timeOnly(now)}\``;
  const componentTag = `<span style="color:#64748b">[${markdownInline(component)}]</span>`;

  // Status transitions - most important, keep the result status easy to spot.
  if (msg === 'agent_status_transition') {
    const from = metaObj?.['fromStatus'] ?? '?';
    const to   = metaObj?.['toStatus']   ?? '?';
    const why  = String(metaObj?.['reason'] ?? '');
    const sessionId = typeof metaObj?.['sessionId'] === 'string' ? metaObj['sessionId'] as string : null;
    if (sessionId) {
      recentSessionTransitions.set(sessionId, { status: to, reason: why, at: now.getTime() });
    }
    const fromText = from === '?' ? '' : ` <span style="color:#64748b">from ${markdownInline(String(from))}</span>`;
    return `${statusHeader} ${statusBadge(to)} ${humanReason(why)} ${componentTag}${fromText}\n`;
  }

  // Working status
  if (msg === 'agent_status') {
    const status = metaObj?.['status'];
    const reason = String(metaObj?.['reason'] ?? '');
    if (status === 'working') {
      return `${statusHeader} ${statusBadge('working')} ${humanReason(reason)} ${componentTag}\n`;
    }
    if (status === 'needs_input') {
      return `${statusHeader} ${statusBadge('needs_input')} ${humanReason(reason)} ${componentTag}\n`;
    }
    if (status === 'idle') {
      return `${statusHeader} ${statusBadge('idle')} ${humanReason(reason)} ${componentTag}\n`;
    }
    if (status === 'error') {
      return `${statusHeader} ${statusBadge('error')} ${metaStr} ${componentTag}\n`;
    }
  }

  // New WS client
  if (msg === 'ws attached' || msg === 'ws detached') {
    const cid = typeof metaObj?.['clientId'] === 'string' ? (metaObj['clientId'] as string).slice(0, 8) : '';
    return `${header} **${markdownInline(msg)}** client=\`${markdownInline(cid)}\`\n`;
  }

  // Low-signal noise
  if (msg === 'terminal_focus' || msg === 'user_typing') {
    const detail = msg === 'terminal_focus'
      ? `focused=${metaObj?.['focused']}`
      : `isTyping=${metaObj?.['isTyping']}`;
    return `${header} \`${markdownInline(msg)}\` ${markdownInline(detail)}\n`;
  }

  // Default — plain with meta
  return `${header} ${markdownInline(msg)}${metaStr ? ' ' + metaStr : ''}\n`;
}

function shouldSkipSessionLine(sessionId: string, msg: string, meta: unknown): boolean {
  if (msg === 'terminal_focus' || msg === 'user_typing') return true;
  if (!meta || typeof meta !== 'object') return false;
  if (msg !== 'agent_status') return false;
  const metaObj = meta as Record<string, unknown>;
  const reason = String(metaObj['reason'] ?? '');
  if (reason.includes('working heartbeat')) return true;
  const recent = recentSessionTransitions.get(sessionId);
  if (!recent) return false;
  const status = metaObj['status'];
  return recent.status === status && recent.reason === reason && Date.now() - recent.at < 2000;
}

function timeOnly(date: Date): string {
  return date.toISOString().slice(11, 19);
}

function markdownLevel(level: string): string {
  if (level === 'info') return '<span style="color:#16a34a">[info]</span>';
  if (level === 'warn') return '<span style="color:#ca8a04">[warn]</span>';
  if (level === 'error') return '<span style="color:#dc2626">[error]</span>';
  if (level === 'debug') return '<span style="color:#64748b">[debug]</span>';
  return `\`[${markdownInline(level)}]\``;
}

function statusBadge(status: unknown): string {
  if (status === 'working') return '<span style="color:#16a34a"><strong>[WORKING]</strong></span>';
  if (status === 'needs_input') return '<span style="color:#ca8a04"><strong>[NEEDS_INPUT]</strong></span>';
  if (status === 'idle') return '<span style="color:#64748b"><strong>[IDLE]</strong></span>';
  if (status === 'error') return '<span style="color:#dc2626"><strong>[ERROR]</strong></span>';
  return '<span style="color:#9333ea"><strong>[STATUS]</strong></span>';
}

function humanReason(reason: string): string {
  if (!reason) return '';
  if (reason.includes('working heartbeat')) return 'still active';
  if (reason === 'output chunk received') return 'new output received';
  if (reason.includes('Infinityms')) return 'waiting for input; shell output timer is unavailable';

  const stablePrompt = reason.match(/screen stable for (\d+)ms; prompt visible in bottom block/);
  if (stablePrompt) return `waiting for input after ${formatDurationMs(Number(stablePrompt[1]))} of stable output`;

  const stableNoPrompt = reason.match(/screen stable for (\d+)ms; no prompt visible/);
  if (stableNoPrompt) return `idle after ${formatDurationMs(Number(stableNoPrompt[1]))} of stable output; no prompt visible`;

  const noOutput = reason.match(/no shell output for (\d+)ms/);
  if (noOutput) return `waiting for input after ${formatDurationMs(Number(noOutput[1]))} without shell output`;

  if (reason === 'screen changed') return 'terminal screen changed';
  if (reason === 'interrupt affordance visible') return 'interrupt option visible';
  return markdownInline(reason);
}

function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  return `${Math.round(seconds)}s`;
}

function markdownInline(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, ' ');
}

// Optional persistent log file. Set SHELL_LOG_FILE=path/to/file.log to
// duplicate every emitted log line to disk. Rotates by renaming to
// `<file>.1` once the file grows past SHELL_LOG_FILE_MAX_BYTES (default 5 MB).
// Useful for tracing intermittent agent-status detection issues across
// gateway restarts where stderr would otherwise be lost.
//
// When SHELL_LOG_FILE is set, log lines that carry a `sessionId` in their
// meta are ALSO appended to `<app-log-dir>/session-<id>.md`, where
// `<app-log-dir>` is the directory of SHELL_LOG_FILE. This keeps session logs
// under the app that produced them. Disable with SHELL_LOG_PER_SESSION=0.
const LOG_FILE_PATH = (process.env['SHELL_LOG_FILE'] ?? '').trim();
const LOG_FILE_MAX_BYTES = (() => {
  const raw = Number(process.env['SHELL_LOG_FILE_MAX_BYTES']);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 5 * 1024 * 1024;
})();
const PER_SESSION_LOGS_ENABLED =
  !!LOG_FILE_PATH && (process.env['SHELL_LOG_PER_SESSION'] ?? '').trim() !== '0';

let fileSink: { write(line: string): void } | null = null;
const perSessionSinks = new Map<string, { write(line: string): void }>();
const recentSessionTransitions = new Map<string, { status: unknown; reason: string; at: number }>();
let perSessionDir: string | null = null;
let fsModule: typeof import('node:fs') | null = null;
let pathModule: typeof import('node:path') | null = null;

function loadFsModules(): boolean {
  if (fsModule && pathModule) return true;
  try {
    fsModule = require('node:fs') as typeof import('node:fs');
    pathModule = require('node:path') as typeof import('node:path');
    return true;
  } catch {
    return false;
  }
}

function makeRotatingSink(filePath: string): { write(line: string): void } {
  if (!loadFsModules() || !fsModule) {
    return { write(): void { /* no-op */ } };
  }
  const fs = fsModule;
  let writesSinceCheck = 0;
  const rotateIfNeeded = (): void => {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size < LOG_FILE_MAX_BYTES) return;
      const rotated = `${filePath}.1`;
      try { fs.rmSync(rotated, { force: true }); } catch { /* ignore */ }
      fs.renameSync(filePath, rotated);
    } catch {
      // file may not exist yet — that's fine.
    }
  };
  return {
    write(line: string): void {
      try {
        if (writesSinceCheck++ >= 100) {
          writesSinceCheck = 0;
          rotateIfNeeded();
        }
        fs.appendFileSync(filePath, line);
      } catch {
        // Disk full / permissions / etc — don't crash the gateway over a log.
      }
    },
  };
}

function getFileSink(): { write(line: string): void } | null {
  if (!LOG_FILE_PATH) return null;
  if (fileSink) return fileSink;
  if (!loadFsModules() || !fsModule || !pathModule) return null;
  try {
    const dir = pathModule.dirname(LOG_FILE_PATH);
    if (dir && dir !== '.' && !fsModule.existsSync(dir)) {
      fsModule.mkdirSync(dir, { recursive: true });
    }
    perSessionDir = dir || '.';
  } catch {
    // ignore — we'll just fall back to stderr only
  }
  fileSink = makeRotatingSink(LOG_FILE_PATH);
  return fileSink;
}

function sanitizeSessionId(id: string): string {
  // Keep ids filesystem-safe; uuids and our hex ids are already fine but
  // be defensive against arbitrary strings.
  return id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
}

function getPerSessionSink(sessionId: string): { write(line: string): void } | null {
  if (!PER_SESSION_LOGS_ENABLED) return null;
  // Ensure the main sink (and perSessionDir) is initialized first.
  if (!getFileSink() || !perSessionDir || !pathModule) return null;
  const cached = perSessionSinks.get(sessionId);
  if (cached) return cached;
  const safe = sanitizeSessionId(sessionId);
  if (!safe) return null;
  const filePath = pathModule.join(perSessionDir, `session-${safe}.md`);
  const sink = makeRotatingSink(filePath);
  try {
    if (fsModule && (!fsModule.existsSync(filePath) || fsModule.statSync(filePath).size === 0)) {
      sink.write(`# Session ${markdownInline(safe)}\n\n`);
    }
  } catch {
    // ignore - logging should never crash the shell server.
  }
  perSessionSinks.set(sessionId, sink);
  return sink;
}

function extractSessionId(meta: unknown): string | null {
  if (!meta || typeof meta !== 'object') return null;
  const v = (meta as Record<string, unknown>)['sessionId'];
  if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
}

function emit(component: string, level: LogLevel, msg: string, meta?: unknown, defaultSourceApp = ''): void {
  if (!shouldLog(level)) return;
  const line = fmt(component, level, msg, meta, defaultSourceApp) + '\n';
  process.stderr.write(line);
  const sink = getFileSink();
  if (sink) sink.write(line);
  const sessionId = extractSessionId(meta);
  if (sessionId) {
    const sessionSink = getPerSessionSink(sessionId);
    if (sessionSink && !shouldSkipSessionLine(sessionId, msg, meta)) {
      sessionSink.write(fmtSessionLine(component, level, msg, meta));
    }
  }
}

export function createLogger(component: string, defaultSourceApp = ''): Logger {
  const tag = component.trim() || 'shell';
  const sourceApp = defaultSourceApp.trim();
  return {
    info(msg: string, meta?: unknown): void {
      emit(tag, 'info', msg, meta, sourceApp);
    },
    warn(msg: string, meta?: unknown): void {
      emit(tag, 'warn', msg, meta, sourceApp);
    },
    error(msg: string, meta?: unknown): void {
      emit(tag, 'error', msg, meta, sourceApp);
    },
    debug(msg: string, meta?: unknown): void {
      emit(tag, 'debug', msg, meta, sourceApp);
    },
  };
}

export const log = createLogger('shell');
