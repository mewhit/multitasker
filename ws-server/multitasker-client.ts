import * as http from 'http';
import { URL } from 'url';
import type { ClientMetadata } from '../shared-shell/shell-protocol';
import { log } from './logger';

export interface CreateSessionRequest {
  name: string;
  cmd: string;
  cwd: string;
  shellType: 'powershell' | 'bash' | 'ssh';
  sshCommand?: string;
  shellSessionId?: string;
  requestedId?: string;
}

export interface MultitaskerSession {
  id: string;
  name: string;
  cwd: string;
}

export interface CreateSessionResponse {
  ok: boolean;
  session?: MultitaskerSession;
  error?: string;
}

export class MultitaskerClient {
  private readonly baseUrl: URL;

  constructor(baseUrl: string) {
    this.baseUrl = new URL(baseUrl);
  }

  get url(): string {
    return this.baseUrl.toString();
  }

  async createSession(req: CreateSessionRequest): Promise<MultitaskerSession | null> {
    const res = await this.post<CreateSessionResponse>('/api/session/create', req);
    if (!res.ok || !res.session) {
      log.warn('multitasker create_session failed', { sourceApp: 'http-server', error: res.error });
      return null;
    }
    return res.session;
  }

  async removeSession(id: string): Promise<boolean> {
    const res = await this.post<{ ok: boolean; error?: string }>('/api/session/remove', { id });
    if (!res.ok) {
      log.warn('multitasker remove_session failed', { sourceApp: 'http-server', id, error: res.error });
      return false;
    }
    return true;
  }

  async sendAgentStatus(req: {
    shellSessionId: string;
    status: 'working' | 'needs_input';
    agentKind: string;
    reason?: string;
    matchedText?: string;
    occurredAt?: number;
  }): Promise<void> {
    try {
      await this.post<{ ok: boolean }>('/api/shell/agent-status', req);
    } catch (e) {
      log.warn('multitasker agent-status failed', {
        sourceApp: 'http-server',
        shellSessionId: req.shellSessionId,
        error: (e as Error).message,
      });
    }
  }

  async sendClientMetadata(req: {
    shellSessionId: string;
    clientMetadata: ClientMetadata;
  }): Promise<void> {
    try {
      await this.post<{ ok: boolean }>('/api/shell/client-metadata', req);
    } catch (e) {
      log.warn('multitasker client-metadata failed', {
        sourceApp: 'http-server',
        shellSessionId: req.shellSessionId,
        error: (e as Error).message,
      });
    }
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify(body), 'utf8');
      const req = http.request(
        {
          host: this.baseUrl.hostname,
          port: this.baseUrl.port || 80,
          method: 'POST',
          path,
          headers: {
            'content-type': 'application/json',
            'content-length': payload.length.toString(),
          },
          timeout: 5000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode === undefined || res.statusCode < 200 || res.statusCode >= 300) {
              reject(new Error(`HTTP ${res.statusCode ?? '???'} ${raw.slice(0, 200)}`));
              return;
            }
            try {
              resolve(JSON.parse(raw) as T);
            } catch (e) {
              reject(new Error(`invalid JSON from backend: ${(e as Error).message}`));
            }
          });
        }
      );
      req.on('timeout', () => {
        req.destroy(new Error('request timed out'));
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }
}
