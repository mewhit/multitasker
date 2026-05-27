import type { VsCodeWindowRegistration, VsCodeWindowEntry, VsCodeTerminalRegistration, VsCodeSessionTerminalMatch } from '../../types';
import type { Session } from '../../../desktop/sessionManager';
import { vscodeWindowsById } from '../../state/vscode';
import { sessionManager, taskIdByTerminalRef } from '../../state/sessions';
import { saveSessions } from '../../../desktop/settings';
import { readStringArrayField, readOptionalNumberField, readStringField } from '../../utils/payload';
import { isShellType, isTerminalCaptureState } from '../../utils/types';
import { normalizePathForCompare, getLegacyAttachedTerminalPid } from '../../utils/path';
import { getSessionsStateToSave } from '../sessions/parse';
import { debugTerminalUpdate, buildTerminalBinding } from '../terminals/apply';
import { broadcastVsCodeWindowsUpdate } from './broadcast';

export function rememberVsCodeWindow(registration: VsCodeWindowRegistration): void {
  const existingEntry = vscodeWindowsById.get(registration.windowId);
  const entry: VsCodeWindowEntry = {
    windowId: registration.windowId,
    lastSeenAt: Date.now(),
  };
  const workspaceFolder = registration.workspaceFolder ?? existingEntry?.workspaceFolder;
  if (workspaceFolder) entry.workspaceFolder = workspaceFolder;
  const workspaceName = registration.workspaceName ?? existingEntry?.workspaceName;
  if (workspaceName) entry.workspaceName = workspaceName;
  const pid = registration.pid ?? existingEntry?.pid;
  if (pid !== undefined) entry.pid = pid;
  if (registration.terminals !== undefined) {
    entry.terminals = registration.terminals;
  } else if (existingEntry?.terminals !== undefined) {
    entry.terminals = existingEntry.terminals;
  }
  if (registration.sessionIds !== undefined) {
    entry.sessionIds = registration.sessionIds;
  } else if (existingEntry?.sessionIds !== undefined) {
    entry.sessionIds = existingEntry.sessionIds;
  }

  vscodeWindowsById.set(registration.windowId, entry);
  bindSessionsToVsCodeTerminals(entry);
  bindSessionsToVsCodeWindow(registration);
  broadcastVsCodeWindowsUpdate();
}

export function bindSessionsToVsCodeTerminals(registration: VsCodeWindowEntry): void {
  const terminals = registration.terminals ?? [];
  if (terminals.length === 0) return;

  let didBindSession = false;
  const boundSessionIds = new Set<string>();
  const bindTerminal = (session: Session, terminal: VsCodeTerminalRegistration, matchReason: string): void => {
    if (boundSessionIds.has(session.id)) return;
    const previousTerminalRef = session.terminalRef;
    const reboundSession = sessionManager.bindSessionToTerminal(session.id, buildTerminalBinding({
      vscodeWindowId: registration.windowId,
      terminalRef: terminal.terminalRef,
      terminalPid: terminal.terminalPid,
      terminalCaptureState: terminal.captureState,
      terminalCaptureReason: terminal.captureReason,
    }));
    if (!reboundSession) return;
    if (previousTerminalRef && previousTerminalRef !== terminal.terminalRef) taskIdByTerminalRef.delete(previousTerminalRef);
    taskIdByTerminalRef.set(terminal.terminalRef, reboundSession.id);
    boundSessionIds.add(reboundSession.id);
    if (previousTerminalRef !== terminal.terminalRef || session.status === 'detached') {
      didBindSession = true;
      debugTerminalUpdate('session rebound to vscode terminal', {
        id: reboundSession.id,
        sessionName: reboundSession.name,
        vscodeWindowId: registration.windowId,
        terminalRef: terminal.terminalRef,
        terminalPid: terminal.terminalPid,
        terminalName: terminal.terminalName,
        terminalCwd: terminal.terminalCwd,
        matchReason,
      });
    }
  };

  for (const terminal of terminals) {
    const session = findKnownSessionForTerminalRef(terminal.terminalRef);
    if (session) bindTerminal(session, terminal, 'known terminalRef');
  }
  for (const terminal of terminals) {
    if (taskIdByTerminalRef.has(terminal.terminalRef)) continue;
    const match = findSessionForTerminalRegistration(registration, terminal, boundSessionIds);
    if (match) bindTerminal(match.session, terminal, match.reason);
  }
  if (didBindSession) saveSessions(getSessionsStateToSave());
}

export function findKnownSessionForTerminalRef(terminalRef: string): Session | null {
  const mappedTaskId = taskIdByTerminalRef.get(terminalRef);
  if (mappedTaskId) return sessionManager.getSession(mappedTaskId);
  return sessionManager.getSessions().find(session => session.terminalRef === terminalRef) ?? null;
}

export function findSessionForTerminalRegistration(
  registration: VsCodeWindowEntry,
  terminal: VsCodeTerminalRegistration,
  excludedSessionIds: ReadonlySet<string>
): VsCodeSessionTerminalMatch | null {
  const sessions = sessionManager.getSessions().filter(session => !excludedSessionIds.has(session.id));
  const exactRef = sessions.find(session => session.terminalRef === terminal.terminalRef);
  if (exactRef) return { session: exactRef, reason: 'exact terminalRef' };
  if (terminal.terminalPid !== undefined) {
    const exactPid = sessions.find(session =>
      (session.terminalPid ?? getLegacyAttachedTerminalPid(session.id)) === terminal.terminalPid
    );
    if (exactPid) return { session: exactPid, reason: 'exact terminalPid' };
  }

  const terminalPath = normalizePathForCompare(terminal.terminalCwd ?? '');
  if (!terminalPath) return null;
  const matchingTerminals = (registration.terminals ?? [])
    .filter(candidate => normalizePathForCompare(candidate.terminalCwd ?? '') === terminalPath);
  if (matchingTerminals.length > 1) return null;

  const matchingSessions = sessions.filter(session =>
    !session.terminalRef?.trim() &&
    (!session.vscodeWindowId || session.vscodeWindowId === registration.windowId) &&
    normalizePathForCompare(session.cwd) === terminalPath
  );
  if (matchingSessions.length > 1) return null;
  const matchingSession = matchingSessions[0];
  return matchingSession ? { session: matchingSession, reason: 'unique cwd fallback' } : null;
}

export function bindSessionsToVsCodeWindow(registration: VsCodeWindowRegistration): void {
  if (!registration.sessionIds || registration.sessionIds.length === 0) return;
  let didBindSession = false;
  for (const sessionId of registration.sessionIds) {
    const previousSession = sessionManager.getSession(sessionId);
    const reboundSession = sessionManager.bindSessionToVsCodeWindow(sessionId, registration.windowId);
    if (!previousSession || !reboundSession || previousSession.vscodeWindowId === reboundSession.vscodeWindowId) continue;
    didBindSession = true;
  }
  if (didBindSession) saveSessions(getSessionsStateToSave());
}

export function parseVsCodeWindowRegistration(payload: unknown): VsCodeWindowRegistration | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const windowId = readStringField(record, 'windowId').trim();
  if (!windowId) return null;

  const registration: VsCodeWindowRegistration = { windowId };
  const workspaceFolder = readStringField(record, 'workspaceFolder').trim();
  if (workspaceFolder) registration.workspaceFolder = workspaceFolder;
  const workspaceName = readStringField(record, 'workspaceName').trim();
  if (workspaceName) registration.workspaceName = workspaceName;
  const pid = readOptionalNumberField(record, 'pid');
  if (pid !== undefined) registration.pid = pid;
  if (Array.isArray(record['terminals'])) {
    registration.terminals = record['terminals']
      .map(parseVsCodeTerminalRegistration)
      .filter((terminal): terminal is VsCodeTerminalRegistration => terminal !== null);
  }
  if (Array.isArray(record['sessionIds'])) registration.sessionIds = readStringArrayField(record, 'sessionIds');
  return registration;
}

export function parseVsCodeTerminalRegistration(payload: unknown): VsCodeTerminalRegistration | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const terminalRef = readStringField(record, 'terminalRef').trim();
  if (!terminalRef) return null;

  const terminal: VsCodeTerminalRegistration = { terminalRef };
  const terminalName = readStringField(record, 'terminalName').trim();
  if (terminalName) terminal.terminalName = terminalName;
  const terminalCwd = readStringField(record, 'terminalCwd').trim();
  if (terminalCwd) terminal.terminalCwd = terminalCwd;
  const rawShellType = readStringField(record, 'shellType').trim();
  if (isShellType(rawShellType)) terminal.shellType = rawShellType;
  const terminalPid = readOptionalNumberField(record, 'terminalPid');
  if (terminalPid !== undefined) terminal.terminalPid = terminalPid;
  const isActive = readOptionalBooleanField(record, 'isActive');
  if (isActive !== undefined) terminal.isActive = isActive;
  const rawCaptureState = readStringField(record, 'captureState').trim();
  if (isTerminalCaptureState(rawCaptureState)) terminal.captureState = rawCaptureState;
  const captureReason = readStringField(record, 'captureReason').trim();
  if (captureReason) terminal.captureReason = captureReason;
  return terminal;
}

function readOptionalBooleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}
