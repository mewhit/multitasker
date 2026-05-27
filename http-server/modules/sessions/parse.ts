import path from 'node:path';
import type { SessionState } from '../../../desktop/settings';
import type { MultitaskerCreateSessionRequest } from '../../types';
import { sessionManager, taskIdByTerminalRef, pendingLaunchTaskIdByLaunchId } from '../../state/sessions';
import { readStringField, readOptionalNumberField } from '../../utils/payload';
import { isShellType } from '../../utils/types';

export function parseCreateSessionRequest(payload: unknown): MultitaskerCreateSessionRequest | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const rawId = readStringField(record, 'id').trim() || readStringField(record, 'taskId').trim();
  const cwd = readStringField(record, 'cwd').trim();
  const rawShellType = readStringField(record, 'shellType').trim();
  const shellType = isShellType(rawShellType) ? rawShellType : 'powershell';
  const sshCommand = (readStringField(record, 'sshCommand') || readStringField(record, 'sshHost')).trim();
  const cmd = (readStringField(record, 'command') || readStringField(record, 'cmd')).trim();
  const name = readStringField(record, 'name').trim() || path.basename(cwd) || sshCommand || 'Session';
  const vscodeWindowId = readStringField(record, 'windowId').trim();
  const terminalRef = readStringField(record, 'terminalRef').trim();
  const terminalName = readStringField(record, 'terminalName').trim();
  const launchId = readStringField(record, 'launchId').trim();
  const terminalPid = readOptionalNumberField(record, 'terminalPid');
  const id = rawId ||
    (launchId ? pendingLaunchTaskIdByLaunchId.get(launchId) ?? '' : '') ||
    (terminalRef ? taskIdByTerminalRef.get(terminalRef) ?? '' : '');

  if (shellType === 'ssh') {
    if (!sshCommand) return null;
  } else if (!cwd) {
    return null;
  }

  const request: MultitaskerCreateSessionRequest = { name, cmd, cwd, shellType };
  if (id) request.id = id;
  if (sshCommand) request.sshCommand = sshCommand;
  if (vscodeWindowId) request.vscodeWindowId = vscodeWindowId;
  if (terminalRef) request.terminalRef = terminalRef;
  if (terminalPid !== undefined) request.terminalPid = terminalPid;
  if (terminalName) request.terminalName = terminalName;
  if (launchId) request.launchId = launchId;
  return request;
}

export function getSessionsStateToSave(): SessionState[] {
  return sessionManager.getSessions()
    .filter(session => session.status !== 'error' && session.status !== 'stopped' && session.status !== 'detached')
    .map(session => ({
      id: session.id,
      name: session.name,
      cmd: session.cmd,
      cwd: session.cwd,
      shellType: session.shellType,
      ...(session.sshCommand ? { sshCommand: session.sshCommand } : {}),
      ...(session.vscodeWindowId ? { vscodeWindowId: session.vscodeWindowId } : {}),
      ...(session.terminalRef ? { terminalRef: session.terminalRef } : {}),
      ...(session.terminalPid !== undefined ? { terminalPid: session.terminalPid } : {}),
    }));
}
