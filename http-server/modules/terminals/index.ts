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
        path: '/terminal-event',
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
  // Always broadcast SSE event for Electron UI
  broadcastSseEvent('terminal:update', update);
  // Also handle backend state if needed
  if (shouldBackendOwnState()) {
    handleTerminalUpdate(update);
  }
  writeJsonResponse(response, 200, { ok: true });
}

function handleTerminalEventPost(payload: unknown, response: import('http').ServerResponse): void {
  // High-frequency events (terminal_output emitted at every spinner frame,
  // visibility/interaction events that just re-trigger status detection) are
  // now ignored here: the shell-server gateway already runs a snapshot-based
  // output analyzer and POSTs authoritative status changes to
  // /api/shell/agent-status. Processing them again would just re-run the
  // legacy AGENT_PROFILES regex stack per chunk and bog down the backend
  // event loop — which is exactly what made Codex CLI feel laggy.
  if (typeof payload === 'object' && payload !== null) {
    const t = (payload as Record<string, unknown>)['type'];
    if (t === 'terminal_output' || t === 'terminal_visible' || t === 'terminal_interacted') {
      writeJsonResponse(response, 200, { ok: true, skipped: true });
      return;
    }
  }

  const event = parseTerminalEventRequest(payload);
  if (!event) {
    writeJsonResponse(response, 400, { ok: false, error: 'invalid_terminal_event' });
    return;
  }

  // Always broadcast SSE event for Electron UI
  if (isTerminalEventRelayPayload(payload)) {
    broadcastSseEvent('terminal:event', payload);
  }
  // Also handle backend state if needed
  if (shouldBackendOwnState()) {
    handleTerminalEvent(event);
  }
  writeJsonResponse(response, 200, { ok: true });
}
