const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('Build this installer with Windows x64 Node.js.');
}
const root = path.resolve(__dirname, '..');
const slackConfig = require('../packaging/slack-config.cjs').buildConfig(path.join(root, 'extension/slack/.env'));
const stage = path.join(root, '.tmp', 'windows-app');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function npm(args, cwd = root) {
  execFileSync('npm.cmd', args, { cwd, stdio: 'inherit', shell: true });
}

npm(['run', 'build']);
// This fixed staging directory contains generated packaging files only.
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.cpSync(path.join(root, 'dist'), path.join(stage, 'dist'), { recursive: true });
fs.copyFileSync(path.join(root, 'packaging/main.cjs'), path.join(stage, 'main.cjs'));
fs.copyFileSync(path.join(root, 'packaging/slack-config.cjs'), path.join(stage, 'slack-config.cjs'));
fs.writeFileSync(path.join(stage, 'slack-oauth-config.json'), JSON.stringify(slackConfig, null, 2));
fs.cpSync(path.join(root, 'extension/slack/src'), path.join(stage, 'extension/slack/src'), { recursive: true });
fs.mkdirSync(path.join(stage, 'runtime'), { recursive: true });
fs.copyFileSync(process.execPath, path.join(stage, 'runtime/node.exe'));
fs.copyFileSync(path.join(path.dirname(process.execPath), 'LICENSE'), path.join(stage, 'runtime/NODE-LICENSE.txt'));

const dependencies = {};
for (const project of ['', 'desktop', 'http-server', 'shell', 'ws-server']) {
  const directory = path.join(root, project);
  const manifest = read(path.join(directory, 'package.json'));
  for (const name of Object.keys(manifest.dependencies || {})) {
    if (name === 'multitasker' || name === 'node-window-manager' || name.startsWith('@xterm/') && project === 'desktop' || name === 'react' || name === 'react-dom') continue;
    // Pin the runtime to the dependency versions used by the local build.
    const installed = path.join(directory, 'node_modules', name, 'package.json');
    const fallback = path.join(root, 'node_modules', name, 'package.json');
    dependencies[name] = read(fs.existsSync(installed) ? installed : fallback).version;
  }
}
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
  name: 'multitasker', version: read(path.join(root, 'package.json')).version,
  description: 'Multitasker desktop application', author: 'Multitasker',
  main: 'main.cjs', dependencies,
}, null, 2));
npm(['install', '--omit=dev', '--no-audit', '--no-fund'], stage);
const builder = path.join(root, 'packaging/node_modules/electron-builder/cli.js');
if (!fs.existsSync(builder)) npm(['ci', '--no-audit', '--no-fund'], path.join(root, 'packaging'));
execFileSync(process.execPath, [builder, '--config', 'packaging/electron-builder.cjs', '--win', '--x64'], {
  cwd: root, stdio: 'inherit',
});
