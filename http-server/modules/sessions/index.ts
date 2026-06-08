import type { HttpModule, RouteDef } from '../../core/types';
import type { Session, TerminalUpdate } from '../../../shared/sessionManager';
import { writeJsonResponse } from '../../core/body';
import { shouldBackendOwnState } from '../../core/constants';
import { broadcastSseEvent } from '../../core/sse';
import {
  sessionManager,
  multitaskerSessionIdByShellSessionId,
  pendingClientMetadataByShellSessionId,
} from '../../state/sessions';
import { saveSessions, loadSettings, normalizeClientMetadata } from '../../../shared/settings';
import { readPayloadString, readStringField, readOptionalNumberField } from '../../utils/payload';
import { isShellType } from '../../utils/types';
import { flushPendingTerminalUpdates, flushPendingTerminalEvents, forgetRemovedSession, handleTerminalUpdate } from '../terminals/apply';
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
      {
        method: 'POST',
        path: '/api/session/pause',
        handler({ payload, response }) {
          const id = readPayloadString(payload, 'id').trim();
          if (!id) {
            writeJsonResponse(response, 400, { ok: false, error: 'missing_session_id' });
            return;
          }
          const session = sessionManager.pauseSession(id);
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
        path: '/api/shell/agent-status',
        handler({ payload, response }) {
          handleAgentStatusPost(payload, response);
        },
      },
      {
        method: 'POST',
        path: '/api/shell/client-metadata',
        handler({ payload, response }) {
          handleClientMetadataPost(payload, response);
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
  const sshOptions = parseSshOptionsPayload(record['sshOptions']);
  const shellSessionId = readStringField(record, 'shellSessionId').trim();
  const requestedId = readStringField(record, 'requestedId').trim();
  if (!name) return null;
  if (shellType === 'ssh') {
    if (!sshCommand) return null;
  } else if (!cwd) {
    return null;
  }

  const session = sessionManager.createSession(
    name,
    cmd,
    cwd,
    shellType,
    requestedId,
    sshCommand,
    '',
    undefined,
    sshOptions
  );
  forgetRemovedSession(session.id);
  if (shellSessionId) multitaskerSessionIdByShellSessionId.set(shellSessionId, session.id);
  // Apply any client metadata that arrived from the gateway before this
  // session was registered.
  const pendingMetaKey = shellSessionId || session.id;
  const pendingMeta = pendingClientMetadataByShellSessionId.get(pendingMetaKey);
  if (pendingMeta) {
    pendingClientMetadataByShellSessionId.delete(pendingMetaKey);
    sessionManager.setClientMetadata(session.id, pendingMeta);
    maybeRenameFromClientMetadata(session.id, pendingMeta);
  }
  saveSessions(getSessionsStateToSave());
  flushPendingTerminalUpdates(session.id);
  flushPendingTerminalEvents(session.id);
  return session;
}

function parseSshOptionsPayload(value: unknown): import('../../../shared/settings').SessionSshOptions | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const host = typeof v['host'] === 'string' ? v['host'].trim() : '';
  const username = typeof v['username'] === 'string' ? v['username'].trim() : '';
  if (!host || !username) return undefined;
  const opts: import('../../../shared/settings').SessionSshOptions = { host, username };
  const port = v['port'];
  if (typeof port === 'number' && Number.isFinite(port) && port > 0) opts.port = port;
  const keyPath = v['privateKeyPath'];
  if (typeof keyPath === 'string' && keyPath.trim()) opts.privateKeyPath = keyPath.trim();
  const agent = v['agent'];
  if (typeof agent === 'string' && agent.trim()) opts.agent = agent.trim();
  const initCommand = v['initCommand'];
  if (typeof initCommand === 'string' && initCommand.trim()) opts.initCommand = initCommand.trim();
  return opts;
}

function removeSessionById(id: string): void {
  sessionManager.removeSession(id);
  // Drop any shell→multitasker mapping entries pointing at this session.
  for (const [shellId, mtId] of multitaskerSessionIdByShellSessionId) {
    if (mtId === id) multitaskerSessionIdByShellSessionId.delete(shellId);
  }
  saveSessions(getSessionsStateToSave());
}

function handleAgentStatusPost(payload: unknown, response: import('http').ServerResponse): void {
  if (typeof payload !== 'object' || payload === null) {
    writeJsonResponse(response, 400, { ok: false, error: 'invalid_payload' });
    return;
  }
  const record = payload as Record<string, unknown>;
  const shellSessionId = readStringField(record, 'shellSessionId').trim();
  const status = readStringField(record, 'status').trim();
  const occurredAt = readOptionalNumberField(record, 'occurredAt') ?? Date.now();
  const reason = readStringField(record, 'reason').trim();
  const matchedText = readStringField(record, 'matchedText').trim();
  const agentKind = readStringField(record, 'agentKind').trim();

  if (!shellSessionId) {
    writeJsonResponse(response, 400, { ok: false, error: 'missing_shellSessionId' });
    return;
  }
  // Map shell session id -> multitasker session id.
  // The in-memory map is only populated when a session is freshly created
  // via /api/session/create. After a backend restart (or for sessions
  // restored from disk), the map is empty. As a fallback we look up the
  // session directly by the shell session id — shell- and PTY-created
  // sessions conflate both ids by design (createSession honours requestedId).
  let multitaskerId = multitaskerSessionIdByShellSessionId.get(shellSessionId);
  if (!multitaskerId) {
    const directHit = sessionManager.getSession(shellSessionId);
    if (directHit) {
      multitaskerId = directHit.id;
      multitaskerSessionIdByShellSessionId.set(shellSessionId, multitaskerId);
    }
  }
  if (!multitaskerId) {
    // Not registered (yet?). 200 to avoid retry storms from gateway.
    writeJsonResponse(response, 200, { ok: true, mapped: false });
    return;
  }
  // Translate analyzer status -> SessionStatus expected by the desktop UI.
  let sessionStatus: 'needs_attention' | 'running' | null = null;
  if (status === 'needs_input') sessionStatus = 'needs_attention';
  else if (status === 'working') sessionStatus = 'running';
  else if (status === 'idle') sessionStatus = 'running';
  if (!sessionStatus) {
    writeJsonResponse(response, 400, { ok: false, error: 'invalid_status' });
    return;
  }

  const debugReason = [agentKind ? `[${agentKind}]` : '', reason].filter(Boolean).join(' ').trim();
  const update: TerminalUpdate = {
    id: multitaskerId,
    status: sessionStatus,
    occurredAt,
  };
  if (debugReason) update.debugReason = debugReason.slice(0, 500);
  if (matchedText) update.debugMatchedText = matchedText.slice(0, 500);

  // Always broadcast SSE event for Electron UI to receive status updates
  broadcastSseEvent('terminal:update', update);
  // Also handle backend state if needed
  if (shouldBackendOwnState()) {
    handleTerminalUpdate(update);
  }
  writeJsonResponse(response, 200, { ok: true, mapped: true });
}

function handleClientMetadataPost(payload: unknown, response: import('http').ServerResponse): void {
  if (typeof payload !== 'object' || payload === null) {
    writeJsonResponse(response, 400, { ok: false, error: 'invalid_payload' });
    return;
  }
  const record = payload as Record<string, unknown>;
  const shellSessionId = readStringField(record, 'shellSessionId').trim();
  if (!shellSessionId) {
    writeJsonResponse(response, 400, { ok: false, error: 'missing_shellSessionId' });
    return;
  }
  const metadata = normalizeClientMetadata(record['clientMetadata']);
  if (!metadata) {
    writeJsonResponse(response, 400, { ok: false, error: 'invalid_clientMetadata' });
    return;
  }
  // Try to resolve the multitasker session id from the existing map or by
  // direct lookup (shell session ids are conflated with multitasker ids by
  // design). If the session hasn't been registered yet (race with the
  // supervisor's MultitaskerBridge POSTing /api/session/create), stash the
  // metadata so createSessionFromPayload can apply it on arrival.
  let multitaskerId = multitaskerSessionIdByShellSessionId.get(shellSessionId);
  if (!multitaskerId) {
    const directHit = sessionManager.getSession(shellSessionId);
    if (directHit) {
      multitaskerId = directHit.id;
      multitaskerSessionIdByShellSessionId.set(shellSessionId, multitaskerId);
    }
  }
  if (!multitaskerId) {
    pendingClientMetadataByShellSessionId.set(shellSessionId, metadata);
    writeJsonResponse(response, 200, { ok: true, pending: true });
    return;
  }
  const updated = sessionManager.setClientMetadata(multitaskerId, metadata);
  if (!updated) {
    writeJsonResponse(response, 404, { ok: false, error: 'session_not_found' });
    return;
  }
  maybeRenameFromClientMetadata(multitaskerId, metadata);
  saveSessions(getSessionsStateToSave());
  writeJsonResponse(response, 200, { ok: true, mapped: true });
}

/**
 * When a session is opened from a VS Code integrated terminal (or any other
 * client that reports a workspace folder), upgrade the auto-generated name
 * (e.g. `shell ab123456`) to the basename of the workspace folder. User-set
 * names are left alone.
 */
function maybeRenameFromClientMetadata(
  sessionId: string,
  metadata: import('../../../shared/settings').PersistedClientMetadata,
): void {
  const workspace = metadata.workspace?.trim();
  if (!workspace) return;
  const session = sessionManager.getSession(sessionId);
  if (!session) return;
  // Only override auto-generated names: `<prefix> <8 hex>`. Trying both the
  // configured prefix and a generic fallback so the rule still triggers if the
  // prefix env was set.
  if (!/^[A-Za-z0-9_-]+\s+[a-f0-9]{8}$/.test(session.name)) return;
  const base = lastPathSegment(workspace);
  if (!base || base === session.name) return;
  sessionManager.renameSession(sessionId, base);
}

function lastPathSegment(p: string): string {
  // Handle both \ and / so this works for Windows paths sent from VS Code.
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
