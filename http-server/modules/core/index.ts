import path from 'node:path';
import type { HttpModule, RouteDef } from '../../core/types';
import { writeJsonResponse } from '../../core/body';
import { getBackendNextUpItems, getBackendState } from '../../core/backend-state';
import { broadcastSseEvent } from '../../core/sse';
import { markBackendNextUpDone, setBackendNextUpOrder } from '../../core/next-up-state';
import { isRecord, readPayloadString, readStringArrayField } from '../../utils/payload';

export const coreModule: HttpModule = {
  name: 'core',
  routes(): RouteDef[] {
    return [
      {
        method: 'GET',
        path: '/api/state',
        handler({ response }) {
          writeJsonResponse(response, 200, { ok: true, state: getBackendState() });
        },
      },
      {
        method: 'GET',
        path: '/api/next-up',
        handler({ response }) {
          writeJsonResponse(response, 200, { ok: true, nextUp: getBackendNextUpItems() });
        },
      },
      {
        method: 'POST',
        path: '/api/next-up/order',
        handler({ payload, response }) {
          const keys = isRecord(payload) ? readStringArrayField(payload, 'keys') : [];
          if (keys.length === 0) {
            writeJsonResponse(response, 400, { ok: false, error: 'missing_next_up_order' });
            return;
          }
          const state = setBackendNextUpOrder(keys);
          broadcastNextUpState();
          writeJsonResponse(response, 200, { ok: true, nextUp: state.items });
        },
      },
      {
        method: 'POST',
        path: '/api/next-up/done',
        handler({ payload, response }) {
          const key = readPayloadString(payload, 'key').trim();
          if (!key) {
            writeJsonResponse(response, 400, { ok: false, error: 'missing_next_up_key' });
            return;
          }
          const state = markBackendNextUpDone(key);
          broadcastNextUpState();
          writeJsonResponse(response, 200, { ok: true, nextUp: state.items });
        },
      },
      {
        method: 'GET',
        path: '/api/config',
        handler({ response }) {
          writeJsonResponse(response, 200, {
            ok: true,
            dataDirectory: path.resolve(process.cwd(), '.multitasker-data'),
            cwd: process.cwd(),
            nodeVersion: process.version,
            platform: process.platform,
          });
        },
      },
    ];
  },
};

function broadcastNextUpState(): void {
  broadcastSseEvent('next-up:list-update', getBackendNextUpItems());
  broadcastSseEvent('state', getBackendState());
}
