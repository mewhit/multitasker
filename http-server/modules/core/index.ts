import path from 'node:path';
import type { HttpModule, RouteDef } from '../../core/types';
import { writeJsonResponse } from '../../core/body';
import { getBackendState } from '../../core/backend-state';

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
