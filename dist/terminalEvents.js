"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TerminalEventParser = void 0;
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
class TerminalEventParser {
    states = new Map();
    toTerminalUpdate(event, currentStatus) {
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
                return this.buildUpdate(event, event.exitCode !== undefined && event.exitCode !== 0 ? 'error' : 'stopped', 'terminal closed');
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
    reset(id) {
        this.states.delete(id);
    }
    handleTerminalOpened(event, state) {
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
    handleShellExecutionStarted(event, state) {
        const executionId = event.executionId;
        const commandLine = event.commandLine ?? '';
        if (isInteractiveAgentCommand(commandLine)) {
            if (executionId)
                state.interactiveExecutionIds.add(executionId);
            if (executionId && isIconGatedAgentCommand(commandLine))
                state.iconGatedExecutionIds.add(executionId);
            state.awaitingInput = true;
            return this.buildUpdate(event, 'needs_attention', 'interactive agent shell execution started');
        }
        state.awaitingInput = false;
        return this.buildUpdate(event, 'running', 'non-interactive shell execution started');
    }
    handleTerminalOutput(event, state) {
        if (event.output === undefined || event.output.length === 0)
            return null;
        const analysis = this.analyzeTerminalOutput(state, event.output, isIconGatedAgentOutput(event, state), event.captureState);
        if (analysis.requestsInput) {
            state.awaitingInput = true;
            return this.buildUpdate(event, 'needs_attention', analysis.reason);
        }
        state.awaitingInput = false;
        return this.buildUpdate(event, 'running', analysis.reason);
    }
    handleTerminalCaptureState(event, state) {
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
    handleShellExecutionEnded(event, state) {
        if (event.executionId) {
            state.interactiveExecutionIds.delete(event.executionId);
            state.iconGatedExecutionIds.delete(event.executionId);
        }
        state.outputTail = '';
        state.awaitingInput = false;
        if (event.primary) {
            return this.buildUpdate(event, event.exitCode !== undefined && event.exitCode !== 0 ? 'error' : 'stopped', 'primary shell execution ended');
        }
        return this.buildUpdate(event, 'running', 'non-primary shell execution ended');
    }
    handleTerminalActivity(event, state, currentStatus, reason) {
        if (currentStatus === 'error' || currentStatus === 'stopped' || currentStatus === 'detached')
            return null;
        if (currentStatus === 'needs_attention' || state.awaitingInput || state.interactiveExecutionIds.size > 0) {
            return null;
        }
        return this.buildUpdate(event, 'running', reason);
    }
    analyzeTerminalOutput(state, output, iconGatedAgentOutput, captureState) {
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
    buildUpdate(event, status, debugReason) {
        const update = {
            id: event.id,
            status,
            occurredAt: event.occurredAt,
            debugReason,
        };
        if (event.exitCode !== undefined)
            update.exitCode = event.exitCode;
        if (event.exitReason !== undefined)
            update.exitReason = event.exitReason;
        return update;
    }
    getState(id) {
        const existingState = this.states.get(id);
        if (existingState)
            return existingState;
        const state = {
            outputTail: '',
            awaitingInput: false,
            agentUiDetected: false,
            interactiveExecutionIds: new Set(),
            iconGatedExecutionIds: new Set(),
        };
        this.states.set(id, state);
        return state;
    }
    resetState(state) {
        state.outputTail = '';
        state.awaitingInput = false;
        state.agentUiDetected = false;
        state.interactiveExecutionIds.clear();
        state.iconGatedExecutionIds.clear();
    }
}
exports.TerminalEventParser = TerminalEventParser;
function appendTerminalOutputTail(state, output) {
    const nextTail = `${state.outputTail}${output}`.slice(-TERMINAL_OUTPUT_TAIL_LENGTH);
    state.outputTail = nextTail;
    return nextTail;
}
function isInteractiveAgentCommand(commandLine) {
    return INTERACTIVE_AGENT_COMMAND_PATTERN.test(normalizeCommandLine(stripTerminalControlSequences(commandLine)));
}
function isIconGatedAgentCommand(commandLine) {
    return ICON_GATED_AGENT_COMMAND_PATTERN.test(normalizeCommandLine(stripTerminalControlSequences(commandLine)));
}
function isIconGatedAgentOutput(event, state) {
    return isIconGatedAgentCommand(event.commandLine ?? '') ||
        Boolean(event.executionId && state.iconGatedExecutionIds.has(event.executionId));
}
function isAgentUiOutput(output) {
    return AGENT_UI_OUTPUT_PATTERNS.some(pattern => pattern.test(output));
}
function hasAgentRunningIndicator(output) {
    return output.split(/\n/).some(isAgentRunningIndicatorLine);
}
function isAgentRunningIndicatorLine(line) {
    const runningIcon = line.match(/(?:^|\s)(?:[│┃]\s*)?([◎◉○●◦•])\s+\S/u);
    if (!runningIcon)
        return false;
    const icon = runningIcon[1] ?? '';
    if (/^[◦•]$/u.test(icon)) {
        return /\b(?:working|thinking|running|updating|validating|revalidating|testing|building|compiling|installing|searching|reading|writing|editing|reviewing|checking)\b/i.test(line) ||
            /\b(?:esc|escape)\s+to\s+(?:cancel|interrupt)\b/i.test(line);
    }
    return true;
}
function stripTerminalControlSequences(value) {
    return value
        .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
        .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(/\r/g, '\n');
}
function normalizeCommandLine(commandLine) {
    return commandLine.trim().replace(/\s+/g, ' ');
}
function assertNever(value) {
    throw new Error(`Unsupported terminal event type: ${String(value)}`);
}
