import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client, type ClientChannel } from 'ssh2';
import { DEFAULT_COLS, DEFAULT_ROWS } from './constants';
import { log } from './logger';
import type { ISession, SessionExitInfo, SessionKind } from './session';

export interface SshSessionOptions {
  sessionId: string;
  host: string;
  port?: number;
  username: string;
  /** Inline private key (PEM). Takes precedence over privateKeyPath. */
  privateKey?: string | Buffer;
  privateKeyPath?: string;
  passphrase?: string;
  /** Path to ssh-agent socket. Defaults to env.SSH_AUTH_SOCK (or named pipe on Windows). */
  agent?: string;
  cols?: number;
  rows?: number;
  /** TERM value to request from the SSH server. Defaults to xterm-256color. */
  term?: string;
  /** Optional command to run once the remote shell channel is ready. */
  initCommand?: string;
}

// Default agent path: Windows OpenSSH uses a named pipe, Linux/macOS uses SSH_AUTH_SOCK.
function defaultAgent(): string | undefined {
  if (process.env['SSH_AUTH_SOCK']) return process.env['SSH_AUTH_SOCK'];
  if (process.platform === 'win32') {
    // OpenSSH for Windows exposes the agent at this named pipe when
    // the "OpenSSH Authentication Agent" service is running.
    return '\\\\.\\pipe\\openssh-ssh-agent';
  }
  return undefined;
}

// Try a list of well-known key paths and return the first that exists.
function discoverDefaultKey(): { path: string; contents: Buffer } | undefined {
  const home = os.homedir();
  const candidates = [
    'id_ed25519',
    'id_ecdsa',
    'id_rsa',
  ].map((name) => path.join(home, '.ssh', name));
  for (const p of candidates) {
    try {
      const stat = fs.statSync(p);
      if (!stat.isFile()) continue;
      const contents = fs.readFileSync(p);
      return { path: p, contents };
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

export class SshSession extends EventEmitter implements ISession {
  readonly sessionId: string;
  readonly kind: SessionKind = 'ssh';
  readonly shell: string;
  readonly cwd: string = '';
  readonly createdAt: string;
  readonly pid: number = 0;
  cols: number;
  rows: number;
  alive: boolean = true;
  exitInfo: SessionExitInfo | null = null;

  private readonly client: Client;
  private stream: ClientChannel | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private dataChunkCount = 0;
  private dataBytesTotal = 0;
  private lastDataAt = 0;
  private writeChunkCount = 0;
  private writeBytesTotal = 0;
  private lastWriteAt = 0;
  private pendingWrites: string[] = [];
  private readyEmitted = false;
  private readonly initCommand: string;

  constructor(opts: SshSessionOptions) {
    super();
    this.sessionId = opts.sessionId;
    this.cols = opts.cols ?? DEFAULT_COLS;
    this.rows = opts.rows ?? DEFAULT_ROWS;
    this.createdAt = new Date().toISOString();
    const port = opts.port ?? 22;
    this.shell = `ssh://${opts.username}@${opts.host}:${port}`;
    this.initCommand = (opts.initCommand ?? '').trim();

    const term = opts.term ?? 'xterm-256color';

    // Resolve auth: explicit privateKey > privateKeyPath > default keys > agent
    const auth: {
      username: string;
      host: string;
      port: number;
      privateKey?: Buffer | string;
      passphrase?: string;
      agent?: string;
      tryKeyboard?: boolean;
      readyTimeout?: number;
    } = {
      username: opts.username,
      host: opts.host,
      port,
      readyTimeout: 20000,
    };

    let authSource = 'none';
    if (opts.privateKey) {
      auth.privateKey = opts.privateKey;
      authSource = 'inline-key';
    } else if (opts.privateKeyPath) {
      try {
        auth.privateKey = fs.readFileSync(opts.privateKeyPath);
        authSource = `key-file:${opts.privateKeyPath}`;
      } catch (e) {
        // Defer the error — surface it via the connection error event so
        // the UI can show it cleanly rather than crashing the supervisor.
        setImmediate(() => this.handleFatal(`unable to read key file ${opts.privateKeyPath}: ${(e as Error).message}`));
        this.client = new Client();
        return;
      }
    } else {
      const def = discoverDefaultKey();
      if (def) {
        auth.privateKey = def.contents;
        authSource = `default-key:${def.path}`;
      }
    }
    if (opts.passphrase) auth.passphrase = opts.passphrase;

    const agent = opts.agent ?? defaultAgent();
    if (agent) auth.agent = agent;

    log.info('ssh connecting', {
      sessionId: this.sessionId,
      host: opts.host,
      port,
      username: opts.username,
      auth: authSource,
      agent: agent ? 'yes' : 'no',
      term,
    });

    this.client = new Client();

    this.client.on('error', (err) => {
      log.warn('ssh client error', {
        sessionId: this.sessionId,
        error: err.message,
        level: (err as Error & { level?: string }).level,
      });
      this.handleFatal(`SSH error: ${err.message}`);
    });

    this.client.on('close', () => {
      log.info('ssh client closed', { sessionId: this.sessionId });
      if (this.alive) this.handleFatal('connection closed');
    });

    this.client.on('end', () => {
      log.info('ssh client ended', { sessionId: this.sessionId });
    });

    this.client.on('ready', () => {
      log.info('ssh ready', { sessionId: this.sessionId, host: opts.host });
      this.client.shell(
        { term, cols: this.cols, rows: this.rows, width: 0, height: 0 },
        (err, stream) => {
          if (err) {
            this.handleFatal(`shell channel failed: ${err.message}`);
            return;
          }
          this.attachStream(stream);
        }
      );
    });

    try {
      this.client.connect(auth);
    } catch (e) {
      setImmediate(() => this.handleFatal(`connect threw: ${(e as Error).message}`));
    }

    this.heartbeat = setInterval(() => {
      if (!this.alive) return;
      const now = Date.now();
      log.debug('ssh heartbeat', {
        sessionId: this.sessionId,
        alive: this.alive,
        ready: this.readyEmitted,
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

  private attachStream(stream: ClientChannel): void {
    this.stream = stream;
    stream.on('data', (data: Buffer) => {
      const s = data.toString('utf8');
      this.dataChunkCount++;
      this.dataBytesTotal += s.length;
      this.lastDataAt = Date.now();
      this.emit('data', s);
    });
    stream.stderr.on('data', (data: Buffer) => {
      // Mux stderr inline so the user sees server-side error output.
      const s = data.toString('utf8');
      this.emit('data', s);
    });
    stream.on('close', (code: number | null, signal: string | null) => {
      log.info('ssh stream closed', {
        sessionId: this.sessionId,
        code,
        signal,
      });
      this.alive = false;
      if (this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = null;
      }
      this.exitInfo = {
        exitCode: typeof code === 'number' ? code : 0,
        signal: null,
      };
      this.emit('exit', this.exitInfo);
      try {
        this.client.end();
      } catch {
        /* ignore */
      }
    });

    // Flush anything written before the stream was ready.
    for (const pending of this.pendingWrites) {
      try {
        stream.write(pending);
      } catch (e) {
        log.warn('ssh flush failed', { sessionId: this.sessionId, error: (e as Error).message });
      }
    }
    this.pendingWrites = [];

    if (this.initCommand) {
      // Best-effort: write the init command as soon as the shell channel is
      // open. Most remote shells buffer stdin during rc-file init, so this
      // arrives at the prompt and runs as if the user had typed it. We don't
      // try to detect "prompt ready" because that's heuristic and unreliable.
      const line = this.initCommand.endsWith('\r') || this.initCommand.endsWith('\n')
        ? this.initCommand
        : `${this.initCommand}\r`;
      try {
        log.info('ssh init command', {
          sessionId: this.sessionId,
          bytes: line.length,
        });
        stream.write(line);
        this.writeChunkCount++;
        this.writeBytesTotal += line.length;
        this.lastWriteAt = Date.now();
      } catch (e) {
        log.warn('ssh init command write failed', {
          sessionId: this.sessionId,
          error: (e as Error).message,
        });
      }
    }

    if (!this.readyEmitted) {
      this.readyEmitted = true;
      this.emit('ready');
    }
  }

  private handleFatal(message: string): void {
    if (!this.alive) return;
    // Surface the error to the renderer as a visible line, then mark the
    // session as exited. The renderer treats 'exit' as terminal.
    const banner = `\r\n\x1b[31m[ssh] ${message}\x1b[0m\r\n`;
    try {
      this.emit('data', banner);
    } catch {
      /* ignore */
    }
    this.alive = false;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    this.exitInfo = { exitCode: 1, signal: null };
    setImmediate(() => this.emit('exit', this.exitInfo!));
    try {
      this.client.end();
    } catch {
      /* ignore */
    }
  }

  write(data: string): void {
    if (!this.alive) return;
    this.writeChunkCount++;
    this.writeBytesTotal += data.length;
    this.lastWriteAt = Date.now();
    if (this.stream) {
      try {
        this.stream.write(data);
      } catch (e) {
        log.warn('ssh write failed', { sessionId: this.sessionId, error: (e as Error).message });
      }
    } else {
      // Buffer until the shell channel opens.
      this.pendingWrites.push(data);
    }
  }

  resize(cols: number, rows: number): void {
    if (!this.alive) return;
    this.cols = cols;
    this.rows = rows;
    if (this.stream) {
      try {
        this.stream.setWindow(rows, cols, 0, 0);
      } catch (e) {
        log.warn('ssh resize failed', { sessionId: this.sessionId, error: (e as Error).message });
      }
    }
  }

  kill(_signal?: string): void {
    if (!this.alive) return;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    try {
      if (this.stream) this.stream.end();
      this.client.end();
    } catch (e) {
      log.warn('ssh kill failed', { sessionId: this.sessionId, error: (e as Error).message });
    }
  }
}
