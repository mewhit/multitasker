import { PORT } from './core/constants';
import { startHttpServer, stopHttpServer } from './core/http-server';
import { closeSseClients, broadcastSseEvent } from './core/sse';
import { getBackendState } from './core/backend-state';
import { Router } from './core/router';
import type { RouteDef } from './core/types';
import { sessionManager } from './state/sessions';
import { modules } from './modules';
import { restorePersistedState } from './modules/sessions/persistence';

// Register session update listener - broadcasts state changes via SSE
sessionManager.on('sessionUpdate', (sessions: unknown) => {
  broadcastSseEvent('session:list-update', sessions);
  broadcastSseEvent('state', getBackendState());
});

// Restore persisted state (sessions, tasks, notifications)
restorePersistedState();

// Collect all routes from modules
const allRoutes: RouteDef[] = [];
for (const module of modules) {
  allRoutes.push(...module.routes());
}

// Build router from collected routes
const router = new Router(allRoutes);

// Initialize all modules (starts schedulers, etc.)
async function initModules(): Promise<void> {
  for (const module of modules) {
    if (module.init) {
      await module.init();
    }
  }
}

// Dispose all modules (stops schedulers, etc.)
function disposeModules(): void {
  for (const module of modules) {
    if (module.dispose) {
      module.dispose();
    }
  }
}

// Graceful shutdown handler
function shutdown(): void {
  disposeModules();
  closeSseClients();
  stopHttpServer();
}

// Register signal handlers for graceful shutdown
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start the server
void initModules().then(() => {
  startHttpServer(PORT, router);
});
