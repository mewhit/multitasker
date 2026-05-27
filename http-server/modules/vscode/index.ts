import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { HttpModule, RouteDef } from '../../core/types';
import type { VsCodeCommand, VsCodeWindowRegistration } from '../../types';
import { writeJsonResponse } from '../../core/body';
import { MAX_PENDING_VSCODE_COMMANDS_PER_WINDOW, VSCODE_COMMAND_LONG_POLL_TIMEOUT_MS } from '../../core/constants';
import { pendingVsCodeCommandsByWindowId, pendingVsCodeCommandPollsByWindowId } from '../../state/vscode';
import { sessionManager, pendingLaunchTaskIdByLaunchId } from '../../state/sessions';
import { readPayloadString } from '../../utils/payload';
import { rememberVsCodeWindow, parseVsCodeWindowRegistration } from './windows';

export const vscodeModule: HttpModule = {
  name: 'vscode',
  dispose() {
    closePendingVsCodeCommandPolls();
  },
  routes(): RouteDef[] {
    return [
      {
        method: 'POST',
        path: '/vscode-window',
        handler({ payload, response }) {
          handleVsCodeWindowPost(payload, response);
        },
      },
      {
        method: 'POST',
        path: '/extensions/vscode/windows',
        handler({ payload, response }) {
          handleVsCodeWindowPost(payload, response);
        },
      },
      {
        method: 'GET',
        path: /^\/vscode-command|\/extensions\/vscode\/commands$/,
        handler({ url, response }) {
          handleVsCodeCommandPoll(url, response);
        },
      },
      {
        method: 'POST',
        path: '/api/vscode/register-launch',
        handler({ payload, response }) {
          const launchId = readPayloadString(payload, 'launchId').trim();
          const sessionId = readPayloadString(payload, 'sessionId').trim();
          if (!launchId || !sessionId) {
            writeJsonResponse(response, 400, { ok: false, error: 'invalid_launch_registration' });
            return;
          }
          pendingLaunchTaskIdByLaunchId.set(launchId, sessionId);
          writeJsonResponse(response, 200, { ok: true });
        },
      },
      {
        method: 'POST',
        path: '/api/vscode/queue-command',
        handler({ payload, response }) {
          const windowId = readPayloadString(payload, 'windowId').trim();
          const terminalRef = readPayloadString(payload, 'terminalRef').trim();
          const commandType = readPayloadString(payload, 'type').trim();
          if (!windowId || !terminalRef || (commandType !== 'focus-terminal' && commandType !== 'disconnect-session')) {
            writeJsonResponse(response, 400, { ok: false, error: 'invalid_vscode_command' });
            return;
          }
          enqueueVsCodeCommand(windowId, { id: randomUUID(), type: commandType, terminalRef });
          writeJsonResponse(response, 200, { ok: true });
        },
      },
    ];
  },
};

function handleVsCodeWindowPost(payload: unknown, response: ServerResponse): void {
  const registration = parseVsCodeWindowRegistration(payload);
  if (!registration) {
    writeJsonResponse(response, 400, { ok: false, error: 'invalid_vscode_window' });
    return;
  }
  rememberVsCodeWindow(registration);
  writeJsonResponse(response, 200, { ok: true });
}

function handleVsCodeCommandPoll(requestUrl: URL, response: ServerResponse): void {
  const windowId = requestUrl.searchParams.get('windowId')?.trim();
  if (!windowId) {
    writeJsonResponse(response, 400, { ok: false, error: 'missing_window_id' });
    return;
  }

  rememberVsCodeWindow(readVsCodeWindowRegistrationFromUrl(requestUrl, windowId));
  const commands = pendingVsCodeCommandsByWindowId.get(windowId) ?? [];
  if (commands.length > 0) {
    pendingVsCodeCommandsByWindowId.delete(windowId);
    writeVsCodeCommandPollResponse(response, commands);
    return;
  }

  completePendingVsCodeCommandPoll(windowId, []);
  const timeout = setTimeout(() => {
    const pendingPoll = pendingVsCodeCommandPollsByWindowId.get(windowId);
    if (!pendingPoll || pendingPoll.response !== response) return;
    pendingVsCodeCommandPollsByWindowId.delete(windowId);
    writeVsCodeCommandPollResponse(response, []);
  }, VSCODE_COMMAND_LONG_POLL_TIMEOUT_MS);
  pendingVsCodeCommandPollsByWindowId.set(windowId, { response, timeout });
  response.on('close', () => {
    const pendingPoll = pendingVsCodeCommandPollsByWindowId.get(windowId);
    if (!pendingPoll || pendingPoll.response !== response) return;
    clearTimeout(pendingPoll.timeout);
    pendingVsCodeCommandPollsByWindowId.delete(windowId);
  });
}

export function enqueueVsCodeCommand(windowId: string, command: VsCodeCommand): void {
  const queue = pendingVsCodeCommandsByWindowId.get(windowId) ?? [];
  queue.push(command);
  while (queue.length > MAX_PENDING_VSCODE_COMMANDS_PER_WINDOW) queue.shift();
  pendingVsCodeCommandsByWindowId.set(windowId, queue);
  flushPendingVsCodeCommandPoll(windowId);
}

export function queueDisconnectSessionCommand(session: Pick<import('../../../desktop/sessionManager').Session, 'id' | 'vscodeWindowId' | 'terminalRef'>): boolean {
  const windowId = session.vscodeWindowId?.trim();
  const currentSession = sessionManager.getSession(session.id) ?? session;
  const terminalRef = currentSession.terminalRef?.trim();
  if (!windowId || !terminalRef) return false;
  enqueueVsCodeCommand(windowId, { id: randomUUID(), type: 'disconnect-session', terminalRef });
  return true;
}

function flushPendingVsCodeCommandPoll(windowId: string): void {
  if (!pendingVsCodeCommandPollsByWindowId.has(windowId)) return;
  const commands = pendingVsCodeCommandsByWindowId.get(windowId) ?? [];
  pendingVsCodeCommandsByWindowId.delete(windowId);
  completePendingVsCodeCommandPoll(windowId, commands);
}

function completePendingVsCodeCommandPoll(windowId: string, commands: VsCodeCommand[]): void {
  const pendingPoll = pendingVsCodeCommandPollsByWindowId.get(windowId);
  if (!pendingPoll) return;
  clearTimeout(pendingPoll.timeout);
  pendingVsCodeCommandPollsByWindowId.delete(windowId);
  if (!pendingPoll.response.writableEnded) writeVsCodeCommandPollResponse(pendingPoll.response, commands);
}

export function closePendingVsCodeCommandPolls(): void {
  for (const windowId of [...pendingVsCodeCommandPollsByWindowId.keys()]) {
    completePendingVsCodeCommandPoll(windowId, []);
  }
}

function writeVsCodeCommandPollResponse(response: ServerResponse, commands: VsCodeCommand[]): void {
  writeJsonResponse(response, 200, { ok: true, longPoll: true, commands });
}

function readVsCodeWindowRegistrationFromUrl(requestUrl: URL, windowId: string): VsCodeWindowRegistration {
  const registration: VsCodeWindowRegistration = { windowId };
  const workspaceFolder = requestUrl.searchParams.get('workspaceFolder')?.trim();
  if (workspaceFolder) registration.workspaceFolder = workspaceFolder;
  const workspaceName = requestUrl.searchParams.get('workspaceName')?.trim();
  if (workspaceName) registration.workspaceName = workspaceName;
  const rawPid = requestUrl.searchParams.get('pid');
  const pid = rawPid ? Number(rawPid) : NaN;
  if (Number.isFinite(pid)) registration.pid = pid;
  if (requestUrl.searchParams.get('sessionIdsKnown') === '1') {
    registration.sessionIds = requestUrl.searchParams.getAll('sessionId')
      .map(sessionId => sessionId.trim())
      .filter(sessionId => sessionId.length > 0);
  }
  return registration;
}
