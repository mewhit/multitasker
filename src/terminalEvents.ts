import type { SessionStatus, TerminalUpdate } from './sessionManager';

export type TerminalEventType =
  | 'terminal_opened'
  | 'terminal_attached'
  | 'terminal_capture_state'
  | 'shell_execution_started'
  | 'terminal_output'
  | 'shell_execution_ended'
  | 'terminal_closed'
  | 'terminal_disconnected'
  | 'terminal_visible'
  | 'terminal_interacted';

export type TerminalCaptureState = 'waiting_for_execution' | 'capturing' | 'unavailable';

export interface TerminalEvent {
  id: string;
  type: TerminalEventType;
  occurredAt: number;
  terminalRef?: string;
  launchId?: string;
  commandLine?: string;
  executionId?: string;
  output?: string;
  exitCode?: number;
  exitReason?: string;
  terminalName?: string;
  terminalCwd?: string;
  terminalPid?: number;
  shellType?: string;
  hasLaunchCommand?: boolean;
  primary?: boolean;
  windowId?: string;
  captureState?: TerminalCaptureState;
  captureReason?: string;
}

interface TerminalParserState {
  outputTail: string;
  awaitingInput: boolean;
  agentUiDetected: boolean;
  interactiveExecutionIds: Set<string>;
  iconGatedExecutionIds: Set<string>;
}

interface TerminalOutputAnalysis {
  requestsInput: boolean;
  reason: string;
}

const TERMINAL_OUTPUT_TAIL_LENGTH = 4000;
const INTERACTIVE_AGENT_COMMAND_PATTERN = /(^|[\s"'`\\/])(?:copilot(?:-cli)?|claude(?:-code)?|codex|gemini)(?:\.cmd|\.exe)?(?:\s|$)/i;
const ICON_GATED_AGENT_COMMAND_PATTERN = /(^|[\s"'`\\/])(?:copilot(?:-cli)?|codex)(?:\.cmd|\.exe)?(?:\s|$)/i;
const INPUT_REQUEST_PATTERNS = [
  /[❯›]\s*(?:[^\n]*)$/,
  /\b(?:press|hit)\s+(?:enter|return)\b/i,
  /\b(?:type|enter)\s+(?:your\s+)?(?:response|reply|message|prompt|input)\b/i,
  /\b(?:select|choose)\s+(?:an?\s+)?(?:option|action)\b/i,
  /\b(?:continue|proceed|confirm|approve|allow)\?\s*$/i,
  /(?:\(|\[)\s*(?:y\/n|y\/N|Y\/n)\s*(?:\)|\])\s*$/i,
  /\bwaiting for (?:your\s+)?(?:input|response|reply)\b/i,
  /\bneeds? (?:your\s+)?(?:input|attention)\b/i,
];
const RUNNING_OUTPUT_PATTERNS = [
  /(?:^|\n)\s*[◎◉○●]/,
  /\bthinking\b/i,
  /(?:^|\n)\s*working(?:\b|[.])/i,
];
const AGENT_UI_OUTPUT_PATTERNS = [
  /\bgpt-\d+(?:\.\d+)?\b/i,
  /\bcodex\b/i,
  /\bauto-reviewer approved\b/i,
  /\bautomatic approval review\b/i,
  /\b(?:esc|escape)\s+to\s+(?:cancel|interrupt)\b/i,
  /(?:^|\n)\s*\/\s*commands\b/i,
  /(?:^|\n)\s*[•◦]\s+(?:running|ran)\b/iu,
  /\bctrl\+enter\s+enqueue\b/i,
  /(?:^|\n)\s*[❯›]\s+\S/u,
];

export class TerminalEventParser {
  private readonly states = new Map<string, TerminalParserState>();

  toTerminalUpdate(event: TerminalEvent, currentStatus: SessionStatus): TerminalUpdate | null {
    const state = this.getState(event.id);

    switch (event.type) {
      case 'terminal_opened':
        this.resetState(state);
        return this.handleTerminalOpened(event, state);
      case 'terminal_attached':
        this.resetState(state);
        state.awaitingInput = true;
        return this.buildUpdate(event, 'needs_attention', 'attached existing terminal');
      case 'terminal_capture_state':
        return this.handleTerminalCaptureState(event, state);
      case 'shell_execution_started':
        return this.handleShellExecutionStarted(event, state);
      case 'terminal_output':
        return this.handleTerminalOutput(event, state);
      case 'shell_execution_ended':
        return this.handleShellExecutionEnded(event, state);
      case 'terminal_closed':
        this.reset(event.id);
        return this.buildUpdate(
          event,
          event.exitCode !== undefined && event.exitCode !== 0 ? 'error' : 'stopped',
          'terminal closed'
        );
      case 'terminal_disconnected':
        this.reset(event.id);
        return this.buildUpdate(event, 'detached', 'terminal disconnected from vscode');
      case 'terminal_visible':
        return this.handleTerminalActivity(event, state, currentStatus, 'terminal visible to user');
      case 'terminal_interacted':
        return this.handleTerminalActivity(event, state, currentStatus, 'terminal interacted with');
      default:
        return assertNever(event.type);
    }
  }

  reset(id: string): void {
    this.states.delete(id);
  }

  private handleTerminalOpened(event: TerminalEvent, state: TerminalParserState): TerminalUpdate {
    if (!event.hasLaunchCommand) {
      state.awaitingInput = true;
      return this.buildUpdate(event, 'needs_attention', 'no launch command');
    }

    if (isInteractiveAgentCommand(event.commandLine ?? '')) {
      state.awaitingInput = true;
      return this.buildUpdate(event, 'needs_attention', 'interactive agent command launched');
    }

    return this.buildUpdate(event, 'starting', 'non-interactive command launched');
  }

  private handleShellExecutionStarted(event: TerminalEvent, state: TerminalParserState): TerminalUpdate {
    const executionId = event.executionId;
    const commandLine = event.commandLine ?? '';
    if (isInteractiveAgentCommand(commandLine)) {
      if (executionId) state.interactiveExecutionIds.add(executionId);
      if (executionId && isIconGatedAgentCommand(commandLine)) state.iconGatedExecutionIds.add(executionId);
      state.awaitingInput = true;
      return this.buildUpdate(event, 'needs_attention', 'interactive agent shell execution started');
    }

    state.awaitingInput = false;
    return this.buildUpdate(event, 'running', 'non-interactive shell execution started');
  }

  private handleTerminalOutput(event: TerminalEvent, state: TerminalParserState): TerminalUpdate | null {
    if (event.output === undefined || event.output.length === 0) return null;

    const analysis = this.analyzeTerminalOutput(state, event.output, isIconGatedAgentOutput(event, state), event.captureState);
    if (analysis.requestsInput) {
      state.awaitingInput = true;
      return this.buildUpdate(event, 'needs_attention', analysis.reason);
    }

    state.awaitingInput = false;
    return this.buildUpdate(event, 'running', analysis.reason);
  }

  private handleTerminalCaptureState(event: TerminalEvent, state: TerminalParserState): TerminalUpdate | null {
    if (event.captureState === 'capturing') {
      state.awaitingInput = false;
      return this.buildUpdate(event, 'running', 'terminal output capture active');
    }

    if (event.captureState === 'waiting_for_execution') {
      state.awaitingInput = true;
      return this.buildUpdate(event, 'needs_attention', 'terminal waiting for shell execution');
    }

    return null;
  }

  private handleShellExecutionEnded(event: TerminalEvent, state: TerminalParserState): TerminalUpdate {
    if (event.executionId) {
      state.interactiveExecutionIds.delete(event.executionId);
      state.iconGatedExecutionIds.delete(event.executionId);
    }
    state.outputTail = '';
    state.awaitingInput = false;

    if (event.primary) {
      return this.buildUpdate(
        event,
        event.exitCode !== undefined && event.exitCode !== 0 ? 'error' : 'stopped',
        'primary shell execution ended'
      );
    }

    return this.buildUpdate(event, 'running', 'non-primary shell execution ended');
  }

  private handleTerminalActivity(
    event: TerminalEvent,
    state: TerminalParserState,
    currentStatus: SessionStatus,
    reason: string
  ): TerminalUpdate | null {
    if (currentStatus === 'error' || currentStatus === 'stopped' || currentStatus === 'detached') return null;
    if (currentStatus === 'needs_attention' || state.awaitingInput || state.interactiveExecutionIds.size > 0) {
      return null;
    }
    return this.buildUpdate(event, 'running', reason);
  }

  private analyzeTerminalOutput(
    state: TerminalParserState,
    output: string,
    iconGatedAgentOutput: boolean,
    captureState: TerminalCaptureState | undefined
  ): TerminalOutputAnalysis {
    const normalizedOutput = stripTerminalControlSequences(output);
    const tail = appendTerminalOutputTail(state, normalizedOutput);
    const agentUiOutput = iconGatedAgentOutput || state.agentUiDetected || isAgentUiOutput(tail);
    if (agentUiOutput) {
      state.agentUiDetected = true;
      if (hasAgentRunningIndicator(normalizedOutput)) {
        return {
          requestsInput: false,
          reason: 'matched agent running indicator',
        };
      }

      const inputPattern = INPUT_REQUEST_PATTERNS.find(pattern => pattern.test(tail.trimEnd()));
      if (inputPattern) {
        return {
          requestsInput: true,
          reason: `matched input pattern ${inputPattern.toString()}`,
        };
      }

      if (captureState === 'capturing') {
        return {
          requestsInput: false,
          reason: 'terminal output capture active',
        };
      }

      return {
        requestsInput: true,
        reason: 'agent output without running indicator',
      };
    }

    const runningPattern = RUNNING_OUTPUT_PATTERNS.find(pattern => pattern.test(normalizedOutput));
    if (runningPattern) {
      return {
        requestsInput: false,
        reason: `matched running pattern ${runningPattern.toString()}`,
      };
    }

    const trimmedTail = tail.trimEnd();
    const inputPattern = INPUT_REQUEST_PATTERNS.find(pattern => pattern.test(trimmedTail));
    if (inputPattern) {
      return {
        requestsInput: true,
        reason: `matched input pattern ${inputPattern.toString()}`,
      };
    }

    return {
      requestsInput: false,
      reason: 'terminal output without input pattern',
    };
  }

  private buildUpdate(event: TerminalEvent, status: SessionStatus, debugReason: string): TerminalUpdate {
    const update: TerminalUpdate = {
      id: event.id,
      status,
      occurredAt: event.occurredAt,
      debugReason,
    };
    if (event.exitCode !== undefined) update.exitCode = event.exitCode;
    if (event.exitReason !== undefined) update.exitReason = event.exitReason;
    return update;
  }

  private getState(id: string): TerminalParserState {
    const existingState = this.states.get(id);
    if (existingState) return existingState;

    const state: TerminalParserState = {
      outputTail: '',
      awaitingInput: false,
      agentUiDetected: false,
      interactiveExecutionIds: new Set<string>(),
      iconGatedExecutionIds: new Set<string>(),
    };
    this.states.set(id, state);
    return state;
  }

  private resetState(state: TerminalParserState): void {
    state.outputTail = '';
    state.awaitingInput = false;
    state.agentUiDetected = false;
    state.interactiveExecutionIds.clear();
    state.iconGatedExecutionIds.clear();
  }
}

function appendTerminalOutputTail(state: TerminalParserState, output: string): string {
  const nextTail = `${state.outputTail}${output}`.slice(-TERMINAL_OUTPUT_TAIL_LENGTH);
  state.outputTail = nextTail;
  return nextTail;
}

function isInteractiveAgentCommand(commandLine: string): boolean {
  return INTERACTIVE_AGENT_COMMAND_PATTERN.test(normalizeCommandLine(stripTerminalControlSequences(commandLine)));
}

function isIconGatedAgentCommand(commandLine: string): boolean {
  return ICON_GATED_AGENT_COMMAND_PATTERN.test(normalizeCommandLine(stripTerminalControlSequences(commandLine)));
}

function isIconGatedAgentOutput(event: TerminalEvent, state: TerminalParserState): boolean {
  return isIconGatedAgentCommand(event.commandLine ?? '') ||
    Boolean(event.executionId && state.iconGatedExecutionIds.has(event.executionId));
}

function isAgentUiOutput(output: string): boolean {
  return AGENT_UI_OUTPUT_PATTERNS.some(pattern => pattern.test(output));
}

function hasAgentRunningIndicator(output: string): boolean {
  return output.split(/\n/).some(isAgentRunningIndicatorLine);
}

function isAgentRunningIndicatorLine(line: string): boolean {
  const runningIcon = line.match(/(?:^|\s)(?:[│┃]\s*)?([◎◉○●◦•])\s+\S/u);
  if (!runningIcon) return false;

  const icon = runningIcon[1] ?? '';
  if (/^[◦•]$/u.test(icon)) {
    return /\b(?:working|thinking|running|updating|validating|revalidating|testing|building|compiling|installing|searching|reading|writing|editing|reviewing|checking)\b/i.test(line) ||
      /\b(?:esc|escape)\s+to\s+(?:cancel|interrupt)\b/i.test(line);
  }

  return true;
}

function stripTerminalControlSequences(value: string): string {
  return value
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n');
}

function normalizeCommandLine(commandLine: string): string {
  return commandLine.trim().replace(/\s+/g, ' ');
}

function assertNever(value: never): never {
  throw new Error(`Unsupported terminal event type: ${String(value)}`);
}
