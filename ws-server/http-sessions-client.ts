import { request as httpRequest } from 'http';
import type { ClientRequest } from 'http';
import { log } from './logger';

/**
 * Desktop session info from HTTP-server.
 * This is different from shell/core/protocol.ts#SessionInfo
 * (which is for PTY/SSH sessions in the supervisor).
 */
export interface DesktopSessionInfo {
  id: string;
  name: string;
  cmd: string;
  cwd: string;
  shellType: string;
  status: string;
  lastActivity: number;
  gitChanges: boolean;
}

const REQUEST_TIMEOUT_MS = 5000;

function makeHttpRequest(
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const req: ClientRequest = httpRequest(
      {
        hostname: '127.0.0.1',
        port: 39017,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${parsed.error || data}`));
            } else {
              resolve(parsed);
            }
          } catch (e) {
            reject(new Error(`Failed to parse response: ${data}`));
          }
        });
      }
    );

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error(`Request timeout after ${REQUEST_TIMEOUT_MS}ms`));
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (bodyStr) {
      req.write(bodyStr);
    }
    req.end();
  });
}

export class HttpSessionsClient {
  async listSessions(): Promise<DesktopSessionInfo[]> {
    try {
      const result = (await makeHttpRequest('GET', '/api/sessions')) as { ok: boolean; sessions: DesktopSessionInfo[] };
      return result.sessions || [];
    } catch (err) {
      log.error('http-sessions: failed to list sessions', { error: (err as Error).message });
      return [];
    }
  }

  async getSession(sessionId: string): Promise<DesktopSessionInfo | null> {
    try {
      const result = (await makeHttpRequest('GET', `/api/session/${sessionId}`)) as { ok: boolean; session: DesktopSessionInfo };
      return result.session || null;
    } catch (err) {
      log.error('http-sessions: failed to get session', { sessionId, error: (err as Error).message });
      return null;
    }
  }

  async renameSession(sessionId: string, name: string): Promise<DesktopSessionInfo | null> {
    try {
      const result = (await makeHttpRequest('POST', '/api/session/rename', { id: sessionId, name })) as {
        ok: boolean;
        session: DesktopSessionInfo;
      };
      return result.session || null;
    } catch (err) {
      log.error('http-sessions: failed to rename session', { sessionId, name, error: (err as Error).message });
      return null;
    }
  }

  async removeSession(sessionId: string): Promise<boolean> {
    try {
      const result = (await makeHttpRequest('POST', '/api/session/remove', { id: sessionId })) as { ok: boolean };
      return result.ok === true;
    } catch (err) {
      log.error('http-sessions: failed to remove session', { sessionId, error: (err as Error).message });
      return false;
    }
  }

  async touchSession(sessionId: string): Promise<DesktopSessionInfo | null> {
    try {
      const result = (await makeHttpRequest('POST', '/api/session/touch', { id: sessionId })) as {
        ok: boolean;
        session: DesktopSessionInfo;
      };
      return result.session || null;
    } catch (err) {
      log.error('http-sessions: failed to touch session', { sessionId, error: (err as Error).message });
      return null;
    }
  }
}
