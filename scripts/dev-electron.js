const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const electronPath = require('electron');

const projectRoot = path.resolve(__dirname, '..');
const distDir = path.join(projectRoot, 'dist');
const mainFile = path.join(distDir, 'desktop', 'main.js');
const rendererFile = path.join(projectRoot, 'index.html');
const restartDebounceMs = 500;
const mainFileCheckMs = 250;
const gracefulShutdownMs = 3000;

let electronProcess = null;
let restartTimer = null;
let restarting = false;
let shuttingDown = false;
let distWatcher = null;
let rendererWatcher = null;

function log(message) {
  console.log(`[dev-electron] ${message}`);
}

function waitForMainBuild() {
  if (fs.existsSync(mainFile)) return Promise.resolve();

  log('waiting for dist\\desktop\\main.js...');
  return new Promise(resolve => {
    const timer = setInterval(() => {
      if (!fs.existsSync(mainFile)) return;
      clearInterval(timer);
      resolve();
    }, mainFileCheckMs);
  });
}

function startElectron(reason) {
  if (shuttingDown || electronProcess) return;

  log(`${reason}: starting Electron`);
  electronProcess = spawn(electronPath, ['.'], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'development',
    },
  });

  electronProcess.on('exit', (code, signal) => {
    electronProcess = null;
    if (shuttingDown) return;

    if (restarting) {
      restarting = false;
      startElectron('restart');
      return;
    }

    log(`Electron exited${signal ? ` from ${signal}` : ` with code ${code ?? 0}`}.`);
    shutdown(code ?? 0);
  });
}

function scheduleRestart(reason) {
  if (shuttingDown) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    restartElectron(reason);
  }, restartDebounceMs);
}

function restartElectron(reason) {
  if (shuttingDown) return;

  if (!electronProcess) {
    startElectron(`change detected in ${reason}`);
    return;
  }

  log(`change detected in ${reason}; restarting Electron`);
  restarting = true;
  const processToStop = electronProcess;
  const forceKillTimer = setTimeout(() => {
    if (electronProcess === processToStop) processToStop.kill('SIGKILL');
  }, gracefulShutdownMs);
  processToStop.once('exit', () => clearTimeout(forceKillTimer));
  processToStop.kill();
}

function watchDist() {
  distWatcher = fs.watch(distDir, { recursive: true }, (_eventType, fileName) => {
    if (!fileName) {
      scheduleRestart('dist');
      return;
    }

    const changedFile = String(fileName);
    if (changedFile.endsWith('.js') || changedFile.endsWith('.json')) {
      scheduleRestart(path.join('dist', changedFile));
    }
  });
}

function watchRenderer() {
  if (!fs.existsSync(rendererFile)) return;
  rendererWatcher = fs.watch(rendererFile, () => {
    scheduleRestart('index.html');
  });
}

function closeWatchers() {
  distWatcher?.close();
  rendererWatcher?.close();
  distWatcher = null;
  rendererWatcher = null;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (restartTimer) clearTimeout(restartTimer);
  closeWatchers();

  if (!electronProcess) {
    process.exit(code);
    return;
  }

  const processToStop = electronProcess;
  const exitTimer = setTimeout(() => process.exit(code), gracefulShutdownMs);
  processToStop.once('exit', () => {
    clearTimeout(exitTimer);
    process.exit(code);
  });
  processToStop.kill();
}

async function main() {
  await waitForMainBuild();
  watchDist();
  watchRenderer();
  startElectron('initial');
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

main().catch(error => {
  console.error(`[dev-electron] ${error instanceof Error ? error.message : String(error)}`);
  shutdown(1);
});
