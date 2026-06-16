import type { GoogleCalendarEventState, ManualTaskState, RecurringTaskState, SlackNotificationState } from '../../shared/settings';

export const manualTasks: ManualTaskState[] = [];
export const recurringTasks: RecurringTaskState[] = [];
export const slackNotifications: SlackNotificationState[] = [];
export const googleCalendarEvents: GoogleCalendarEventState[] = [];

let recurringTaskTimer: ReturnType<typeof setInterval> | null = null;

export function getRecurringTaskTimer(): ReturnType<typeof setInterval> | null {
  return recurringTaskTimer;
}

export function setRecurringTaskTimer(timer: ReturnType<typeof setInterval> | null): void {
  recurringTaskTimer = timer;
}
