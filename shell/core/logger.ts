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

function fmt(component: string, level: string, msg: string, meta?: unknown): string {
  const base = `[${ts()}] [${component}] [${level}] ${msg}`;
  if (meta === undefined) return base;
  try {
    return `${base} ${JSON.stringify(meta)}`;
  } catch {
    return `${base} <unserializable meta>`;
  }
}

// Optional persistent log file. Set SHELL_LOG_FILE=path/to/file.log to
// duplicate every emitted log line to disk. Rotates by renaming to
// `<file>.1` once the file grows past SHELL_LOG_FILE_MAX_BYTES (default 5 MB).
// Useful for tracing intermittent agent-status detection issues across
// gateway restarts where stderr would otherwise be lost.
//
// When SHELL_LOG_FILE is set, log lines that carry a `sessionId` in their
// meta are ALSO appended to a per-session file `<dir>/session-<id>.log`
// (where <dir> is the directory of SHELL_LOG_FILE). This makes it easy to
// isolate analyzer flapping for a specific terminal without grepping through
// the global log. Disable with SHELL_LOG_PER_SESSION=0.
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
  const filePath = pathModule.join(perSessionDir, `session-${safe}.log`);
  const sink = makeRotatingSink(filePath);
  perSessionSinks.set(sessionId, sink);
  return sink;
}

function extractSessionId(meta: unknown): string | null {
  if (!meta || typeof meta !== 'object') return null;
  const v = (meta as Record<string, unknown>)['sessionId'];
  if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
}

function emit(component: string, level: LogLevel, msg: string, meta?: unknown): void {
  if (!shouldLog(level)) return;
  const line = fmt(component, level, msg, meta) + '\n';
  process.stderr.write(line);
  const sink = getFileSink();
  if (sink) sink.write(line);
  const sessionId = extractSessionId(meta);
  if (sessionId) {
    const sessionSink = getPerSessionSink(sessionId);
    if (sessionSink) sessionSink.write(line);
  }
}

export function createLogger(component: string): Logger {
  const tag = component.trim() || 'shell';
  return {
    info(msg: string, meta?: unknown): void {
      emit(tag, 'info', msg, meta);
    },
    warn(msg: string, meta?: unknown): void {
      emit(tag, 'warn', msg, meta);
    },
    error(msg: string, meta?: unknown): void {
      emit(tag, 'error', msg, meta);
    },
    debug(msg: string, meta?: unknown): void {
      emit(tag, 'debug', msg, meta);
    },
  };
}

export const log = createLogger('shell');
