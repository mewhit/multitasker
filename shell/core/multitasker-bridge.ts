import * as path from 'path';
import { log } from './logger';
import { MultitaskerClient } from './multitasker-client';
import type { SessionManager } from './session-manager';
import type { ISession } from './session';

export interface MultitaskerBridgeOptions {
  backendUrl: string;
  namePrefix: string;
}

type LocalShellType = 'powershell' | 'bash';

function classifyShell(shellPath: string): LocalShellType {
  const base = path.basename(shellPath).toLowerCase();
  if (base.includes('bash') || base.includes('zsh') || base === 'sh') return 'bash';
  // powershell, pwsh, cmd, anything else on Windows
  return 'powershell';
}

export class MultitaskerBridge {
  private readonly client: MultitaskerClient;
  private readonly sessions: SessionManager;
  private readonly namePrefix: string;
  private readonly mapping = new Map<string, string>(); // shellSessionId -> multitaskerSessionId
  private readonly onCreated = (s: ISession): void => {
    void this.handleCreated(s);
  };
  private readonly onRemoved = (id: string): void => {
    void this.handleRemoved(id);
  };

  constructor(sessions: SessionManager, opts: MultitaskerBridgeOptions) {
    this.sessions = sessions;
    this.client = new MultitaskerClient(opts.backendUrl);
    this.namePrefix = opts.namePrefix;
  }

  start(): void {
    this.sessions.on('created', this.onCreated);
    this.sessions.on('removed', this.onRemoved);
    log.info('multitasker bridge started', { backendUrl: this.client.url });
  }

  stop(): void {
    this.sessions.off('created', this.onCreated);
    this.sessions.off('removed', this.onRemoved);
  }

  /** Returns the multitasker session id paired with a shell session, if any. */
  multitaskerIdFor(shellSessionId: string): string | undefined {
    return this.mapping.get(shellSessionId);
  }

  private async handleCreated(session: ISession): Promise<void> {
    if (session.kind !== 'pty') return;
    if (!this.sessions.isTracked(session.sessionId)) {
      log.debug('skipping multitasker registration (track=false)', {
        shellSessionId: session.sessionId,
      });
      return;
    }
    const shortId = session.sessionId.slice(0, 8);
    const name = `${this.namePrefix} ${shortId}`;
    try {
      const created = await this.client.createSession({
        name,
        cmd: '',
        cwd: session.cwd,
        shellType: classifyShell(session.shell),
        shellSessionId: session.sessionId,
        requestedId: session.sessionId,
      });
      if (created) {
        this.mapping.set(session.sessionId, created.id);
        log.info('multitasker session created', {
          shellSessionId: session.sessionId,
          multitaskerSessionId: created.id,
          name,
        });
      }
    } catch (e) {
      log.warn('multitasker create call failed', {
        shellSessionId: session.sessionId,
        error: (e as Error).message,
      });
    }
  }

  private async handleRemoved(shellSessionId: string): Promise<void> {
    const multitaskerId = this.mapping.get(shellSessionId);
    if (!multitaskerId) return;
    this.mapping.delete(shellSessionId);
    try {
      await this.client.removeSession(multitaskerId);
      log.info('multitasker session removed', { shellSessionId, multitaskerId });
    } catch (e) {
      log.warn('multitasker remove call failed', {
        shellSessionId,
        multitaskerId,
        error: (e as Error).message,
      });
    }
  }
}
