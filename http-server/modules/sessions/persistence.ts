import {
  loadSessions,
  loadManualTasks,
  loadRecurringTasks,
  loadSlackNotifications,
  loadGoogleCalendarEvents,
} from '../../../shared/settings';
import { sessionManager, taskIdByTerminalRef, multitaskerSessionIdByShellSessionId } from '../../state/sessions';
import { googleCalendarEvents, manualTasks, recurringTasks, slackNotifications } from '../../state/tasks';
import { MAX_GOOGLE_CALENDAR_EVENTS, MAX_MANUAL_TASKS, MAX_RECURRING_TASKS, MAX_SLACK_NOTIFICATIONS } from '../../core/constants';
import { isShellType } from '../../utils/types';
import { flushPendingTerminalUpdates, flushPendingTerminalEvents } from '../terminals/apply';

export function restorePersistedState(): void {
  const settings = require('../../../shared/settings').loadSettings();
  for (const sessionState of loadSessions()) {
    const shellType = isShellType(String(sessionState.shellType)) ? sessionState.shellType : settings.defaultShell;
    sessionManager.createSession(
      sessionState.name,
      sessionState.cmd,
      sessionState.cwd,
      shellType,
      sessionState.id ?? '',
      sessionState.sshCommand ?? '',
      sessionState.terminalRef ?? '',
      sessionState.terminalPid,
      sessionState.sshOptions
    );
    if (sessionState.clientMetadata && sessionState.id) {
      sessionManager.setClientMetadata(sessionState.id, sessionState.clientMetadata);
    }
  }
  for (const session of sessionManager.getSessions()) {
    if (session.terminalRef) taskIdByTerminalRef.set(session.terminalRef, session.id);
    // Pre-seed the shell→multitasker id map for restored sessions so that
    // /api/shell/agent-status updates from the gateway resolve immediately
    // (they're conflated by design — see createSession with requestedId).
    multitaskerSessionIdByShellSessionId.set(session.id, session.id);
  }
  manualTasks.push(...loadManualTasks().slice(0, MAX_MANUAL_TASKS));
  recurringTasks.push(...loadRecurringTasks().slice(0, MAX_RECURRING_TASKS));
  slackNotifications.push(...loadSlackNotifications().slice(0, MAX_SLACK_NOTIFICATIONS));
  googleCalendarEvents.push(...loadGoogleCalendarEvents().slice(0, MAX_GOOGLE_CALENDAR_EVENTS));
  flushPendingTerminalUpdates();
  flushPendingTerminalEvents();
}
