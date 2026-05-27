import type { BackendState } from '../types';
import { sessionManager } from '../state/sessions';
import { manualTasks, recurringTasks, slackNotifications } from '../state/tasks';
import { vscodeWindowsById } from '../state/vscode';
import { cloneManualTask, cloneRecurringTask, cloneSlackNotification, cloneVsCodeWindowEntry } from '../utils/clone';

export function getBackendState(): BackendState {
  return {
    sessions: sessionManager.getSessions(),
    manualTasks: manualTasks.map(cloneManualTask),
    recurringTasks: recurringTasks.map(cloneRecurringTask),
    slackNotifications: slackNotifications.map(cloneSlackNotification),
    vscodeWindows: [...vscodeWindowsById.values()].map(cloneVsCodeWindowEntry),
  };
}
