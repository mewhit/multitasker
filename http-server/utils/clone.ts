import type { ManualTaskState, RecurringTaskState, SlackNotificationState } from '../../desktop/settings';
import type { VsCodeWindowEntry } from '../types';

export function cloneManualTask(task: ManualTaskState): ManualTaskState {
  return { ...task };
}

export function cloneRecurringTask(task: RecurringTaskState): RecurringTaskState {
  return {
    ...task,
    frequency: task.frequency ?? 'weekly',
    daysOfWeek: [...task.daysOfWeek],
  };
}

export function cloneSlackNotification(notification: SlackNotificationState): SlackNotificationState {
  return { ...notification };
}

export function cloneVsCodeWindowEntry(entry: VsCodeWindowEntry): VsCodeWindowEntry {
  const clone: VsCodeWindowEntry = {
    windowId: entry.windowId,
    lastSeenAt: entry.lastSeenAt,
  };
  if (entry.workspaceFolder) clone.workspaceFolder = entry.workspaceFolder;
  if (entry.workspaceName) clone.workspaceName = entry.workspaceName;
  if (entry.pid !== undefined) clone.pid = entry.pid;
  if (entry.terminals !== undefined) clone.terminals = entry.terminals.map(terminal => ({ ...terminal }));
  if (entry.sessionIds !== undefined) clone.sessionIds = [...entry.sessionIds];
  return clone;
}
