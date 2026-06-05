import { log } from './logger';
import { ipcPipePath } from '../shell/ipc/pipe';
import { SupervisorClient } from './supervisor-client';
import { startWsServer } from './ws-server';

async function main(): Promise<void> {
  const pipePath = ipcPipePath();
  const supervisor = new SupervisorClient(pipePath);
  supervisor.start();

  try {
    await supervisor.waitForReady();
  } catch (e) {
    log.error('failed to connect to supervisor', { error: (e as Error).message });
    process.exit(1);
  }

  const ws = startWsServer(supervisor);

  let shuttingDown = false;
  function shutdown(reason: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('gateway shutting down', { reason });
    ws
      .close()
      .catch((e: unknown) => log.error('ws close error', { error: (e as Error).message }))
      .finally(() => {
        supervisor.stop();
        setTimeout(() => process.exit(0), 50);
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
  log.error('gateway crashed', { error: (e as Error).message });
  process.exit(1);
});
