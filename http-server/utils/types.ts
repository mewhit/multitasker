import type { SessionStatus } from '../../desktop/sessionManager';
import type { ShellType, LocalShellType } from '../../desktop/settings';
import type { TerminalCaptureState, TerminalEventType } from '../../desktop/terminalEvents';

export function isLocalShellType(value: unknown): value is LocalShellType {
  return value === 'powershell' || value === 'bash';
}

export function isShellType(value: unknown): value is ShellType {
  return isLocalShellType(value) || value === 'ssh';
}

export function isSessionStatus(value: string): value is SessionStatus {
  return (
    value === 'waiting' ||
    value === 'starting' ||
    value === 'running' ||
    value === 'needs_attention' ||
    value === 'paused' ||
    value === 'error' ||
    value === 'stopped' ||
    value === 'detached'
  );
}

export function isTerminalEventType(value: string): value is TerminalEventType {
  return (
    value === 'terminal_opened' ||
    value === 'terminal_attached' ||
    value === 'terminal_capture_state' ||
    value === 'shell_execution_started' ||
    value === 'terminal_output' ||
    value === 'shell_execution_ended' ||
    value === 'terminal_closed' ||
    value === 'terminal_disconnected' ||
    value === 'terminal_visible' ||
    value === 'terminal_interacted'
  );
}

export function isTerminalCaptureState(value: string): value is TerminalCaptureState {
  return value === 'waiting_for_execution' || value === 'capturing' || value === 'unavailable';
}
