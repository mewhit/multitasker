import type { HttpModule, RouteDef } from '../../core/types';
import type { Session } from '../../../desktop/sessionManager';
import { writeJsonResponse } from '../../core/body';
import { getErrorMessage } from '../../core/util';
import { readPayloadString } from '../../utils/payload';
import { sessionManager, pendingLaunchTaskIdByLaunchId } from '../../state/sessions';
import { saveSessions } from '../../../desktop/settings';
import { rememberVsCodeWindow } from '../vscode/windows';
import { handleTerminalEvent, handleTerminalUpdate, rememberTaskTerminalBinding, flushPendingTerminalUpdates, flushPendingTerminalEvents, forgetRemovedSession } from '../terminals/apply';
import { parseTerminalUpdateRequest, parseTerminalEventRequest } from '../terminals/parse';
import { parseCreateSessionRequest, getSessionsStateToSave } from '../sessions/parse';

export const deepLinksModule: HttpModule = {
  name: 'deep-links',
  routes(): RouteDef[] {
    return [
      {
        method: 'POST',
        path: '/api/deeplink',
        handler({ payload, response }) {
          const url = readPayloadString(payload, 'url').trim();
          if (!url) {
            writeJsonResponse(response, 400, { ok: false, error: 'missing_url' });
            return;
          }

          const result = processDeepLink(url);
          if (!result.ok) {
            writeJsonResponse(response, 400, result);
            return;
          }
          writeJsonResponse(response, 200, result);
        },
      },
    ];
  },
};

function processDeepLink(url: string): { ok: true; action: 'none' | 'open-vscode'; session?: Session } | { ok: false; error: string } {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch (error) {
    return { ok: false, error: `invalid URL: ${getErrorMessage(error)}` };
  }

  if (parsedUrl.protocol !== 'multitasker:') return { ok: true, action: 'none' };
  const createPath = isDeepLinkPath(parsedUrl, '/create', 'create');
  const terminalPath = isDeepLinkPath(parsedUrl, '/terminal', 'terminal');
  if (!createPath && !terminalPath) return { ok: false, error: `unsupported path "${parsedUrl.pathname}"` };

  const payloadParam = parsedUrl.searchParams.get('payload');
  if (!payloadParam) return { ok: false, error: 'missing payload' };

  let parsedPayload: unknown;
  try {
    parsedPayload = parseDeepLinkPayload(payloadParam);
  } catch (error) {
    return { ok: false, error: `invalid payload JSON: ${getErrorMessage(error)}` };
  }

  if (terminalPath) {
    const event = parseTerminalEventRequest(parsedPayload);
    if (event) {
      handleTerminalEvent(event);
      return { ok: true, action: 'none' };
    }

    const update = parseTerminalUpdateRequest(parsedPayload);
    if (!update) return { ok: false, error: 'invalid terminal payload' };
    handleTerminalUpdate(update);
    return { ok: true, action: 'none' };
  }

  const request = parseCreateSessionRequest(parsedPayload);
  if (!request) return { ok: false, error: 'invalid session payload' };

  if (request.id) forgetRemovedSession(request.id);
  if (request.vscodeWindowId) rememberVsCodeWindow({ windowId: request.vscodeWindowId });
  const session = sessionManager.createSession(
    request.name,
    request.cmd,
    request.cwd,
    request.shellType,
    request.id ?? '',
    request.sshCommand ?? '',
    request.vscodeWindowId ?? '',
    request.terminalRef ?? '',
    request.terminalPid
  );
  rememberTaskTerminalBinding(session.id, {
    vscodeWindowId: request.vscodeWindowId,
    terminalRef: request.terminalRef,
    terminalPid: request.terminalPid,
  });
  if (request.launchId) pendingLaunchTaskIdByLaunchId.set(request.launchId, session.id);
  saveSessions(getSessionsStateToSave());
  flushPendingTerminalUpdates(session.id);
  flushPendingTerminalEvents(session.id);
  return request.terminalRef ? { ok: true, action: 'none', session } : { ok: true, action: 'open-vscode', session };
}

function parseDeepLinkPayload(rawPayload: string): unknown {
  let current = rawPayload;
  for (let i = 0; i < 3; i += 1) {
    try {
      return JSON.parse(current);
    } catch {
      let decoded: string;
      try {
        decoded = decodeURIComponent(current);
      } catch {
        break;
      }
      if (decoded === current) break;
      current = decoded;
    }
  }
  throw new Error('Invalid payload JSON');
}

function isDeepLinkPath(parsedUrl: URL, pathName: string, hostName: string): boolean {
  return (
    parsedUrl.pathname === pathName ||
    (parsedUrl.hostname === hostName && (parsedUrl.pathname === '' || parsedUrl.pathname === '/'))
  );
}
