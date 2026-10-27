const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { WebSocket } = require('ws');

const root = path.resolve(__dirname, '..');
const data = fs.mkdtempSync(path.join(root, '.tmp/desktop-smoke-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
  const server = net.createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const result = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return result;
}

async function main() {
  const [debugPort, backendPort, shellPort] = await Promise.all([port(), port(), port()]);
  const child = spawn(path.join(root, 'release/win-unpacked/Multitasker.exe'), [`--remote-debugging-port=${debugPort}`], {
    windowsHide: true, stdio: 'ignore', env: { ...process.env,
      MULTITASKER_DATA_DIR: data, MULTITASKER_BACKEND_PORT: String(backendPort),
      SHELL_PORT: String(shellPort), MULTITASKER_BACKEND_URL: `http://127.0.0.1:${backendPort}`,
      MULTITASKER_SHELL_SERVER_URL: `ws://127.0.0.1:${shellPort}`,
      MULTITASKER_SHELL_PIPE: `\\\\.\\pipe\\multitasker-desktop-test-${process.pid}`,
    },
  });
  let socket;
  try {
    let target;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`Desktop exited with ${child.exitCode}; logs: ${data}`);
      try {
        const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
        target = targets.find(item => item.type === 'page' && item.url.startsWith('file:'));
        if (target) break;
      } catch { /* Wait for Chromium. */ }
      await pause(200);
    }
    if (!target) throw new Error(`No renderer found; logs: ${data}`);
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await once(socket, 'open');
    let sequence = 0;
    const pending = new Map();
    socket.on('message', raw => {
      const message = JSON.parse(raw);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    });
    function send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timeout = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 10000);
        pending.set(id, message => { clearTimeout(timeout); resolve(message); });
        socket.send(JSON.stringify({ id, method, params }));
      });
    }
    let text = '';
    for (let attempt = 0; attempt < 50; attempt++) {
      const result = await send('Runtime.evaluate', { expression: 'document.getElementById("root")?.innerText', returnByValue: true });
      text = result.result?.result?.value || '';
      if (text.length > 40) break;
      await pause(200);
    }
    if (text.length <= 40) throw new Error('Packaged renderer is empty');
    const screenshot = await send('Page.captureScreenshot');
    fs.writeFileSync(path.join(data, 'desktop.png'), Buffer.from(screenshot.result.data, 'base64'));
    console.log(`Packaged desktop rendered successfully. Screenshot: ${path.join(data, 'desktop.png')}`);
    // Chromium can close its debugging socket before acknowledging Browser.close.
    const exited = once(child, 'exit');
    socket.send(JSON.stringify({ id: ++sequence, method: 'Browser.close' }));
    await Promise.race([exited, pause(10000)]);
  } finally {
    socket?.close();
    if (child.exitCode === null && child.pid) {
      execFileSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
