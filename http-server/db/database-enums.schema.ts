import { pgEnum } from 'drizzle-orm/pg-core';

export const shellTypeEnum = pgEnum('shell_type', ['powershell', 'bash', 'ssh']);
export const sessionStatusEnum = pgEnum('session_status', [
  'waiting',
  'starting',
  'running',
  'needs_attention',
  'paused',
  'error',
  'stopped',
  'detached',
]);
export const recurringTaskFrequencyEnum = pgEnum('recurring_task_frequency', [
  'weekly',
  'daily',
  'interval',
  'monthly',
]);
export const slackNotificationPriorityLabelEnum = pgEnum('slack_notification_priority_label', [
  'mention',
  'dm',
  'thread_mention',
  'thread_written',
  'other',
]);
