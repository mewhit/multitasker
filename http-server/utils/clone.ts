import type { ManualTaskState, RecurringTaskState, SlackNotificationState } from '../../shared/settings';

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
