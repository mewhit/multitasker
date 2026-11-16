import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionManager } from './sessionManager.ts';

test('pause survives activity, terminal status and re-registration until explicit resume', () => {
  const manager = new SessionManager();
  const id = 'pause-regression';
  // SSH avoids local repository checks in this state-machine test.
  manager.createSession('logged-in-experience', 'copilot', '/app', 'ssh', id);
  try {
    assert.equal(manager.pauseSession(id)?.status, 'paused');
    assert.equal(manager.touchSession(id)?.status, 'paused');
    let occurredAt = Date.now() + 100;
    for (const status of ['running', 'needs_attention']) {
      assert.equal(manager.updateTerminalState({ id, status, occurredAt: occurredAt++ })?.status, 'paused');
    }
    for (const type of ['terminal_output', 'terminal_interacted', 'terminal_visible', 'terminal_attached']) {
      assert.equal(manager.updateTerminalEvent({
        id, type, occurredAt: occurredAt++, output: 'Do you want to run this command?',
      })?.status, 'paused');
    }
    assert.equal(manager.createSession('logged-in-experience', 'copilot', '/app', 'ssh', id).status, 'paused');
    assert.equal(manager.resumeSession(id, occurredAt++)?.status, 'needs_attention');
    assert.equal(manager.updateTerminalState({ id, status: 'running', occurredAt })?.status, 'running');
  } finally {
    manager.removeSession(id);
  }
});
