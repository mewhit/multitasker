import { EventEmitter } from 'events';
import * as os from 'os';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import { DEFAULT_COLS, DEFAULT_ROWS, defaultShell, defaultShellArgs } from './constants';
import { log } from './logger';
import type { ISession, SessionExitInfo, SessionKind } from './session';

export interface PtySessionOptions {
  sessionId: string;
  shell?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

// Backwards-compatible alias — code historically imports PtyExitInfo.
export type PtyExitInfo = SessionExitInfo;

export declare interface PtySession {
  on(event: 'data', listener: (data: string) => void): this;
  on(event: 'exit', listener: (info: PtyExitInfo) => void): this;
  off(event: 'data', listener: (data: string) => void): this;
  off(event: 'exit', listener: (info: PtyExitInfo) => void): this;
  emit(event: 'data', data: string): boolean;
  emit(event: 'exit', info: PtyExitInfo): boolean;
}

export class PtySession extends EventEmitter implements ISession {
  readonly sessionId: string;
  readonly kind: SessionKind = 'pty';
  readonly shell: string;
  readonly cwd: string;
  readonly createdAt: string;
  readonly pid: number;
  cols: number;
  rows: number;
  alive: boolean = true;
  exitInfo: SessionExitInfo | null = null;

  private readonly proc: IPty;
  private heartbeat: NodeJS.Timeout | null = null;
  private dataChunkCount = 0;
  private dataBytesTotal = 0;
  private lastDataAt = 0;
  private writeChunkCount = 0;
  private writeBytesTotal = 0;
  private lastWriteAt = 0;

  constructor(opts: PtySessionOptions) {
    super();
    this.sessionId = opts.sessionId;
    this.shell = opts.shell ?? defaultShell();
    this.cwd = opts.cwd ?? process.cwd();
    this.cols = opts.cols ?? DEFAULT_COLS;
    this.rows = opts.rows ?? DEFAULT_ROWS;
    this.createdAt = new Date().toISOString();

    const baseEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') baseEnv[k] = v;
    }
    // Force truecolor + xterm-256color so TUIs like Codex CLI enable their
    // 24-bit gradient palette instead of falling back to 256-color or none.
    baseEnv['TERM'] = baseEnv['TERM'] || 'xterm-256color';
    baseEnv['COLORTERM'] = 'truecolor';
    const env = { ...baseEnv, ...(opts.env ?? {}) };

    // The OS-shipped ConPTY has known bugs where its output pipe stalls after
    // certain VT sequences — notably the bursts ssh emits during terminal
    // negotiation. Symptom: pty.onData fires a few times then never again,
    // even though the child is alive and accepting input. node-pty 1.x bundles
    // a patched conpty.dll (the same one VS Code uses); opt into it via
    // useConptyDll. See microsoft/node-pty for the SSH/ConPTY freeze history.
    const spawnOpts: pty.IPtyForkOptions & {
      useConpty?: boolean;
      useConptyDll?: boolean;
      conptyInheritCursor?: boolean;
    } = {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env,
    };
    if (process.platform === 'win32') {
      // Default on Windows: winpty. ConPTY re-renders the screen internally
      // before handing bytes back, which on some configs (notably the bundled
      // patched conpty.dll) adds 1–3 s of buffering latency to even tiny
      // outputs like `echo hi` — making interactive shells and TUIs (codex,
      // claude, gemini) feel unusable. Winpty (same layer git-bash/mintty
      // uses) passes bytes through raw, matching native terminal speed.
      //
      // Escape hatch: set MULTITASKER_USE_CONPTY=1 to go back to ConPTY.
      // Tradeoff for winpty: older/deprecated, may have minor quirks with
      // resize edge cases. We previously preferred ConPTY for the ssh.exe
      // stall fix in the bundled DLL (microsoft/terminal#18816) — keep an
      // eye on ssh sessions after the switch.
      const forceConpty = process.env['MULTITASKER_USE_CONPTY'] === '1';
      // Back-compat: MULTITASKER_USE_WINPTY=1 used to be required when ConPTY
      // was the default. Now it's a no-op (winpty IS the default), but we
      // still honor it for users who left it in their .env.
      void process.env['MULTITASKER_USE_WINPTY'];
      if (forceConpty) {
        spawnOpts.useConptyDll = true;
        log.info('pty backend: conpty (MULTITASKER_USE_CONPTY=1, bundled patched DLL)');
      } else {
        spawnOpts.useConpty = false;
        log.info('pty backend: winpty (default on Windows)');
      }
    }
    this.proc = pty.spawn(this.shell, opts.args ?? defaultShellArgs(this.shell), spawnOpts);
    this.pid = this.proc.pid;

    this.proc.onData((data: string) => {
      // Hotpath: TUIs like Codex emit many frames/sec — no per-chunk log,
      // no previewBytes. Counters feed the 5s heartbeat + 1s output-rate
      // aggregate in the supervisor.
      this.dataChunkCount++;
      this.dataBytesTotal += data.length;
      this.lastDataAt = Date.now();
      this.emit('data', data);
    });
    this.proc.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
      this.alive = false;
      if (this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = null;
      }
      this.exitInfo = { exitCode, signal: signal ?? null };
      log.info('pty exit', { sessionId: this.sessionId, exitCode, signal: signal ?? null });
      this.emit('exit', this.exitInfo);
    });

    log.info('pty spawned', {
      sessionId: this.sessionId,
      pid: this.pid,
      shell: this.shell,
      cwd: this.cwd,
      cols: this.cols,
      rows: this.rows,
      host: os.hostname(),
    });

    this.heartbeat = setInterval(() => {
      if (!this.alive) return;
      const now = Date.now();
      log.debug('pty heartbeat', {
        sessionId: this.sessionId,
        pid: this.pid,
        alive: this.alive,
        msSinceLastData: this.lastDataAt > 0 ? now - this.lastDataAt : null,
        msSinceLastWrite: this.lastWriteAt > 0 ? now - this.lastWriteAt : null,
        totalDataChunks: this.dataChunkCount,
        totalDataBytes: this.dataBytesTotal,
        totalWriteChunks: this.writeChunkCount,
        totalWriteBytes: this.writeBytesTotal,
      });
    }, 5000);
    if (typeof this.heartbeat.unref === 'function') this.heartbeat.unref();
  }

  write(data: string): void {
    if (!this.alive) return;
    // Hotpath — no per-keystroke log (see onData above).
    this.writeChunkCount++;
    this.writeBytesTotal += data.length;
    this.lastWriteAt = Date.now();
    this.proc.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.alive) return;
    this.cols = cols;
    this.rows = rows;
    try {
      this.proc.resize(cols, rows);
    } catch (e) {
      log.warn('resize failed', { sessionId: this.sessionId, error: (e as Error).message });
    }
  }

  kill(signal?: string): void {
    if (!this.alive) return;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    try {
      this.proc.kill(signal);
    } catch (e) {
      log.warn('kill failed', { sessionId: this.sessionId, error: (e as Error).message });
    }
  }
}
