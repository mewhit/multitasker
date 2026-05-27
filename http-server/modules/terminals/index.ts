import type { HttpModule, RouteDef } from '../../core/types';
import { writeJsonResponse } from '../../core/body';
import { shouldBackendOwnState } from '../../core/constants';
import { broadcastSseEvent } from '../../core/sse';
import { handleTerminalUpdate, handleTerminalEvent } from './apply';
import { parseTerminalUpdateRequest, parseTerminalEventRequest, isTerminalEventRelayPayload } from './parse';

export const terminalsModule: HttpModule = {
  name: 'terminals',
  routes(): RouteDef[] {
    return [
      {
        method: 'POST',
        path: '/terminal-update',
        handler({ payload, response }) {
          handleTerminalUpdatePost(payload, response);
        },
      },
      {
        method: 'POST',
        path: '/extensions/vscode/terminal-updates',
        handler({ payload, response }) {
          handleTerminalUpdatePost(payload, response);
        },
      },
      {
        method: 'POST',
        path: '/terminal-event',
        handler({ payload, response }) {
          handleTerminalEventPost(payload, response);
        },
      },
      {
        method: 'POST',
        path: '/extensions/vscode/terminal-events',
        handler({ payload, response }) {
          handleTerminalEventPost(payload, response);
        },
      },
    ];
  },
};

function handleTerminalUpdatePost(payload: unknown, response: import('http').ServerResponse): void {
  const update = parseTerminalUpdateRequest(payload);
  if (!update) {
    writeJsonResponse(response, 400, { ok: false, error: 'invalid_terminal_update' });
    return;
  }
  if (shouldBackendOwnState()) {
    handleTerminalUpdate(update);
  } else {
    broadcastSseEvent('terminal:update', update);
  }
  writeJsonResponse(response, 200, { ok: true });
}

function handleTerminalEventPost(payload: unknown, response: import('http').ServerResponse): void {
  if (shouldBackendOwnState()) {
    const event = parseTerminalEventRequest(payload);
    if (!event) {
      writeJsonResponse(response, 400, { ok: false, error: 'invalid_terminal_event' });
      return;
    }
    handleTerminalEvent(event);
    writeJsonResponse(response, 200, { ok: true });
    return;
  }

  if (!isTerminalEventRelayPayload(payload)) {
    writeJsonResponse(response, 400, { ok: false, error: 'invalid_terminal_event' });
    return;
  }
  broadcastSseEvent('terminal:event', payload);
  writeJsonResponse(response, 200, { ok: true });
}
