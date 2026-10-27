const { app, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

if (process.env.MULTITASKER_DATA_DIR) {
  const directory = path.resolve(process.env.MULTITASKER_DATA_DIR);
  fs.mkdirSync(directory, { recursive: true });
  app.setPath('userData', directory);
}

// Acquire the lock before starting services, including during login startup.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  const data = app.getPath('userData');
  const logs = path.join(data, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  process.chdir(data);
  process.env.MULTITASKER_DATA_DIR = data;
  const node = path.join(process.resourcesPath, 'runtime', 'node.exe');
  // OAuth files must remain writable and survive application upgrades.
  fs.cpSync(path.join(__dirname, 'extension'), path.join(data, 'extension'), {
    recursive: true,
  });
  require('./slack-config.cjs').applyConfig(
    require('./slack-oauth-config.json'),
    path.join(data, 'extension/slack/.env'),
  );
  const children = [];
  let quitting = false;
  app.on('before-quit', () => {
    quitting = true;
    for (const child of children) {
      if (!child.pid || child.exitCode !== null) continue;
      try {
        execFileSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } catch { /* The process may already have exited. */ }
    }
  });
  for (const [name, entry] of [
    ['supervisor', 'shell/supervisor/index.js'],
    ['gateway', 'ws-server/server.js'],
    ['backend', 'http-server/server.js'],
  ]) {
    const fd = fs.openSync(path.join(logs, `${name}.log`), 'a');
    const child = spawn(node, [path.join(__dirname, 'dist', entry)], {
      cwd: data,
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    });
    fs.closeSync(fd);
    children.push(child);
    const failed = (detail) => {
      if (quitting) return;
      quitting = true;
      dialog.showErrorBox('Multitasker could not start', `${name}: ${detail}\nLogs: ${logs}`);
      app.quit();
    };
    child.on('error', error => failed(error.message));
    child.on('exit', code => failed(`service stopped (exit ${code})`));
  }
  require('./dist/desktop/src/main.js');
}
