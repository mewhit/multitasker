import type { HttpModule, RouteDef } from '../../core/types';
import { writeJsonResponse } from '../../core/body';

export const healthModule: HttpModule = {
  name: 'health',
  routes(): RouteDef[] {
    return [
      {
        method: 'GET',
        path: '/api/health',
        handler({ response }) {
          writeJsonResponse(response, 200, { ok: true });
        },
      },
    ];
  },
};
