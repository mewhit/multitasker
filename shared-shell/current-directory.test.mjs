import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { CurrentDirectoryParser, POWERSHELL_DIRECTORY_PROMPT } from './current-directory.ts';

test('reads split OSC reports, escaped spaces and both terminators', () => {
  const parser = new CurrentDirectoryParser();
  assert.equal(parser.push('prompt\x1b'), undefined);
  assert.equal(parser.push(']7;file:///C:/dev/My%20'), undefined);
  assert.equal(parser.push('Project\x1b'), undefined);
  assert.equal(parser.push('\\PS> '), 'C:\\dev\\My Project');
  assert.equal(parser.push('\x1b]7;file:///home/me/project\x07'), '/home/me/project');
  assert.equal(parser.push('PS C:\\fake> cd elsewhere'), undefined);
  assert.equal(parser.push('\x1b]7;file:///bad%ZZ\x07'), undefined);
  assert.equal(parser.push('\x1b]7;file:///bad%0Apath\x07'), undefined);
});

test('PowerShell reports actual location after cd, failed cd and cd ..', { skip: process.platform !== 'win32' }, () => {
  const script = `${POWERSHELL_DIRECTORY_PROMPT}; Set-Location -LiteralPath '${process.cwd().replaceAll("'", "''")}'; prompt; Set-Location -LiteralPath './definitely-does-not-exist' -ErrorAction SilentlyContinue; prompt; Set-Location ..; prompt`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const reports = [...result.stdout.matchAll(/\x1b\]7;[^\x07]*\x07/g)].map(match => new CurrentDirectoryParser().push(match[0]));
  assert.deepEqual(reports, [process.cwd(), process.cwd(), process.cwd().replace(/\\[^\\]+$/, '')]);
});

test('directory events update Next up data without changing paused status; stale events are ignored', () => {
  const require = createRequire(import.meta.url);
  const { SessionManager } = require('../dist/shared/sessionManager.js');
  const manager = new SessionManager();
  const session = manager.createSession('Test', '', process.cwd(), 'powershell');
  try {
    manager.pauseSession(session.id);
    const now = Date.now() + 100;
    manager.updateTerminalEvent({ id: session.id, type: 'terminal_cwd', terminalCwd: 'C:\\new folder', occurredAt: now });
    assert.equal(manager.getSession(session.id).cwd, 'C:\\new folder');
    assert.equal(manager.getSession(session.id).status, 'paused');
    manager.updateTerminalEvent({ id: session.id, type: 'terminal_cwd', terminalCwd: 'C:\\old', occurredAt: now - 1 });
    assert.equal(manager.getSession(session.id).cwd, 'C:\\new folder');
  } finally { manager.removeSession(session.id); }
});
