import {
  loadSessions,
  loadManualTasks,
  loadRecurringTasks,
  loadSlackNotifications,
} from '../../../desktop/settings';
import { sessionManager, taskIdByTerminalRef } from '../../state/sessions';
import { manualTasks, recurringTasks, slackNotifications } from '../../state/tasks';
import { MAX_MANUAL_TASKS, MAX_RECURRING_TASKS, MAX_SLACK_NOTIFICATIONS } from '../../core/constants';
import { isShellType } from '../../utils/types';
import { flushPendingTerminalUpdates, flushPendingTerminalEvents } from '../terminals/apply';

export function restorePersistedState(): void {
  const settings = require('../../../desktop/settings').loadSettings();
  for (const sessionState of loadSessions()) {
    const shellType = isShellType(String(sessionState.shellType)) ? sessionState.shellType : settings.defaultShell;
    sessionManager.createSession(
      sessionState.name,
      sessionState.cmd,
      sessionState.cwd,
      shellType,
      sessionState.id ?? '',
      sessionState.sshCommand ?? '',
      sessionState.vscodeWindowId ?? '',
      sessionState.terminalRef ?? '',
      sessionState.terminalPid
    );
  }
  for (const session of sessionManager.getSessions()) {
    if (session.terminalRef) taskIdByTerminalRef.set(session.terminalRef, session.id);
  }
  manualTasks.push(...loadManualTasks().slice(0, MAX_MANUAL_TASKS));
  recurringTasks.push(...loadRecurringTasks().slice(0, MAX_RECURRING_TASKS));
  slackNotifications.push(...loadSlackNotifications().slice(0, MAX_SLACK_NOTIFICATIONS));
  flushPendingTerminalUpdates();
  flushPendingTerminalEvents();
}
