const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadDotenv } = require('./load-dotenv');

const projectRoot = path.resolve(__dirname, '..');
loadDotenv(path.join(projectRoot, '.env'));
const distDir = path.join(projectRoot, 'dist');
const shellDistDir = path.join(distDir, 'shell');
const wsServerDistDir = path.join(distDir, 'ws-server');
const serverFile = path.join(wsServerDistDir, 'server.js');
const defaultLogFile = path.join(projectRoot, '.tmp', 'ws-server', 'server.log');
const restartDebounceMs = 300;
const fileCheckMs = 250;
const gracefulShutdownMs = 2000;

let child = null;
let restartTimer = null;
let restarting = false;
let shuttingDown = false;
const watchers = [];

function log(message) {
  console.log(`[dev-shell] ${message}`);
}

function resolveLogFile() {
  const specific = process.env.SHELL_GATEWAY_LOG_FILE;
  if (specific && specific.trim()) return specific.trim();
  const legacy = process.env.SHELL_LOG_FILE;
  if (legacy && legacy.trim()) {
    return path.join(path.dirname(legacy.trim()), 'ws-server', 'server.log');
  }
  return defaultLogFile;
}

function waitForBuild() {
  if (fs.existsSync(serverFile)) return Promise.resolve();
  log('waiting for dist\\ws-server\\server.js...');
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (!fs.existsSync(serverFile)) return;
      clearInterval(timer);
      resolve();
    }, fileCheckMs);
  });
}

function startShell(reason) {
  if (shuttingDown || child) return;
  const logFile = resolveLogFile();
  const logLevel = process.env.SHELL_LOG_LEVEL || 'info';
  log(`${reason}: starting shell server (log level=${logLevel}, log file=${logFile || '<stderr only>'})`);
  child = spawn(process.execPath, [serverFile], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      SHELL_LOG_LEVEL: logLevel,
      SHELL_LOG_FILE: logFile,
    },
  });
  child.on('exit', (code, signal) => {
    child = null;
    if (shuttingDown) return;
    if (restarting) {
      restarting = false;
      startShell('restart');
      return;
    }
    log(`shell server exited${signal ? ` from ${signal}` : ` with code ${code ?? 0}`}.`);
    shutdown(code ?? 0);
  });
}

function scheduleRestart(reason) {
  if (shuttingDown) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    restartShell(reason);
  }, restartDebounceMs);
}

function restartShell(reason) {
  if (shuttingDown) return;
  if (!child) {
    startShell(`change detected in ${reason}`);
    return;
  }
  log(`change detected in ${reason}; restarting shell server`);
  restarting = true;
  const procToStop = child;
  const forceKillTimer = setTimeout(() => {
    if (child === procToStop) procToStop.kill('SIGKILL');
  }, gracefulShutdownMs);
  procToStop.once('exit', () => clearTimeout(forceKillTimer));
  procToStop.kill();
}

// Watch the gateway output AND the core/ipc modules it consumes (logger,
// analyzer, protocol, etc). PTYs live in the supervisor process - restarting
// the gateway is safe; existing PTYs survive and reattach.
function watchShellDist() {
  const dirsToWatch = [
    wsServerDistDir,
    path.join(shellDistDir, 'core'),
    path.join(shellDistDir, 'ipc'),
  ];
  for (const dir of dirsToWatch) {
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    }
    const w = fs.watch(dir, { recursive: true }, (_eventType, fileName) => {
      if (!fileName) {
        scheduleRestart(path.basename(dir));
        return;
      }
      const changedFile = String(fileName);
      if (changedFile.endsWith('.js') || changedFile.endsWith('.json')) {
        const relBase = dir === wsServerDistDir
          ? path.join('dist', 'ws-server')
          : path.join('dist', 'shell', path.basename(dir));
        scheduleRestart(path.join(relBase, changedFile));
      }
    });
    watchers.push(w);
  }
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (restartTimer) clearTimeout(restartTimer);
  for (const w of watchers) {
    try { w.close(); } catch { /* ignore */ }
  }
  watchers.length = 0;
  if (!child) {
    process.exit(code);
    return;
  }
  const procToStop = child;
  const exitTimer = setTimeout(() => process.exit(code), gracefulShutdownMs);
  procToStop.once('exit', () => {
    clearTimeout(exitTimer);
    process.exit(code);
  });
  procToStop.kill();
}

async function main() {
  await waitForBuild();
  watchShellDist();
  startShell('initial');
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

main().catch((error) => {
  console.error(`[dev-shell] ${error instanceof Error ? error.message : String(error)}`);
  shutdown(1);
});

