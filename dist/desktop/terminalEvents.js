"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TerminalEventParser = void 0;
const TERMINAL_OUTPUT_TAIL_LENGTH = 4000;
const AGENT_RUNNING_GRACE_PERIOD_MS = 5000;
const STATUS_CHANGE_STABILIZATION_MS = 500;
const BASH_SMALL_OUTPUT_BUFFER_MS = 100;
const BASH_SMALL_OUTPUT_THRESHOLD = 50;
/**
 * When a terminal emits a tiny output (e.g. just `"❯  "`) after a focus/click event,
 * VS Code is repainting the prompt line in isolation. We must not let that demote a
 * `running` status to `needs_attention` — there's no real new signal there.
 */
const SHORT_REPAINT_MAX_LENGTH = 8;
const SHORT_REPAINT_PATTERN = /^[\s❯›▸▶•·]*$/u;
const INTERACTIVE_AGENT_COMMAND_PATTERN = /(^|[\s"'`\\/])(?:copilot(?:-cli)?|claude(?:-code)?|codex|gemini)(?:\.cmd|\.exe)?(?:\s|$)/i;
const ICON_GATED_AGENT_COMMAND_PATTERN = /(^|[\s"'`\\/])(?:copilot(?:-cli)?|codex)(?:\.cmd|\.exe)?(?:\s|$)/i;
const AGENT_KIND_COMMAND_PATTERNS = [
    { kind: 'codex', pattern: /(^|[\s"'`\\/])codex(?:\.cmd|\.exe)?(?:\s|$)/i },
    { kind: 'copilot', pattern: /(^|[\s"'`\\/])copilot(?:-cli)?(?:\.cmd|\.exe)?(?:\s|$)/i },
    { kind: 'claude', pattern: /(^|[\s"'`\\/])claude(?:-code)?(?:\.cmd|\.exe)?(?:\s|$)/i },
    { kind: 'gemini', pattern: /(^|[\s"'`\\/])gemini(?:\.cmd|\.exe)?(?:\s|$)/i },
];
const AGENT_PROFILES = {
    codex: {
        uiDetection: [
            /\bcodex\b/i,
            /\besc\s+cancel\b/i,
            /(?:^|\n)\s*\/\s*commands\b/,
            /\bgpt-\d+(?:\.\d+)?\b/i,
            /\bClaude\s+Opus\b/i,
            /\bauto-reviewer approved\b/i,
        ],
        runningIndicators: [
            // codex spinner cycle: requires a spinner glyph followed by "Working" on the same line
            /[◎◉○●•]\s*Working\b/u,
            /\bWorking\b[^\n]*\besc\s+cancel\b/i,
        ],
        inputRequests: [
            // Numbered approval menu: "1. Yes, proceed (y)" etc.
            /\b\d+\.\s+Yes,\s+proceed\b/i,
            /\b\d+\.\s+Yes,\s+and don'?t ask again\b/i,
            /\b\d+\.\s+No,\s+and tell Codex\b/i,
            /\bWould you like to run\b/i,
            /\bApprove(?:d)? codex to\b/i,
            /\bDo you want to (?:allow|approve)\b/i,
        ],
    },
    copilot: {
        uiDetection: [
            /\bcopilot\b/i,
            /\bctrl\+enter\s+enqueue\b/i,
            /\bGitHub Copilot\b/i,
        ],
        runningIndicators: [
            /[◎◉○●•]\s*Working\b/u,
            /\bthinking\b/i,
            /(?:^|\n)\s*working(?:\b|[.])/i,
        ],
        inputRequests: [
            /\b(?:Allow|Approve)\s+this\s+(?:command|tool|action)\b/i,
            /\bPress\s+Enter\s+to\s+continue\b/i,
            /\(y\/N\)\s*$/,
            /(?:^|\n)\s*>\s+Yes\b/,
        ],
    },
    claude: {
        uiDetection: [
            /\bclaude(?:-code)?\b/i,
            /\bAnthropic\b/i,
        ],
        runningIndicators: [
            /[◎◉○●•]\s*(?:Working|Thinking)\b/u,
            /\bthinking\b/i,
        ],
        inputRequests: [
            /\bDo you want to proceed\b/i,
            /\b\d+\.\s+Yes\b/i,
        ],
    },
    gemini: {
        uiDetection: [
            /\bgemini\b/i,
        ],
        runningIndicators: [
            /[◎◉○●•]\s*Working\b/u,
            /\bthinking\b/i,
        ],
        inputRequests: [
            /\(y\/N\)\s*$/,
        ],
    },
    generic: {
        uiDetection: [
            /\bauto-reviewer approved\b/i,
            /\bautomatic approval review\b/i,
            /\b(?:esc|escape)\s+to\s+(?:cancel|interrupt)\b/i,
            /(?:^|\n)\s*\/\s*commands\b/,
            /(?:^|\n)\s*[•◦]\s+(?:running|ran)\b/iu,
            /(?:^|\n)\s*[❯›]\s+\S/u,
        ],
        runningIndicators: [
            /(?:^|\n)\s*[◎◉○●]/,
            /\bthinking\b/i,
            /(?:^|\n)\s*working(?:\b|[.])/i,
        ],
        inputRequests: [],
    },
};
// Generic fallback prompt patterns, used when no agent-specific input was matched.
const GENERIC_INPUT_REQUEST_PATTERNS = [
    /[❯›]\s*(?:[^\n]*)$/,
    /\b(?:press|hit)\s+(?:enter|return)\b/i,
    /\b(?:type|enter)\s+(?:your\s+)?(?:response|reply|message|prompt|input)\b/i,
    /\b(?:select|choose)\s+(?:an?\s+)?(?:option|action)\b/i,
    /\b(?:continue|proceed|confirm|approve|allow)\?\s*$/i,
    /(?:\(|\[)\s*(?:y\/n|y\/N|Y\/n)\s*(?:\)|\])\s*$/i,
    /\bwaiting for (?:your\s+)?(?:input|response|reply)\b/i,
    /\bneeds? (?:your\s+)?(?:input|attention)\b/i,
];
class TerminalEventParser {
    states = new Map();
    toTerminalUpdate(event, currentStatus) {
        const state = this.getState(event.id);
        if (event.shellType)
            state.shellType = event.shellType;
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
                return this.handleTerminalOutput(event, state, currentStatus);
            case 'shell_execution_ended':
                return this.handleShellExecutionEnded(event, state);
            case 'terminal_closed':
                this.reset(event.id);
                return this.buildUpdate(event, event.exitCode !== undefined && event.exitCode !== 0 ? 'error' : 'stopped', 'terminal closed');
            case 'terminal_disconnected':
                this.reset(event.id);
                return this.buildUpdate(event, 'detached', 'terminal disconnected');
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
            state.agentKind = detectAgentKindFromCommand(commandLine);
            state.awaitingInput = true;
            return this.buildUpdate(event, 'needs_attention', 'interactive agent shell execution started');
        }
        state.agentKind = 'generic';
        state.awaitingInput = false;
        return this.buildUpdate(event, 'running', 'non-interactive shell execution started');
    }
    handleTerminalOutput(event, state, currentStatus) {
        if (event.output === undefined || event.output.length === 0)
            return null;
        // Repaint guard: after a click/focus, VS Code may emit a tiny output containing only
        // prompt glyphs (e.g. "❯  "). That's a screen repaint, not new agent activity, so we
        // must not let it demote a `running` session to `needs_attention`.
        if (state.lastStatus === 'running' &&
            event.output.length <= SHORT_REPAINT_MAX_LENGTH &&
            !event.output.includes('\n') &&
            SHORT_REPAINT_PATTERN.test(stripTerminalControlSequences(event.output))) {
            // Still feed the tail so subsequent analysis sees a coherent buffer, but don't change status.
            appendTerminalOutputTail(state, stripTerminalControlSequences(event.output));
            return null;
        }
        // For Bash, buffer small outputs to reduce flickering from spinner animations
        const isBash = state.shellType === 'bash';
        const isSmallOutput = event.output.length < BASH_SMALL_OUTPUT_THRESHOLD;
        let outputToAnalyze = event.output;
        if (isBash && isSmallOutput) {
            state.bufferedOutput += event.output;
            const timeSinceLastSmallOutput = state.lastSmallOutputAt > 0 ? event.occurredAt - state.lastSmallOutputAt : Infinity;
            // If we haven't accumulated enough or enough time hasn't passed, wait for more
            if (state.bufferedOutput.length < BASH_SMALL_OUTPUT_THRESHOLD * 2 && timeSinceLastSmallOutput < BASH_SMALL_OUTPUT_BUFFER_MS) {
                state.lastSmallOutputAt = event.occurredAt;
                return null; // Don't process yet, wait for accumulation
            }
            // Process the buffered output now
            outputToAnalyze = state.bufferedOutput;
            state.bufferedOutput = '';
            state.lastSmallOutputAt = 0;
        }
        const analysis = this.analyzeTerminalOutput(state, outputToAnalyze, isIconGatedAgentOutput(event, state), currentStatus, event.occurredAt);
        const proposedStatus = analysis.requestsInput ? 'needs_attention' : 'running';
        // Stabilization: avoid status flapping - only change if enough time has passed or status is stable
        const timeSinceLastChange = state.lastStatusChangeAt > 0 ? event.occurredAt - state.lastStatusChangeAt : Infinity;
        if (state.lastStatus && state.lastStatus !== proposedStatus && timeSinceLastChange < STATUS_CHANGE_STABILIZATION_MS) {
            // Keep previous status to avoid flapping
            return this.buildUpdate(event, state.lastStatus, `${analysis.reason} (stabilized)`, analysis.matchedText);
        }
        if (analysis.requestsInput) {
            state.awaitingInput = true;
            state.lastStatus = 'needs_attention';
            state.lastStatusChangeAt = event.occurredAt;
            return this.buildUpdate(event, 'needs_attention', analysis.reason, analysis.matchedText);
        }
        state.awaitingInput = false;
        state.lastStatus = 'running';
        state.lastStatusChangeAt = event.occurredAt;
        return this.buildUpdate(event, 'running', analysis.reason, analysis.matchedText);
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
        // If the terminal has no active shell execution (e.g. opened without a launch command,
        // or the previous command already ended), a visibility/interaction event must not
        // promote the session to `running` — nothing is actually running.
        if (event.captureState === 'waiting_for_execution') {
            state.awaitingInput = true;
            return this.buildUpdate(event, 'needs_attention', `${reason} (terminal waiting for shell execution)`);
        }
        if (state.awaitingInput || state.interactiveExecutionIds.size > 0) {
            return this.buildUpdate(event, 'needs_attention', reason);
        }
        return this.buildUpdate(event, 'running', reason);
    }
    analyzeTerminalOutput(state, output, iconGatedAgentOutput, currentStatus, occurredAt) {
        const normalizedOutput = stripTerminalControlSequences(output);
        const tail = appendTerminalOutputTail(state, normalizedOutput);
        const agentUiOutput = iconGatedAgentOutput ||
            state.agentUiDetected ||
            detectAgentUi(tail, state.agentKind) !== null;
        if (agentUiOutput) {
            state.agentUiDetected = true;
            // If we haven't yet pinned an agent kind (e.g. attached to a running session),
            // sniff it from the output.
            if (state.agentKind === 'generic') {
                const sniffed = detectAgentUi(tail, 'generic');
                if (sniffed)
                    state.agentKind = sniffed;
            }
            const profile = AGENT_PROFILES[state.agentKind] ?? AGENT_PROFILES.generic;
            // 1. Explicit input requests for this agent take priority over spinner glyphs.
            //    (Codex `• 1. Yes, proceed` would otherwise be misread as a spinner.)
            const inputMatch = profile.inputRequests.find(pattern => pattern.test(tail));
            if (inputMatch) {
                return {
                    requestsInput: true,
                    reason: `matched ${state.agentKind} input pattern ${inputMatch.toString()}`,
                    matchedText: getMatchingLine(tail, inputMatch) || tail.trimEnd().split(/\n/).slice(-1)[0] || '',
                };
            }
            // 2. Agent-specific running indicators (e.g. `◉ Working esc cancel`).
            const runningMatch = profile.runningIndicators.find(pattern => pattern.test(normalizedOutput));
            if (runningMatch) {
                state.lastAgentRunningIndicatorAt = occurredAt;
                return {
                    requestsInput: false,
                    reason: `matched ${state.agentKind} running indicator`,
                    matchedText: getMatchingLine(normalizedOutput, runningMatch),
                };
            }
            // 3. Fallback: legacy generic spinner line detection (covers older indicator shapes).
            const runningIndicatorLine = getAgentRunningIndicatorLine(normalizedOutput);
            if (runningIndicatorLine) {
                state.lastAgentRunningIndicatorAt = occurredAt;
                return {
                    requestsInput: false,
                    reason: 'matched agent running indicator',
                    matchedText: runningIndicatorLine,
                };
            }
            // 4. Generic input patterns (prompt arrows, "press enter", etc.).
            const trimmedTail = tail.trimEnd();
            const genericInput = GENERIC_INPUT_REQUEST_PATTERNS.find(pattern => pattern.test(trimmedTail));
            if (genericInput) {
                return {
                    requestsInput: true,
                    reason: `matched input pattern ${genericInput.toString()}`,
                    matchedText: trimmedTail.split(/\n/).slice(-1)[0] ?? '',
                };
            }
            // 5. Grace period: agent was running recently, no new signal — assume still running.
            if (currentStatus === 'running' && isWithinAgentRunningGracePeriod(state, occurredAt)) {
                return {
                    requestsInput: false,
                    reason: `agent output without running indicator within ${AGENT_RUNNING_GRACE_PERIOD_MS}ms grace period`,
                };
            }
            return {
                requestsInput: true,
                reason: 'agent output without running indicator',
            };
        }
        const genericProfile = AGENT_PROFILES.generic;
        const runningPattern = genericProfile.runningIndicators.find(pattern => pattern.test(normalizedOutput));
        if (runningPattern) {
            return {
                requestsInput: false,
                reason: `matched running pattern ${runningPattern.toString()}`,
                matchedText: getMatchingLine(normalizedOutput, runningPattern),
            };
        }
        const trimmedTail = tail.trimEnd();
        const inputPattern = GENERIC_INPUT_REQUEST_PATTERNS.find(pattern => pattern.test(trimmedTail));
        if (inputPattern) {
            return {
                requestsInput: true,
                reason: `matched input pattern ${inputPattern.toString()}`,
                matchedText: trimmedTail.split(/\n/).slice(-1)[0] ?? '',
            };
        }
        return {
            requestsInput: false,
            reason: 'terminal output without input pattern',
        };
    }
    buildUpdate(event, status, debugReason, debugMatchedText) {
        const update = {
            id: event.id,
            status,
            occurredAt: event.occurredAt,
            debugReason,
        };
        const trimmedMatchedText = debugMatchedText?.trim();
        if (trimmedMatchedText)
            update.debugMatchedText = trimmedMatchedText.slice(0, 500);
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
            agentKind: 'generic',
            lastAgentRunningIndicatorAt: 0,
            lastStatusChangeAt: 0,
            lastStatus: null,
            interactiveExecutionIds: new Set(),
            iconGatedExecutionIds: new Set(),
            lastSmallOutputAt: 0,
            bufferedOutput: '',
        };
        this.states.set(id, state);
        return state;
    }
    resetState(state) {
        state.outputTail = '';
        state.awaitingInput = false;
        state.agentUiDetected = false;
        state.agentKind = 'generic';
        state.lastAgentRunningIndicatorAt = 0;
        state.lastStatusChangeAt = 0;
        state.lastStatus = null;
        state.interactiveExecutionIds.clear();
        state.iconGatedExecutionIds.clear();
        state.lastSmallOutputAt = 0;
        state.bufferedOutput = '';
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
function detectAgentKindFromCommand(commandLine) {
    const normalized = normalizeCommandLine(stripTerminalControlSequences(commandLine));
    for (const { kind, pattern } of AGENT_KIND_COMMAND_PATTERNS) {
        if (pattern.test(normalized))
            return kind;
    }
    return 'generic';
}
/**
 * Detect which agent UI (if any) the output belongs to.
 * If `preferredKind` is provided and matches, returns it; otherwise scans all profiles.
 */
function detectAgentUi(output, preferredKind) {
    if (preferredKind !== 'generic') {
        const profile = AGENT_PROFILES[preferredKind];
        if (profile.uiDetection.some(pattern => pattern.test(output)))
            return preferredKind;
    }
    for (const kind of ['codex', 'copilot', 'claude', 'gemini']) {
        if (kind === preferredKind)
            continue;
        if (AGENT_PROFILES[kind].uiDetection.some(pattern => pattern.test(output)))
            return kind;
    }
    if (AGENT_PROFILES.generic.uiDetection.some(pattern => pattern.test(output)))
        return 'generic';
    return null;
}
function getAgentRunningIndicatorLine(output) {
    return output.split(/\n/).find(isAgentRunningIndicatorLine)?.trim() ?? '';
}
function isAgentRunningIndicatorLine(line) {
    return /(?:^|\s)(?:[│┃]\s*)?[◎◉○●◦•](?:\s+\S|\S|$)/u.test(line);
}
function getMatchingLine(output, pattern) {
    return output.split(/\n/).find(line => pattern.test(line))?.trim() ?? '';
}
function isWithinAgentRunningGracePeriod(state, occurredAt) {
    if (state.lastAgentRunningIndicatorAt <= 0)
        return false;
    return occurredAt - state.lastAgentRunningIndicatorAt < AGENT_RUNNING_GRACE_PERIOD_MS;
}
function stripTerminalControlSequences(value) {
    return value
        .replace(/\r/g, '\n') // Convert carriage returns to newlines FIRST (before stripping control chars)
        .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '') // OSC sequences
        .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '') // CSI sequences
        .replace(/\x1B[PX^_].*?\x1B\\/g, '') // Other escape sequences
        .replace(/[\x00-\x1F\x7F-\x9F]/g, ''); // Remove non-printable characters (but not newlines)
}
function normalizeCommandLine(commandLine) {
    return commandLine.trim().replace(/\s+/g, ' ');
}
function assertNever(value) {
    throw new Error(`Unsupported terminal event type: ${String(value)}`);
}
