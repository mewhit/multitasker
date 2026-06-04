import * as fs from 'fs';
import {
  MULTITASKER_BACKEND_URL,
  MULTITASKER_INTEGRATION_ENABLED,
  MULTITASKER_SHELL_NAME_PREFIX,
} from '../core/constants';
import { log } from '../core/logger';
import { MultitaskerBridge } from '../core/multitasker-bridge';
import { SessionManager } from '../core/session-manager';
import { ipcPipePath } from '../ipc/pipe';
import { startIpcServer, type IpcServer } from './ipc-server';

async function main(): Promise<void> {
  const pipePath = ipcPipePath();

  // On *nix, clean up a stale socket file from a previous crashed supervisor.
  if (process.platform !== 'win32') {
    try {
      const st = fs.statSync(pipePath);
      if (st.isSocket()) {
        try {
          fs.unlinkSync(pipePath);
          log.info('removed stale ipc socket', { pipePath });
        } catch (e) {
          log.warn('failed to remove stale ipc socket', {
            pipePath,
            error: (e as Error).message,
          });
        }
      }
    } catch {
      // not present, fine
    }
  }

  const sessions = new SessionManager();

  let bridge: MultitaskerBridge | undefined;
  if (MULTITASKER_INTEGRATION_ENABLED) {
    bridge = new MultitaskerBridge(sessions, {
      backendUrl: MULTITASKER_BACKEND_URL,
      namePrefix: MULTITASKER_SHELL_NAME_PREFIX,
    });
    bridge.start();
  } else {
    log.info('multitasker integration disabled (MULTITASKER_INTEGRATION=0)');
  }

  let ipc: IpcServer;
  try {
    ipc = await startIpcServer(pipePath, sessions);
  } catch (e) {
    log.error('supervisor failed to start', { error: (e as Error).message });
    process.exit(1);
  }

  let shuttingDown = false;
  function shutdown(reason: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('supervisor shutting down', { reason });
    bridge?.stop();
    ipc
      .close()
      .catch((e: unknown) => log.error('ipc close error', { error: (e as Error).message }))
      .finally(() => {
        sessions.killAll();
        // Give PTYs a brief moment to exit before we hard-exit.
        setTimeout(() => process.exit(0), 200);
      });
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (e) => {
    log.error('uncaughtException', { error: e.message, stack: e.stack });
  });
  process.on('unhandledRejection', (e) => {
    log.error('unhandledRejection', { error: String(e) });
  });
}

main().catch((e: unknown) => {
  log.error('supervisor crashed', { error: (e as Error).message });
  process.exit(1);
});
