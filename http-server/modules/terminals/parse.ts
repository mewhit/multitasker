import type { TerminalUpdate } from '../../../desktop/sessionManager';
import type { TerminalEvent } from '../../../desktop/terminalEvents';
import type { TerminalEventIdentity } from '../../types';
import { sessionManager, taskIdByTerminalRef, pendingLaunchTaskIdByLaunchId } from '../../state/sessions';
import { readStringField, readOptionalNumberField, readOptionalBooleanField } from '../../utils/payload';
import { isShellType, isSessionStatus, isTerminalEventType, isTerminalCaptureState } from '../../utils/types';
import { normalizePathForCompare, getLegacyAttachedTerminalPid } from '../../utils/path';
import { rememberTaskTerminalBinding } from './apply';

export function parseTerminalUpdateRequest(payload: unknown): TerminalUpdate | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const id = readStringField(record, 'id').trim();
  const rawStatus = readStringField(record, 'status').trim();
  const occurredAt = readOptionalNumberField(record, 'occurredAt') ?? Date.now();
  if (!id || !isSessionStatus(rawStatus)) return null;

  const update: TerminalUpdate = { id, status: rawStatus, occurredAt };
  const exitCode = readOptionalNumberField(record, 'exitCode');
  if (exitCode !== undefined) update.exitCode = exitCode;
  const exitReason = readStringField(record, 'exitReason').trim();
  if (exitReason) update.exitReason = exitReason;
  const debugReason = readStringField(record, 'debugReason').trim();
  if (debugReason) update.debugReason = debugReason.slice(0, 500);
  return update;
}

export function parseTerminalEventRequest(payload: unknown): TerminalEvent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const explicitTaskId = readStringField(record, 'taskId').trim() || readStringField(record, 'id').trim();
  const rawType = readStringField(record, 'type').trim();
  const occurredAt = readOptionalNumberField(record, 'occurredAt') ?? Date.now();
  if (!isTerminalEventType(rawType)) return null;

  const terminalRef = readStringField(record, 'terminalRef').trim();
  const launchId = readStringField(record, 'launchId').trim();
  const terminalPid = readOptionalNumberField(record, 'terminalPid');
  const terminalName = readStringField(record, 'terminalName').trim();
  const terminalCwd = readStringField(record, 'terminalCwd').trim();
  const rawShellType = readStringField(record, 'shellType').trim();
  const shellType = isShellType(rawShellType) ? rawShellType : undefined;
  const id = resolveTerminalEventTaskId({
    explicitTaskId,
    terminalRef,
    launchId,
    terminalPid,
    terminalName,
    terminalCwd,
  });
  if (!id) return null;

  const event: TerminalEvent = { id, type: rawType, occurredAt };
  if (terminalRef) event.terminalRef = terminalRef;
  if (launchId) event.launchId = launchId;
  if (terminalPid !== undefined) event.terminalPid = terminalPid;
  if (terminalName) event.terminalName = terminalName;
  if (terminalCwd) event.terminalCwd = terminalCwd;
  if (shellType) event.shellType = shellType;
  const commandLine = readStringField(record, 'commandLine');
  if (commandLine) event.commandLine = commandLine;
  const executionId = readStringField(record, 'executionId').trim();
  if (executionId) event.executionId = executionId;
  const output = readStringField(record, 'output');
  if (output) event.output = output;
  const exitCode = readOptionalNumberField(record, 'exitCode');
  if (exitCode !== undefined) event.exitCode = exitCode;
  const exitReason = readStringField(record, 'exitReason').trim();
  if (exitReason) event.exitReason = exitReason;
  const hasLaunchCommand = readOptionalBooleanField(record, 'hasLaunchCommand');
  if (hasLaunchCommand !== undefined) event.hasLaunchCommand = hasLaunchCommand;
  const primary = readOptionalBooleanField(record, 'primary');
  if (primary !== undefined) event.primary = primary;
  const rawCaptureState = readStringField(record, 'captureState').trim();
  if (rawCaptureState && isTerminalCaptureState(rawCaptureState)) event.captureState = rawCaptureState;
  const captureReason = readStringField(record, 'captureReason').trim();
  if (captureReason) event.captureReason = captureReason.slice(0, 500);
  rememberTaskTerminalBinding(id, {
    terminalRef,
    terminalPid,
    captureState: event.captureState,
    captureReason: event.captureReason,
  });
  return event;
}

export function isTerminalEventRelayPayload(payload: unknown): payload is Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null) return false;
  const rawType = readStringField(payload as Record<string, unknown>, 'type').trim();
  return isTerminalEventType(rawType);
}

export function resolveTerminalEventTaskId(identity: TerminalEventIdentity): string {
  if (identity.launchId) {
    const launchTaskId = pendingLaunchTaskIdByLaunchId.get(identity.launchId);
    if (launchTaskId) return launchTaskId;
  }
  if (identity.terminalRef) {
    const terminalTaskId = taskIdByTerminalRef.get(identity.terminalRef);
    if (terminalTaskId) return terminalTaskId;
  }
  if (identity.explicitTaskId) return identity.explicitTaskId;
  return findSessionForTerminalIdentity(identity)?.id ?? '';
}

export function findSessionForTerminalIdentity(identity: TerminalEventIdentity): import('../../../desktop/sessionManager').Session | null {
  const sessions = sessionManager.getSessions();
  const exactRef = identity.terminalRef
    ? sessions.find(session => session.terminalRef === identity.terminalRef)
    : undefined;
  if (exactRef) return exactRef;
  const exactPid = identity.terminalPid !== undefined
    ? sessions.find(session => (session.terminalPid ?? getLegacyAttachedTerminalPid(session.id)) === identity.terminalPid)
    : undefined;
  if (exactPid) return exactPid;
  const normalizedTerminalPath = normalizePathForCompare(identity.terminalCwd);
  if (!normalizedTerminalPath) return null;
  return sessions.find(session =>
    !session.terminalRef?.trim() &&
    normalizePathForCompare(session.cwd) === normalizedTerminalPath
  ) ?? null;
}
