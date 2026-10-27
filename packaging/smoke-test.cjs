const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');

const root = path.resolve(__dirname, '..');
const stage = path.join(root, '.tmp/windows-app');
const node = path.join(stage, 'runtime/node.exe');
const work = fs.mkdtempSync(path.join(root, '.tmp/installer-smoke-'));
const children = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function unusedPort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function main() {
  const backendPort = await unusedPort();
  const shellPort = await unusedPort();
  const env = { ...process.env, MULTITASKER_DATA_DIR: work,
    MULTITASKER_BACKEND_PORT: String(backendPort), SHELL_PORT: String(shellPort),
    MULTITASKER_BACKEND_URL: `http://127.0.0.1:${backendPort}`,
    MULTITASKER_SHELL_PIPE: `\\\\.\\pipe\\multitasker-installer-test-${process.pid}`,
  };
  assert(fs.existsSync(path.join(stage, 'dist/renderer/index.html')));
  execFileSync(node, ['-e', "require('node-pty'); require('ssh2'); require('pg'); require('ws'); console.log('Bundled runtime dependencies OK')"], { cwd: stage, stdio: 'inherit' });
  for (const entry of ['shell/supervisor/index.js', 'ws-server/server.js', 'http-server/server.js']) {
    const child = spawn(node, [path.join(stage, 'dist', entry)], { cwd: work, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.output = '';
    child.stdout.on('data', data => child.output += data);
    child.stderr.on('data', data => child.output += data);
    children.push(child);
  }
  let healthy = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    for (const child of children) assert.equal(child.exitCode, null, child.output);
    try {
      const response = await fetch(`http://127.0.0.1:${backendPort}/api/health`);
      healthy = response.ok;
      if (healthy) break;
    } catch { /* Wait for backend readiness. */ }
    await pause(100);
  }
  assert(healthy, 'Backend did not become healthy');
  const { WebSocket } = require(path.join(stage, 'node_modules/ws'));
  const socket = new WebSocket(`ws://127.0.0.1:${shellPort}`);
  try {
    await Promise.race([once(socket, 'open'), pause(10000).then(() => { throw new Error('Gateway timeout'); })]);
  } finally { socket.close(); }
  console.log('Bundled backend health and shell gateway connection OK');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
  await Promise.all(children.map(child => child.exitCode === null ? once(child, 'exit') : Promise.resolve()));
});
