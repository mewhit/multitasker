import type { HttpModule, RouteDef } from '../../core/types';
import type { Session } from '../../../desktop/sessionManager';
import { writeJsonResponse } from '../../core/body';
import { sessionManager } from '../../state/sessions';
import { saveSessions, loadSettings } from '../../../desktop/settings';
import { readPayloadString, readStringField } from '../../utils/payload';
import { isShellType } from '../../utils/types';
import { flushPendingTerminalUpdates, flushPendingTerminalEvents, forgetRemovedSession } from '../terminals/apply';
import { queueDisconnectSessionCommand } from '../vscode';
import { getSessionsStateToSave } from './parse';

export const sessionsModule: HttpModule = {
  name: 'sessions',
  routes(): RouteDef[] {
    return [
      {
        method: 'GET',
        path: '/api/sessions',
        handler({ response }) {
          sessionManager.refreshGitChanges();
          writeJsonResponse(response, 200, { ok: true, sessions: sessionManager.getSessions() });
        },
      },
      {
        method: 'GET',
        path: /^\/api\/session\/([^/]+)$/,
        handler({ response, match }) {
          const sessionId = match?.[1] ?? '';
          const allSessions = sessionManager.getSessions();
          const session = allSessions.find(s => s.id === sessionId);
          if (!session) {
            writeJsonResponse(response, 404, { error: `Session not found: ${sessionId}` });
            return;
          }
          writeJsonResponse(response, 200, { ok: true, session });
        },
      },
      {
        method: 'POST',
        path: '/api/session/create',
        handler({ payload, response }) {
          const session = createSessionFromPayload(payload);
          if (!session) {
            writeJsonResponse(response, 400, { ok: false, error: 'invalid_session' });
            return;
          }
          writeJsonResponse(response, 200, { ok: true, session });
        },
      },
      {
        method: 'POST',
        path: '/api/session/remove',
        handler({ payload, response }) {
          const id = readPayloadString(payload, 'id').trim();
          if (!id) {
            writeJsonResponse(response, 400, { ok: false, error: 'missing_session_id' });
            return;
          }
          removeSessionById(id);
          writeJsonResponse(response, 200, { ok: true });
        },
      },
      {
        method: 'POST',
        path: '/api/session/rename',
        handler({ payload, response }) {
          const id = readPayloadString(payload, 'id').trim();
          const name = readPayloadString(payload, 'name').trim();
          if (!id || !name) {
            writeJsonResponse(response, 400, { ok: false, error: 'invalid_session_rename' });
            return;
          }
          const session = sessionManager.renameSession(id, name);
          if (!session) {
            writeJsonResponse(response, 404, { ok: false, error: 'session_not_found' });
            return;
          }
          saveSessions(getSessionsStateToSave());
          writeJsonResponse(response, 200, { ok: true, session });
        },
      },
      {
        method: 'POST',
        path: '/api/session/touch',
        handler({ payload, response }) {
          const id = readPayloadString(payload, 'id').trim();
          if (!id) {
            writeJsonResponse(response, 400, { ok: false, error: 'missing_session_id' });
            return;
          }
          const session = sessionManager.touchSession(id);
          writeJsonResponse(response, 200, { ok: true, session });
        },
      },
    ];
  },
};

function createSessionFromPayload(payload: unknown): Session | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const settings = loadSettings();
  const name = readStringField(record, 'name').trim();
  const cmd = readStringField(record, 'cmd').trim() || readStringField(record, 'command').trim();
  const cwd = readStringField(record, 'cwd').trim();
  const rawShellType = readStringField(record, 'shellType').trim();
  const shellType = isShellType(rawShellType) ? rawShellType : settings.defaultShell;
  const sshCommand = readStringField(record, 'sshCommand').trim();
  if (!name) return null;
  if (shellType === 'ssh') {
    if (!sshCommand) return null;
  } else if (!cwd) {
    return null;
  }

  const session = sessionManager.createSession(name, cmd, cwd, shellType, '', sshCommand);
  forgetRemovedSession(session.id);
  saveSessions(getSessionsStateToSave());
  flushPendingTerminalUpdates(session.id);
  flushPendingTerminalEvents(session.id);
  return session;
}

function removeSessionById(id: string): void {
  const session = sessionManager.getSession(id);
  if (session) queueDisconnectSessionCommand(session);
  sessionManager.removeSession(id);
  saveSessions(getSessionsStateToSave());
}
