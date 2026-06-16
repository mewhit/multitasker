"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const constants_1 = require("./core/constants");
const http_server_1 = require("./core/http-server");
const sse_1 = require("./core/sse");
const backend_state_1 = require("./core/backend-state");
const router_1 = require("./core/router");
const util_1 = require("./core/util");
const db_1 = require("./db");
const sessions_1 = require("./state/sessions");
const modules_1 = require("./modules");
const persistence_1 = require("./modules/sessions/persistence");
// Register session update listener - broadcasts state changes via SSE
sessions_1.sessionManager.on('sessionUpdate', (sessions) => {
    (0, sse_1.broadcastSseEvent)('session:list-update', sessions);
    (0, sse_1.broadcastSseEvent)('state', (0, backend_state_1.getBackendState)());
    (0, sse_1.broadcastSseEvent)('next-up:list-update', (0, backend_state_1.getBackendNextUpItems)());
});
// Restore persisted state (sessions, tasks, notifications)
(0, persistence_1.restorePersistedState)();
// Collect all routes from modules
const allRoutes = [];
for (const module of modules_1.modules) {
    allRoutes.push(...module.routes());
}
// Build router from collected routes
const router = new router_1.Router(allRoutes);
// Initialize all modules (starts schedulers, etc.)
async function initModules() {
    for (const module of modules_1.modules) {
        if (module.init) {
            await module.init();
        }
    }
}
// Dispose all modules (stops schedulers, etc.)
function disposeModules() {
    for (const module of modules_1.modules) {
        if (module.dispose) {
            module.dispose();
        }
    }
}
// Graceful shutdown handler
function shutdown() {
    disposeModules();
    (0, sse_1.closeSseClients)();
    (0, http_server_1.stopHttpServer)();
    void (0, db_1.closeDatabase)().catch(error => {
        console.error(`Failed to close Multitasker database connection: ${(0, util_1.getErrorMessage)(error)}`);
    });
}
// Register signal handlers for graceful shutdown
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Start the server
void initModules().then(() => {
    (0, http_server_1.startHttpServer)(constants_1.PORT, router);
});
