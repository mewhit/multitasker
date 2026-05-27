import type { ManualTaskState, RecurringTaskState, SlackNotificationState } from '../../desktop/settings';

export const manualTasks: ManualTaskState[] = [];
export const recurringTasks: RecurringTaskState[] = [];
export const slackNotifications: SlackNotificationState[] = [];

let recurringTaskTimer: ReturnType<typeof setInterval> | null = null;

export function getRecurringTaskTimer(): ReturnType<typeof setInterval> | null {
  return recurringTaskTimer;
}

export function setRecurringTaskTimer(timer: ReturnType<typeof setInterval> | null): void {
  recurringTaskTimer = timer;
}
