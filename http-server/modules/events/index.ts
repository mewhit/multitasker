import type { HttpModule, RouteDef } from '../../core/types';
import { sseClients, writeSseEvent } from '../../core/sse';
import { getBackendState } from '../../core/backend-state';

export const eventsModule: HttpModule = {
  name: 'events',
  routes(): RouteDef[] {
    return [
      {
        method: 'GET',
        path: '/api/events',
        handler({ response }) {
          response.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });
          response.write(': connected\n\n');
          sseClients.add(response);
          writeSseEvent(response, 'state', getBackendState());
          response.on('close', () => {
            sseClients.delete(response);
          });
        },
      },
    ];
  },
};
