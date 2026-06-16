import type { ServerResponse } from 'node:http';
import { writeJsonResponse } from '../../core/body';
import type { HttpModule, RouteDef } from '../../core/types';
import { getErrorMessage } from '../../core/util';
import { checkDatabaseConnection } from '../../db';

export const databaseModule: HttpModule = {
  name: 'database',
  routes(): RouteDef[] {
    return [
      {
        method: 'GET',
        path: '/api/database/health',
        handler({ response }) {
          return handleDatabaseHealth(response);
        },
      },
      {
        method: 'GET',
        path: '/api/db/health',
        handler({ response }) {
          return handleDatabaseHealth(response);
        },
      },
    ];
  },
};

async function handleDatabaseHealth(response: ServerResponse): Promise<void> {
  try {
    await checkDatabaseConnection();
    writeJsonResponse(response, 200, { ok: true });
  } catch (error) {
    writeJsonResponse(response, 503, { ok: false, error: getErrorMessage(error) });
  }
}
