import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OutputAnalyzer } from './output-analyzer.ts';

const dialog = [
  'Locate commit with the code',
  'git fetch origin --quiet',
  'Do you want to run this command?',
  '> 1. Yes',
  "  2. Yes, and don't ask again for git fetch in this repo",
  '  3. No, and tell Copilot what to do differently (Esc to stop)',
  'up/down to navigate - enter to select - esc to cancel',
].join('\r\n');
const frame = text => '\x1b[2J\x1b[H' + text;

test('Copilot approval overrides changing output and input grace, then resumes after dismissal', async () => {
  const analyzer = new OutputAnalyzer();
  try {
    analyzer.onCommandLine('s', 'copilot');
    assert.equal(analyzer.onOutput('s', 'Working...', 1000)?.status, 'working');
    await analyzer.tick(1600);
    analyzer.onInput('s', '\r', 2000);
    analyzer.onOutput('s', frame(dialog), 2100);
    const changes = await analyzer.tick(2200);
    assert.equal(changes[0]?.change.status, 'needs_input');
    assert.equal(changes[0]?.change.reason, 'approval dialog awaiting selection');

    analyzer.onInput('s', '\x1b[B', 3000);
    assert.equal(analyzer.onOutput('s', frame(dialog.replace('> 1.', '  1.').replace('  2.', '> 2.')), 3100), null);
    assert.deepEqual(await analyzer.tick(4500), []);
    assert.equal(analyzer.onOutput('s', '\x1b[?25l', 5000), null);
    assert.deepEqual(await analyzer.tick(5100), []);

    analyzer.onOutput('s', frame('Fetching origin...'), 6000);
    assert.equal((await analyzer.tick(6100))[0]?.change.status, 'working');
  } finally {
    analyzer.reset('s');
  }
});

test('a question in ordinary output does not override active work', async () => {
  const analyzer = new OutputAnalyzer();
  try {
    analyzer.onOutput('s', 'Working...', 1000);
    await analyzer.tick(1600);
    analyzer.onOutput('s', frame('Do you want to run this command?\r\nWorking (esc to cancel)'), 2000);
    assert.deepEqual(await analyzer.tick(2200), []);
    assert.equal(analyzer.onOutput('s', ' Still working...', 3500)?.status, 'working');
  } finally {
    analyzer.reset('s');
  }
});
