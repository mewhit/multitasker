import { TerminalEventParser } from '../desktop/terminalEvents';
import type { SessionStatus } from '../desktop/sessionManager';

const parser = new TerminalEventParser();

function feed(id: string, event: any, currentStatus: SessionStatus) {
  return parser.toTerminalUpdate(event, currentStatus);
}

function assertEq(label: string, got: unknown, expected: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got=${JSON.stringify(got)}  expected=${JSON.stringify(expected)}`);
  if (!ok) process.exitCode = 1;
}

// =====================================================
// Scenario 1: Codex approval menu must NOT be read as "running"
// =====================================================
{
  const id = 'codex-test';
  parser.reset(id);
  // shell_execution_started for codex
  feed(id, {
    id, type: 'shell_execution_started', occurredAt: 1000,
    commandLine: 'codex resume abc', executionId: 'e1', shellType: 'powershell', primary: false,
  }, 'starting');
  // First, normal codex working output (sets agentUiDetected + running indicator)
  feed(id, {
    id, type: 'terminal_output', occurredAt: 1100,
    output: '◉ Working esc cancel                          Claude Opus 4.7', shellType: 'powershell',
  }, 'running');
  // Then the approval menu arrives
  const result = feed(id, {
    id, type: 'terminal_output', occurredAt: 2000,
    output: '•  1. Yes, proceed (y)\n› 2. Yes, and don\'t ask again for commands\n  3. No, and tell Codex what to do differently (esc)',
    shellType: 'powershell',
  }, 'running');
  assertEq('codex approval menu -> needs_attention', result?.status, 'needs_attention');
  console.log(`     reason: ${result?.debugReason}`);
}

// =====================================================
// Scenario 2: Bare prompt repaint after click must NOT demote running
// =====================================================
{
  const id = 'mbt-test';
  parser.reset(id);
  feed(id, {
    id, type: 'shell_execution_started', occurredAt: 1000,
    commandLine: 'copilot', executionId: 'e1', shellType: 'bash', primary: false,
  }, 'starting');
  // Establish "running" via copilot working output
  feed(id, {
    id, type: 'terminal_output', occurredAt: 1100,
    output: '◉ Working                                                                                                                                  GitHub Copilot',
    shellType: 'bash',
  }, 'running');
  // Now simulate a click-triggered repaint: just `❯  `
  const result = feed(id, {
    id, type: 'terminal_output', occurredAt: 2000,
    output: '❯  ', shellType: 'bash',
  }, 'running');
  // Should be ignored (null) -> status stays 'running'
  assertEq('bare prompt repaint -> ignored (null)', result, null);
}

// =====================================================
// Scenario 3: Real input prompt with content should still work
// =====================================================
{
  const id = 'real-prompt-test';
  parser.reset(id);
  feed(id, {
    id, type: 'shell_execution_started', occurredAt: 1000,
    commandLine: 'copilot', executionId: 'e1', shellType: 'bash', primary: false,
  }, 'starting');
  feed(id, {
    id, type: 'terminal_output', occurredAt: 1100,
    output: '◉ Working                                                                                                                                  GitHub Copilot',
    shellType: 'bash',
  }, 'running');
  const result = feed(id, {
    id, type: 'terminal_output', occurredAt: 2000,
    output: 'Press Enter to continue, or type a new message:\n❯ ',
    shellType: 'bash',
  }, 'running');
  // 500ms stabilization may keep running on first transition; check it eventually flips
  const result2 = feed(id, {
    id, type: 'terminal_output', occurredAt: 3000,
    output: 'Press Enter to continue, or type a new message:\n❯ ',
    shellType: 'bash',
  }, result?.status ?? 'running');
  assertEq('real input prompt -> needs_attention (eventually)', result2?.status, 'needs_attention');
  console.log(`     reason: ${result2?.debugReason}`);
}

// =====================================================
// Scenario 4: Codex working spinner stays running
// =====================================================
{
  const id = 'codex-spinner-test';
  parser.reset(id);
  feed(id, {
    id, type: 'shell_execution_started', occurredAt: 1000,
    commandLine: 'codex resume abc', executionId: 'e1', shellType: 'powershell', primary: false,
  }, 'starting');
  const result = feed(id, {
    id, type: 'terminal_output', occurredAt: 1100,
    output: '● Ajouté une 3ème ligne... ◉ Working esc cancel                Claude Opus 4.7',
    shellType: 'powershell',
  }, 'running');
  assertEq('codex spinner -> running', result?.status, 'running');
  console.log(`     reason: ${result?.debugReason}`);
}

// =====================================================
// Scenario 5: Terminal opened without a launch command (e.g. webapp shell)
//   visibility events must NOT promote to `running` while waiting_for_execution.
// =====================================================
{
  const id = 'webapp-test';
  parser.reset(id);
  // Simulate the real webapp sequence: no terminal_opened event, just terminal_visible
  // events arriving with captureState='waiting_for_execution'.
  const result = feed(id, {
    id, type: 'terminal_visible', occurredAt: 1000,
    captureState: 'waiting_for_execution', shellType: 'powershell',
  }, 'needs_attention');
  assertEq('webapp idle terminal visible -> needs_attention', result?.status, 'needs_attention');
  console.log(`     reason: ${result?.debugReason}`);
}

if (process.exitCode) {
  console.log('\nFAIL: some assertions did not match');
} else {
  console.log('\nAll scenarios passed');
}
