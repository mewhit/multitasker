import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { TerminalUpdate, SessionStatus } from '../../../desktop/sessionManager';
import type { TerminalEvent, TerminalCaptureState } from '../../../desktop/terminalEvents';
import type { TerminalBinding } from '../../types';
import { sessionManager, pendingTerminalUpdates, pendingTerminalEvents, removedSessionIds, taskIdByTerminalRef } from '../../state/sessions';
import { terminalDebugLogFileBySessionId, reportedDebugLogWriteFailures } from '../../state/debug';
import { saveSessions } from '../../../desktop/settings';
import { MAX_PENDING_TERMINAL_EVENTS_PER_SESSION, DEBUG_LOG_DIRECTORY, DEBUG_LOG_FILE_EXTENSION, isTerminalUpdateDebugEnabled } from '../../core/constants';
import { getErrorMessage, formatDebugValue } from '../../core/util';
import { getSessionsStateToSave } from '../sessions/parse';

export function handleTerminalUpdate(update: TerminalUpdate): void {
  if (removedSessionIds.has(update.id)) {
    debugTerminalUpdate('terminal update ignored for removed session', terminalUpdateDebugDetails(update));
    return;
  }
  if (applyTerminalUpdate(update)) return;
  debugTerminalUpdate('terminal update queued for missing session', terminalUpdateDebugDetails(update));
  pendingTerminalUpdates.set(update.id, update);
}

export function handleTerminalEvent(event: TerminalEvent): void {
  if (removedSessionIds.has(event.id)) {
    debugTerminalUpdate('terminal event ignored for removed session', terminalEventDebugDetails(event, event.terminalName));
    return;
  }
  debugTerminalUpdate('terminal event received', terminalEventDebugDetails(event, getTerminalEventSessionName(event)));
  if (applyTerminalEvent(event)) return;
  debugTerminalUpdate('terminal event queued for missing session', terminalEventDebugDetails(event, getTerminalEventSessionName(event)));
  queuePendingTerminalEvent(event);
}

export function applyTerminalUpdate(update: TerminalUpdate): boolean {
  const previousSession = sessionManager.getSession(update.id);
  const session = sessionManager.updateTerminalState(update);
  if (!session) {
    debugTerminalUpdate('terminal update could not be applied', terminalUpdateDebugDetails(update));
    return false;
  }
  debugTerminalUpdate('terminal update applied', {
    ...terminalUpdateDebugDetails(update),
    previousStatus: previousSession?.status,
    nextStatus: session.status,
  });
  saveSessionsAfterTerminalStatusChange(previousSession?.status, session.status);
  return true;
}

export function applyTerminalEvent(event: TerminalEvent): boolean {
  const previousSession = sessionManager.getSession(event.id);
  const sessionName = previousSession?.name ?? event.terminalName;
  const result = sessionManager.updateTerminalEventWithDetails(event);
  if (!result) {
    debugTerminalUpdate('terminal event could not be applied', terminalEventDebugDetails(event, sessionName));
    return false;
  }
  const { session, statusUpdate } = result;
  debugTerminalUpdate('terminal event applied', {
    ...terminalEventDebugDetails(event, session.name),
    ...terminalEventStatusDebugDetails(statusUpdate),
    previousStatus: previousSession?.status,
    nextStatus: session.status,
  });
  saveSessionsAfterTerminalStatusChange(previousSession?.status, session.status);
  return true;
}

function saveSessionsAfterTerminalStatusChange(previousStatus: SessionStatus | undefined, nextStatus: SessionStatus): void {
  if (
    nextStatus === 'error' ||
    nextStatus === 'stopped' ||
    nextStatus === 'detached' ||
    previousStatus === 'error' ||
    previousStatus === 'stopped' ||
    previousStatus === 'detached'
  ) {
    saveSessions(getSessionsStateToSave());
  }
}

function queuePendingTerminalEvent(event: TerminalEvent): void {
  const events = pendingTerminalEvents.get(event.id) ?? [];
  events.push(event);
  if (events.length > MAX_PENDING_TERMINAL_EVENTS_PER_SESSION) events.shift();
  pendingTerminalEvents.set(event.id, events);
}

export function flushPendingTerminalUpdates(id?: string): void {
  if (id) {
    const update = pendingTerminalUpdates.get(id);
    if (!update || !applyTerminalUpdate(update)) return;
    pendingTerminalUpdates.delete(id);
    return;
  }
  for (const sessionId of [...pendingTerminalUpdates.keys()]) flushPendingTerminalUpdates(sessionId);
}

export function flushPendingTerminalEvents(id?: string): void {
  if (id) {
    const events = pendingTerminalEvents.get(id);
    if (!events) return;
    const remainingEvents: TerminalEvent[] = [];
    for (const event of events) {
      if (!applyTerminalEvent(event)) remainingEvents.push(event);
    }
    if (remainingEvents.length === 0) {
      pendingTerminalEvents.delete(id);
    } else {
      pendingTerminalEvents.set(id, remainingEvents);
    }
    return;
  }
  for (const sessionId of [...pendingTerminalEvents.keys()]) flushPendingTerminalEvents(sessionId);
}

export function markSessionRemoved(id: string): void {
  removedSessionIds.add(id);
  pendingTerminalUpdates.delete(id);
  pendingTerminalEvents.delete(id);
}

export function forgetRemovedSession(id: string): void {
  removedSessionIds.delete(id);
}

export function rememberTaskTerminalBinding(
  taskId: string,
  binding: {
    terminalRef?: string | undefined;
    terminalPid?: number | undefined;
    captureState?: TerminalCaptureState | undefined;
    captureReason?: string | undefined;
  }
): void {
  const previousTerminalRef = sessionManager.getSession(taskId)?.terminalRef?.trim();
  const terminalRef = binding.terminalRef?.trim();
  if (previousTerminalRef && terminalRef && previousTerminalRef !== terminalRef) taskIdByTerminalRef.delete(previousTerminalRef);
  if (terminalRef) taskIdByTerminalRef.set(terminalRef, taskId);
  sessionManager.bindSessionToTerminal(taskId, buildTerminalBinding({
    terminalRef,
    terminalPid: binding.terminalPid,
    terminalCaptureState: binding.captureState,
    terminalCaptureReason: binding.captureReason,
  }));
}

export function buildTerminalBinding(binding: {
  terminalRef?: string | undefined;
  terminalPid?: number | undefined;
  terminalCaptureState?: TerminalCaptureState | undefined;
  terminalCaptureReason?: string | undefined;
}): TerminalBinding {
  const terminalBinding: TerminalBinding = {};
  const terminalRef = binding.terminalRef?.trim();
  if (terminalRef) terminalBinding.terminalRef = terminalRef;
  if (binding.terminalPid !== undefined) terminalBinding.terminalPid = binding.terminalPid;
  if (binding.terminalCaptureState) terminalBinding.terminalCaptureState = binding.terminalCaptureState;
  const terminalCaptureReason = binding.terminalCaptureReason?.trim();
  if (terminalCaptureReason) terminalBinding.terminalCaptureReason = terminalCaptureReason;
  return terminalBinding;
}

export function debugTerminalUpdate(message: string, details: Record<string, unknown> = {}): void {
  if (!isTerminalUpdateDebugEnabled()) return;
  const serializedDetails = Object.entries(details)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatDebugValue(value)}`)
    .join(' ');
  const line = `[multitasker backend terminal ${new Date().toISOString()}] ${message}${
    serializedDetails ? ` ${serializedDetails}` : ''
  }`;
  appendTerminalDebugLog(line, details);
  console.info(line);
}

function appendTerminalDebugLog(line: string, details: Record<string, unknown>): void {
  const sessionId = getDebugLogSessionId(details);
  if (!sessionId) return;
  const filePath = getTerminalDebugLogFilePath(sessionId, details);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${line}\n`, 'utf8');
  } catch (error) {
    reportDebugLogWriteFailure(`Could not write backend terminal debug log "${filePath}": ${getErrorMessage(error)}`);
  }
}

function getTerminalDebugLogFilePath(sessionId: string, details: Record<string, unknown>): string {
  const existingFilePath = terminalDebugLogFileBySessionId.get(sessionId);
  if (existingFilePath) return existingFilePath;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const sessionName = getDebugLogSessionName(sessionId, details);
  const fileName = [
    timestamp,
    sanitizeDebugLogFilePart(sessionName, 'unknown-session', 80),
    sanitizeDebugLogFilePart(sessionId, 'unknown-id', 140),
  ].join('-');
  const filePath = path.join(process.cwd(), DEBUG_LOG_DIRECTORY, `${fileName}${DEBUG_LOG_FILE_EXTENSION}`);
  terminalDebugLogFileBySessionId.set(sessionId, filePath);
  return filePath;
}

function getDebugLogSessionId(details: Record<string, unknown>): string | undefined {
  const value = details['id'];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getDebugLogSessionName(sessionId: string, details: Record<string, unknown>): string {
  const detailSessionName = details['sessionName'];
  if (typeof detailSessionName === 'string' && detailSessionName.trim()) return detailSessionName.trim();
  const session = sessionManager.getSession(sessionId);
  if (session?.name.trim()) return session.name.trim();
  const terminalName = details['terminalName'];
  if (typeof terminalName === 'string' && terminalName.trim()) return terminalName.trim();
  return 'unknown-session';
}

function sanitizeDebugLogFilePart(value: string, fallback: string, maxLength: number): string {
  const sanitized = value
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const safeValue = sanitized || fallback;
  if (safeValue.length <= maxLength) return safeValue;
  const hash = createHash('sha256').update(safeValue).digest('hex').slice(0, 8);
  return `${safeValue.slice(0, maxLength - hash.length - 1)}-${hash}`;
}

function reportDebugLogWriteFailure(message: string): void {
  if (reportedDebugLogWriteFailures.has(message)) return;
  reportedDebugLogWriteFailures.add(message);
  console.warn(message);
}

export function terminalUpdateDebugDetails(update: TerminalUpdate): Record<string, unknown> {
  return {
    id: update.id,
    status: update.status,
    occurredAt: update.occurredAt,
    exitCode: update.exitCode,
    exitReason: update.exitReason,
    reason: update.debugReason,
    matchedText: update.debugMatchedText,
  };
}

function terminalEventStatusDebugDetails(update: TerminalUpdate | undefined): Record<string, unknown> {
  if (!update) {
    return {
      statusUpdate: false,
      statusReason: 'terminal event did not produce a status update',
    };
  }
  return {
    statusUpdate: true,
    computedStatus: update.status,
    statusReason: update.debugReason,
    statusExitCode: update.exitCode,
    statusExitReason: update.exitReason,
  };
}

export function terminalEventDebugDetails(event: TerminalEvent, sessionName?: string): Record<string, unknown> {
  return {
    id: event.id,
    sessionName,
    type: event.type,
    occurredAt: event.occurredAt,
    terminalRef: event.terminalRef,
    launchId: event.launchId,
    commandLine: event.commandLine,
    executionId: event.executionId,
    exitCode: event.exitCode,
    exitReason: event.exitReason,
    terminalName: event.terminalName,
    terminalCwd: event.terminalCwd,
    terminalPid: event.terminalPid,
    shellType: event.shellType,
    hasLaunchCommand: event.hasLaunchCommand,
    primary: event.primary,
    captureState: event.captureState,
    captureReason: event.captureReason,
    output: event.output === undefined ? undefined : terminalOutputDebugValue(event.output),
  };
}

export function getTerminalEventSessionName(event: TerminalEvent): string | undefined {
  return sessionManager.getSession(event.id)?.name ?? event.terminalName;
}

function terminalOutputDebugValue(output: string): string {
  return output
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}
