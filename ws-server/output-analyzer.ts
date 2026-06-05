// Output analyzer (headless terminal edition).
//
// The previous implementation accumulated PTY chunks into a string buffer
// with crude ANSI stripping, then ran regex against that "tail" to guess
// the agent's status. That approach was fundamentally fragile: the tail
// mixed stale scrollback with live frame content, cursor moves and clears
// were invisible to it, and codex/claude redraws produced false flips
// between 'working' and 'needs_input' depending on how the scrollback
// happened to line up with the regex.
//
// This rewrite drives a headless xterm.js per session. We feed it the same
// bytes the user's terminal receives. It maintains a real 2D screen buffer,
// honoring cursor moves, line clears, alternate screen, etc. Status
// detection then operates on the screen the user actually sees:
//
//   * 'working'      - the screen changed since the last tick (>= some
//                      minimum delta to ignore cursor-blink-only noise) OR
//                      we received a fresh chunk this tick.
//   * 'needs_input'  - screen has been stable for IDLE_TIMEOUT_MS AND the
//                      bottom non-empty line looks like a prompt
//                      (`â€º`/`â¯`, `(y/N)`, `: `, etc).
//   * 'idle'         - screen has been stable for IDLE_TIMEOUT_MS AND no
//                      prompt is visible.
//
// User input/focus signals are treated as context (guards against false
// "working" promotions on redraw/focus noise), not as proof that the agent
// is actively computing.

import { Terminal } from '@xterm/headless';
import { log } from './logger';

export type AgentKind = 'codex' | 'copilot' | 'claude' | 'gemini' | 'generic';
export type AgentStatus = 'working' | 'needs_input' | 'idle';

export interface AgentStatusChange {
  status: AgentStatus;
  agentKind: AgentKind;
  reason: string;
  matchedText?: string;
}

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
// Time the screen must be stable before we leave 'working'.
const IDLE_TIMEOUT_MS = 5000;
// Time after user input during which we never demote to needs_input/idle â€”
// gives the agent a chance to repaint a spinner.
const STDIN_INPUT_GRACE_MS = 4000;
// Minimum interval between two status changes for the same session, to
// avoid flapping when an agent alternates between two near-identical
// frames (e.g. spinner character cycling on/off).
const STATUS_CHANGE_STABILIZATION_MS = 500;
// While output is actively flowing, periodically re-emit `working` even if
// status didn't transition. This keeps downstream state in sync when another
// producer briefly overwrites the UI status to needs_attention.
const WORKING_HEARTBEAT_MS = 1200;
// After focus/typing activity, suppress auto-promotion to "working" for a
// short window so harmless UI redraws don't look like agent execution.
const FOCUS_GUARD_MS = 1500;
const TYPING_GUARD_MS = 1200;
const NO_OUTPUT_NEEDS_INPUT_MS = 30000;
const INTERRUPT_OVERRIDE_RECENT_OUTPUT_MS = 4000;
const FLAP_WINDOW_MS = 30000;
const FLAP_MIN_TRANSITIONS = 5;
const FLAP_HOLD_MS = 15000;
const BOTTOM_SCAN_LINES = 12;

// Regexes evaluated only on the bottom non-empty line(s) of the visible
// screen. Anything below this list is intentionally simple â€” the headless
// terminal already filters out scrollback and overwritten content, so we
// don't need the elaborate tail-distance guards the old implementation had.
const PROMPT_PATTERNS: RegExp[] = [
  /[â¯â€º]\s*(?:$|[^\n]*$)/u,
  /\(y\/N\)\s*$/i,
  /\(Y\/n\)\s*$/i,
  /\by\/n\)\s*$/i,
  /\bpress\s+enter\b/i,
  /\bpress\s+any\s+key\b/i,
  /\bcontinue\?\s*$/i,
  /\bproceed\?\s*$/i,
  /\bconfirm\?\s*$/i,
  /\b(?:do you want to|would you like to)\b/i,
  /\bwaiting for (?:your\s+)?(?:input|response|reply)\b/i,
  /\bneeds? (?:your\s+)?(?:input|attention)\b/i,
  /\bSelect\s+(?:an?\s+)?(?:option|action|choice)\b/i,
  /\b\d+\.\s+Yes\b/i,
  /\bAllow\s+this\s+(?:command|tool|action)\b/i,
  /\bApprove\s+this\s+(?:command|tool|action)\b/i,
  /[?>:]\s*$/,
];

// Patterns that, if visible at the bottom of the screen, OVERRIDE the
// prompt match â€” the agent is actively running.
const RUNNING_OVERRIDE_PATTERNS: RegExp[] = [
  /\b(?:esc|escape)\s+to\s+(?:cancel|interrupt|stop)\b/i,
  /\b(?:ctrl[-+ ]?c|\^c)\s+to\s+(?:cancel|interrupt|stop)\b/i,
  /\b(?:esc|escape)\s+(?:cancel|interrupt|stop)\b/i,
  /\b(?:working|running)\b.*\b(?:esc|escape)\b.*\b(?:cancel|interrupt|stop)\b/i,
];

const INTERACTIVE_AGENT_COMMAND_PATTERN =
  /(^|[\s"'`\\/])(?:copilot(?:-cli)?|claude(?:-code)?|codex|gemini)(?:\.cmd|\.exe)?(?:\s|$)/i;
const AGENT_KIND_COMMAND_PATTERNS: Array<{ kind: AgentKind; pattern: RegExp }> = [
  { kind: 'codex',   pattern: /(^|[\s"'`\\/])codex(?:\.cmd|\.exe)?(?:\s|$)/i },
  { kind: 'copilot', pattern: /(^|[\s"'`\\/])copilot(?:-cli)?(?:\.cmd|\.exe)?(?:\s|$)/i },
  { kind: 'claude',  pattern: /(^|[\s"'`\\/])claude(?:-code)?(?:\.cmd|\.exe)?(?:\s|$)/i },
  { kind: 'gemini',  pattern: /(^|[\s"'`\\/])gemini(?:\.cmd|\.exe)?(?:\s|$)/i },
];

interface SessionState {
  term: Terminal;
  cols: number;
  rows: number;
  agentKind: AgentKind;
  agentUiDetected: boolean;
  lastStatus: AgentStatus | null;
  lastStatusChangeAt: number;
  lastUserInputAt: number;
  /** Screen snapshot at the last tick. Used to detect "screen changed". */
  lastSnapshot: string;
  /** Last time the screen snapshot was observed to change. */
  lastScreenChangeAt: number;
  /** Last time we emitted a working heartbeat while output was flowing. */
  lastWorkingHeartbeatAt: number;
  lastOutputAt: number;
  /** User typing signal from the UI layer. */
  userTyping: boolean;
  lastTypingSignalAt: number;
  /** Terminal focus signal from the UI layer. */
  terminalFocused: boolean;
  lastFocusSignalAt: number;
  workingIdleTransitions: Array<{ status: 'working' | 'idle'; at: number }>;
  flappingUntil: number;
  /** Set when we received chunks since the last tick â€” tick will refresh
   *  lastScreenChangeAt if the screen actually moved. */
  hadChunkSinceTick: boolean;
  /** Bytes received since the last tick, buffered to avoid running the
   *  VT parser on the hotpath. Flushed into `term` at the top of tick(). */
  pendingChunks: string[];
  pendingBytes: number;
}

// Hard cap on buffered bytes per session between ticks. If an agent dumps
// a huge stream (e.g. cat of a binary), we keep only the tail â€” the VT
// parser would catch up to the same final screen state anyway, and we
// avoid unbounded memory growth + a tick-time stall.
const PENDING_BUFFER_TAIL_BYTES = 1 * 1024 * 1024;

function isMeaningfulUserInput(data: string): boolean {
  if (!data) return false;
  // Anything that isn't pure terminal-query reply noise counts. The bridge
  // already filters DA/cursor-pos replies, so basically every byte here is
  // real user input (typed character, Enter, arrow keys, ...).
  return data.length > 0;
}

export class OutputAnalyzer {
  private readonly states = new Map<string, SessionState>();

  /** Hook fed from the WS gateway whenever a client sends user input. */
  onInput(sessionId: string, data: string, now: number = Date.now()): AgentStatusChange | null {
    if (!isMeaningfulUserInput(data)) return null;
    const state = this.getState(sessionId);
    state.lastUserInputAt = now;
    // Input is ambiguous in PTY-based interactive CLIs (user keystrokes can
    // trigger lightweight redraws). Keep it as a context signal only.
    state.lastTypingSignalAt = now;
    return null;
  }

  onUserTyping(sessionId: string, isTyping: boolean, now: number = Date.now()): void {
    const state = this.getState(sessionId);
    state.userTyping = !!isTyping;
    state.lastTypingSignalAt = now;
    if (isTyping) state.lastUserInputAt = now;
  }

  onTerminalFocus(sessionId: string, focused: boolean, now: number = Date.now()): void {
    const state = this.getState(sessionId);
    state.terminalFocused = !!focused;
    state.lastFocusSignalAt = now;
  }

  /** Hint the analyzer about the command being run so it can pre-pin the agent kind. */
  onCommandLine(sessionId: string, commandLine: string | undefined): void {
    if (!commandLine) return;
    const state = this.getState(sessionId);
    const previousKind = state.agentKind;
    const kind = detectAgentKindFromCommand(commandLine);
    if (kind !== 'generic') state.agentKind = kind;
    const interactive = INTERACTIVE_AGENT_COMMAND_PATTERN.test(commandLine);
    if (interactive) state.agentUiDetected = true;
    log.debug('analyzer_command_hint', {
      sessionId,
      commandLine: commandLine.length > 200 ? `${commandLine.slice(0, 200)}â€¦` : commandLine,
      detectedKind: kind,
      pinnedKind: state.agentKind,
      previousKind,
      interactive,
    });
  }

  /**
   * Feed a raw PTY output chunk. Hotpath: we just enqueue the bytes â€” the
   * actual VT parse (`state.term.write`) is deferred to `tick()` so the
   * per-chunk cost is O(1). Why: a single chunk often spans many frames
   * inside xterm-headless, and `tick()` only runs at IDLE_TIMEOUT granularity
   * anyway. Doing the parse per-chunk was costing ~1ms Ã— hundreds of
   * chunks/sec for animated TUIs (codex spinner), saturating the event loop
   * and adding visible input lag â€” especially with two viewers attached.
   *
   * We still flip immediately to 'working' if we weren't already, so the UI
   * stays responsive without touching the VT parser on the hotpath.
   */
  onOutput(sessionId: string, data: string, now: number = Date.now()): AgentStatusChange | null {
    if (!data || data.length === 0) return null;
    const state = this.getState(sessionId);
    state.lastOutputAt = now;
    state.pendingChunks.push(data);
    state.pendingBytes += data.length;
    // Tail-cap: if a session dumps multi-MB between ticks, keep only the
    // most recent ~1MB. The VT screen state after parsing the tail is
    // identical to parsing the whole thing â€” earlier bytes are scrolled out
    // of the visible buffer anyway (scrollback=0).
    while (state.pendingBytes > PENDING_BUFFER_TAIL_BYTES && state.pendingChunks.length > 1) {
      const dropped = state.pendingChunks.shift()!;
      state.pendingBytes -= dropped.length;
    }
    state.hadChunkSinceTick = true;
    if (state.lastStatus !== 'working') {
      const suppressReason = this.getWorkingSuppressionReason(state, now);
      if (suppressReason) return null;
      return this.transition(state, sessionId, 'working', 'output chunk received', now);
    }
    if (now - state.lastWorkingHeartbeatAt >= WORKING_HEARTBEAT_MS) {
      state.lastWorkingHeartbeatAt = now;
      return {
        status: 'working',
        agentKind: state.agentKind,
        reason: 'output chunk received (working heartbeat)',
      };
    }
    return null;
  }

  /** Keep the headless terminal sized in sync with the real PTY. */
  resize(sessionId: string, cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return;
    const state = this.getState(sessionId);
    const c = Math.max(1, Math.floor(cols));
    const r = Math.max(1, Math.floor(rows));
    if (state.cols === c && state.rows === r) return;
    state.term.resize(c, r);
    state.cols = c;
    state.rows = r;
    // Force the next tick to re-evaluate from scratch.
    state.lastSnapshot = '';
  }

  /**
   * Periodic timer hook. For each session: flush buffered chunks into the
   * headless terminal (the only place the VT parser runs now), snapshot the
   * screen, compare with the last snapshot. If changed, refresh
   * lastScreenChangeAt and stay 'working'. If stable for IDLE_TIMEOUT_MS,
   * classify the bottom line as prompt â†’ 'needs_input' or empty â†’ 'idle'.
   *
   * Async because xterm-headless's `write()` is queued; we need to wait for
   * the parser to drain before snapshotting the screen.
   */
  async tick(now: number = Date.now()): Promise<Array<{ sessionId: string; change: AgentStatusChange }>> {
    const out: Array<{ sessionId: string; change: AgentStatusChange }> = [];
    for (const [sessionId, state] of this.states) {
      // Drain the buffered chunks into the VT parser in one shot â€” this is
      // the heavy work, kept off the per-chunk hotpath. Await the write
      // callback so the screen state reflects the bytes before we snapshot.
      if (state.pendingChunks.length > 0) {
        const merged = state.pendingChunks.length === 1
          ? state.pendingChunks[0]!
          : state.pendingChunks.join('');
        state.pendingChunks = [];
        state.pendingBytes = 0;
        await new Promise<void>((resolve) => state.term.write(merged, () => resolve()));
      }
      const snapshot = snapshotVisible(state.term);
      const screenChanged = snapshot !== state.lastSnapshot;
      if (screenChanged) {
        state.lastSnapshot = snapshot;
        state.lastScreenChangeAt = now;
      }
      state.hadChunkSinceTick = false;

      // Stabilization: don't flap within STATUS_CHANGE_STABILIZATION_MS.
      const sinceChange = state.lastStatusChangeAt > 0 ? now - state.lastStatusChangeAt : Infinity;
      if (sinceChange < STATUS_CHANGE_STABILIZATION_MS) continue;

      // Input grace: just after the user typed, never report not-working.
      const sinceInput = state.lastUserInputAt > 0 ? now - state.lastUserInputAt : Infinity;
      const inInputGrace = sinceInput < STDIN_INPUT_GRACE_MS;

      if (screenChanged) {
        if (state.lastStatus !== 'working') {
          const suppressReason = this.getWorkingSuppressionReason(state, now);
          if (suppressReason) continue;
          const change = this.transition(state, sessionId, 'working', 'screen changed', now);
          if (change) out.push({ sessionId, change });
        }
        continue;
      }

      const stableFor = now - state.lastScreenChangeAt;
      if (stableFor < IDLE_TIMEOUT_MS) continue;
      if (inInputGrace) continue;

      const sinceOutput = state.lastOutputAt > 0 ? now - state.lastOutputAt : Infinity;
      if (
        state.lastStatus !== 'needs_input' &&
        sinceOutput >= NO_OUTPUT_NEEDS_INPUT_MS
      ) {
        const change = this.transition(
          state,
          sessionId,
          'needs_input',
          `no shell output for ${sinceOutput}ms`,
          now,
        );
        if (change) out.push({ sessionId, change });
        continue;
      }

      const bottomLines = bottomNonEmptyLines(state.term, BOTTOM_SCAN_LINES);
      const bottomBlock = bottomLines.join('\n');
      const overrideMatch = bottomLines.length
        ? RUNNING_OVERRIDE_PATTERNS.find(p => p.test(bottomBlock))
        : undefined;
      if (overrideMatch) {
        const sinceOutput = state.lastOutputAt > 0 ? now - state.lastOutputAt : Infinity;
        if (sinceOutput > INTERRUPT_OVERRIDE_RECENT_OUTPUT_MS) {
          // Static footer text like "esc to cancel" can stay visible even when
          // the agent is not emitting output. Don't force working unless output
          // was seen recently.
          continue;
        }
        // The screen happens to look stable but the agent is showing an
        // active "esc to interrupt" footer. Treat as working and refresh
        // the change timestamp so we don't keep re-evaluating.
        state.lastScreenChangeAt = now;
        if (state.lastStatus !== 'working') {
          const change = this.transition(state, sessionId, 'working', 'interrupt affordance visible', now);
          if (change) out.push({ sessionId, change });
        }
        continue;
      }

      // Walk the bottom lines from the very last upward and look for the
      // first prompt match. Agents like codex keep a permanent footer line
      // (e.g. "  gpt-5.5 xhigh Â· C:\dev\robot") below their input prompt
      // (`â€º Implement ...`), so the "bottommost" line is almost never the
      // prompt â€” it's the footer. Scanning a small window of recent lines
      // is what a human does visually to locate the prompt.
      let matchedLine: string | undefined;
      let promptMatch: RegExp | undefined;
      for (let i = bottomLines.length - 1; i >= 0; i--) {
        const line = bottomLines[i];
        if (!line) continue;
        const m = PROMPT_PATTERNS.find(p => p.test(line));
        if (m) {
          matchedLine = line;
          promptMatch = m;
          break;
        }
      }

      const proposed: AgentStatus = promptMatch ? 'needs_input' : 'idle';
      if (state.lastStatus === proposed) continue;

      const reason = promptMatch
        ? `screen stable for ${stableFor}ms; prompt visible in bottom block`
        : `screen stable for ${stableFor}ms; no prompt visible`;
      const change = this.transition(
        state,
        sessionId,
        proposed,
        reason,
        now,
        matchedLine ?? bottomLines[bottomLines.length - 1] ?? undefined,
      );
      if (change) out.push({ sessionId, change });
    }
    return out;
  }

  reset(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state) return;
    try { state.term.dispose(); } catch { /* ignore */ }
    this.states.delete(sessionId);
  }

  private transition(
    state: SessionState,
    sessionId: string,
    status: AgentStatus,
    reason: string,
    now: number,
    matchedText?: string,
  ): AgentStatusChange | null {
    const previousStatus = state.lastStatus;
    let nextStatus: AgentStatus = status;
    let nextReason = reason;
    if (this.isWorkingIdleFlapping(state, status, now)) {
      nextStatus = 'needs_input';
      nextReason = `working/idle loop detected; ${reason}`;
      state.flappingUntil = Math.max(state.flappingUntil, now + FLAP_HOLD_MS);
    }
    if (state.lastStatus === nextStatus) return null;
    state.lastStatus = nextStatus;
    state.lastStatusChangeAt = now;
    if (nextStatus === 'working') state.lastWorkingHeartbeatAt = now;
    if (nextStatus === 'working' || nextStatus === 'idle') {
      state.workingIdleTransitions.push({ status: nextStatus, at: now });
      state.workingIdleTransitions = state.workingIdleTransitions.filter((entry) => now - entry.at <= FLAP_WINDOW_MS);
    } else if (nextStatus === 'needs_input') {
      state.workingIdleTransitions = [];
    }
    const change: AgentStatusChange = {
      status: nextStatus,
      agentKind: state.agentKind,
      reason: nextReason,
    };
    if (matchedText) change.matchedText = matchedText;
    log.info('agent_status_transition', {
      sessionId,
      agentKind: state.agentKind,
      fromStatus: previousStatus,
      toStatus: nextStatus,
      reason: nextReason,
      matchedText,
    });
    return change;
  }

  private isWorkingIdleFlapping(state: SessionState, proposed: AgentStatus, now: number): boolean {
    if (proposed !== 'working' && proposed !== 'idle') return false;
    if (state.lastStatus !== 'working' && state.lastStatus !== 'idle') return false;
    if (state.lastStatus === proposed) return false;
    const recent = state.workingIdleTransitions.filter((entry) => now - entry.at <= FLAP_WINDOW_MS);
    const series: Array<'working' | 'idle'> = [...recent.map((entry) => entry.status), proposed];
    if (series.length < FLAP_MIN_TRANSITIONS) return false;
    let alternatingRun = 1;
    for (let i = series.length - 2; i >= 0; i--) {
      if (series[i] === series[i + 1]) break;
      alternatingRun++;
    }
    return alternatingRun >= FLAP_MIN_TRANSITIONS;
  }

  private getWorkingSuppressionReason(state: SessionState, now: number): string | null {
    if (state.flappingUntil > now) return 'working_idle_flapping_hold';
    if (state.userTyping) return 'user_typing_active';
    if (state.lastTypingSignalAt > 0 && now - state.lastTypingSignalAt < TYPING_GUARD_MS) {
      return 'recent_user_typing';
    }
    if (state.terminalFocused && state.lastFocusSignalAt > 0 && now - state.lastFocusSignalAt < FOCUS_GUARD_MS) {
      return 'recent_terminal_focus';
    }
    return null;
  }

  private getState(sessionId: string): SessionState {
    const existing = this.states.get(sessionId);
    if (existing) return existing;
    const term = new Terminal({
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      scrollback: 0,
      allowProposedApi: true,
    });
    const state: SessionState = {
      term,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      agentKind: 'generic',
      agentUiDetected: false,
      lastStatus: null,
      lastStatusChangeAt: 0,
      lastUserInputAt: 0,
      lastSnapshot: '',
      lastScreenChangeAt: 0,
      lastWorkingHeartbeatAt: 0,
      lastOutputAt: 0,
      userTyping: false,
      lastTypingSignalAt: 0,
      terminalFocused: false,
      lastFocusSignalAt: 0,
      workingIdleTransitions: [],
      flappingUntil: 0,
      hadChunkSinceTick: false,
      pendingChunks: [],
      pendingBytes: 0,
    };
    this.states.set(sessionId, state);
    return state;
  }
}

/**
 * Serialize the currently visible rows (active buffer, from baseY to
 * baseY+rows-1) into a single newline-separated string with trailing
 * whitespace trimmed per line. This is the "what the user sees" view used
 * to detect screen activity.
 */
function snapshotVisible(term: Terminal): string {
  const buf = term.buffer.active;
  const startY = buf.baseY;
  const endY = startY + term.rows;
  const lines: string[] = [];
  for (let y = startY; y < endY; y++) {
    const line = buf.getLine(y);
    if (!line) {
      lines.push('');
      continue;
    }
    lines.push(line.translateToString(true));
  }
  return lines.join('\n');
}

function bottomNonEmptyLines(term: Terminal, max: number): string[] {
  const buf = term.buffer.active;
  const startY = buf.baseY;
  const endY = startY + term.rows;
  const out: string[] = [];
  for (let y = endY - 1; y >= startY && out.length < max; y--) {
    const line = buf.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);
    if (text.length === 0) continue;
    out.unshift(text);
  }
  return out;
}

function detectAgentKindFromCommand(commandLine: string): AgentKind {
  for (const { kind, pattern } of AGENT_KIND_COMMAND_PATTERNS) {
    if (pattern.test(commandLine)) return kind;
  }
  return 'generic';
}

export function debugLogAgentStatus(sessionId: string, change: AgentStatusChange): void {
  log.info('agent_status', {
    sessionId,
    source: 'shell_push',
    status: change.status,
    agentKind: change.agentKind,
    reason: change.reason,
    matched: change.matchedText?.slice(0, 120),
  });
}
