const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadDotenv } = require('./load-dotenv');

// Dev runner for the supervisor process.
//
// Unlike the WS gateway, the supervisor is intentionally NOT restarted on
// source changes — restarting it would kill every PTY and defeat the whole
// purpose of the split. If the supervisor's own code changes, we just print
// a warning so the developer knows they need to restart the supervisor by
// hand to pick up the new code.

const projectRoot = path.resolve(__dirname, '..');
loadDotenv(path.join(projectRoot, '.env'));
const distDir = path.join(projectRoot, 'dist');
const supervisorEntry = path.join(distDir, 'shell', 'supervisor', 'index.js');
const defaultLogFile = path.join(projectRoot, '.tmp', 'shell-supervisor', 'supervisor.log');
const watchDirs = [
  path.join(distDir, 'shell', 'supervisor'),
  path.join(distDir, 'shell', 'ipc'),
  path.join(distDir, 'shell', 'core'),
];
const gracefulShutdownMs = 2000;
const fileCheckMs = 250;

let child = null;
let shuttingDown = false;
const watchers = [];
let warned = false;

function log(msg) {
  console.log(`[dev-supervisor] ${msg}`);
}

function resolveLogFile() {
  const specific = process.env.SHELL_SUPERVISOR_LOG_FILE;
  if (specific && specific.trim()) return specific.trim();
  const legacy = process.env.SHELL_LOG_FILE;
  if (legacy && legacy.trim()) {
    return path.join(path.dirname(legacy.trim()), 'shell-supervisor', 'supervisor.log');
  }
  return defaultLogFile;
}

function waitForBuild() {
  if (fs.existsSync(supervisorEntry)) return Promise.resolve();
  log('waiting for dist\\shell\\supervisor\\index.js...');
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (!fs.existsSync(supervisorEntry)) return;
      clearInterval(timer);
      resolve();
    }, fileCheckMs);
  });
}

function startSupervisor() {
  if (shuttingDown || child) return;
  const logFile = resolveLogFile();
  const logLevel = process.env.SHELL_LOG_LEVEL || 'info';
  log(`starting supervisor (log level=${logLevel}, log file=${logFile || '<stderr only>'})`);
  child = spawn(process.execPath, [supervisorEntry], {
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
    log(`supervisor exited${signal ? ` from ${signal}` : ` with code ${code ?? 0}`}.`);
    // If the supervisor died unexpectedly, restart it once (PTYs are already
    // gone anyway). This keeps the dev environment usable after a crash.
    log('restarting supervisor in 500ms');
    setTimeout(startSupervisor, 500);
  });
}

function watchForSupervisorChanges() {
  for (const dir of watchDirs) {
    if (!fs.existsSync(dir)) continue;
    const w = fs.watch(dir, { recursive: true }, (_eventType, fileName) => {
      if (!fileName) return;
      const f = String(fileName);
      if (!(f.endsWith('.js') || f.endsWith('.json'))) return;
      if (!warned) {
        warned = true;
        log('--- supervisor source changed; restart it manually to apply (Ctrl-C and rerun shell:dev or `npm run shell`) ---');
        setTimeout(() => {
          warned = false;
        }, 5000);
      }
    });
    watchers.push(w);
  }
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const w of watchers) {
    try {
      w.close();
    } catch {
      // ignore
    }
  }
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

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

(async () => {
  await waitForBuild();
  watchForSupervisorChanges();
  startSupervisor();
})().catch((err) => {
  console.error(`[dev-supervisor] ${err instanceof Error ? err.message : String(err)}`);
  shutdown(1);
});
