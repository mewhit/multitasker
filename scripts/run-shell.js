const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Production launcher: starts the supervisor first, waits for its IPC pipe
// to accept a probe connection, then starts the gateway WS server. Either
// process exiting cleanly terminates the other.

const projectRoot = path.resolve(__dirname, '..');
const distDir = path.join(projectRoot, 'dist');
const supervisorEntry = path.join(distDir, 'shell', 'supervisor', 'index.js');
const gatewayEntry = path.join(distDir, 'ws-server', 'server.js');
const gracefulShutdownMs = 2000;
const probeIntervalMs = 100;
const probeTimeoutMs = 10000;

function pipePath() {
  const override = process.env.MULTITASKER_SHELL_PIPE;
  if (override && override.trim()) return override.trim();
  const name = 'multitasker-shell-supervisor';
  if (process.platform === 'win32') return `\\\\.\\pipe\\${name}`;
  return path.join(os.tmpdir(), `${name}.sock`);
}

function probePipe(p) {
  return new Promise((resolve) => {
    const s = net.createConnection({ path: p }, () => {
      s.end();
      resolve(true);
    });
    s.on('error', () => resolve(false));
  });
}

async function waitForPipe(p) {
  const deadline = Date.now() + probeTimeoutMs;
  while (Date.now() < deadline) {
    if (await probePipe(p)) return;
    await new Promise((r) => setTimeout(r, probeIntervalMs));
  }
  throw new Error(`supervisor pipe not ready after ${probeTimeoutMs}ms: ${p}`);
}

function log(msg) {
  console.log(`[run-shell] ${msg}`);
}

async function main() {
  if (!fs.existsSync(supervisorEntry) || !fs.existsSync(gatewayEntry)) {
    throw new Error('build artifacts missing; run `yarn build` first');
  }

  const supervisor = spawn(process.execPath, [supervisorEntry], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  });
  log(`supervisor pid ${supervisor.pid}`);

  let shuttingDown = false;
  let gateway = null;

  function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true;
    const procs = [gateway, supervisor].filter(Boolean);
    if (procs.length === 0) {
      process.exit(code);
      return;
    }
    const timer = setTimeout(() => process.exit(code), gracefulShutdownMs);
    let remaining = procs.length;
    for (const p of procs) {
      p.once('exit', () => {
        remaining--;
        if (remaining === 0) {
          clearTimeout(timer);
          process.exit(code);
        }
      });
      try {
        p.kill();
      } catch {
        // ignore
      }
    }
  }

  supervisor.once('exit', (code, signal) => {
    log(`supervisor exited${signal ? ` from ${signal}` : ` code ${code ?? 0}`}`);
    shutdown(code ?? 0);
  });

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  try {
    await waitForPipe(pipePath());
  } catch (e) {
    log(`error waiting for supervisor: ${e.message}`);
    shutdown(1);
    return;
  }

  gateway = spawn(process.execPath, [gatewayEntry], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  });
  log(`gateway pid ${gateway.pid}`);
  gateway.once('exit', (code, signal) => {
    log(`gateway exited${signal ? ` from ${signal}` : ` code ${code ?? 0}`}`);
    shutdown(code ?? 0);
  });
}

main().catch((err) => {
  console.error(`[run-shell] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

