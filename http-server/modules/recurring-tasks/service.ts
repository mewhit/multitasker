import { randomUUID } from 'node:crypto';
import type { RecurringTaskState } from '../../../shared/settings';
import { normalizeTaskPriority, saveRecurringTasks } from '../../../shared/settings';
import { recurringTasks } from '../../state/tasks';
import { MAX_RECURRING_TASKS } from '../../core/constants';
import { truncateTaskText } from '../../utils/date';
import { cloneRecurringTask } from '../../utils/clone';
import { parseRecurringSchedule, parseRecurringTimeMinutes } from './schedule-parse';
import { getInitialRecurringTaskGeneratedDate } from './scheduler';
import { broadcastRecurringTasks } from './broadcast';

export function createRecurringTask(
  textValue: unknown,
  timeValue: unknown,
  scheduleValue: unknown,
  priorityValue?: unknown
): RecurringTaskState | null {
  const text = typeof textValue === 'string' ? textValue.trim() : '';
  const time = typeof timeValue === 'string' ? timeValue.trim() : '';
  const schedule = parseRecurringSchedule(scheduleValue);
  if (!text || parseRecurringTimeMinutes(time) === null || !schedule) return null;
  const priority = readOptionalTaskPriority(priorityValue);
  if (priority === null) return null;

  const now = new Date();
  const task: RecurringTaskState = {
    id: `recurring-${randomUUID()}`,
    text: truncateTaskText(text),
    time,
    frequency: schedule.frequency,
    daysOfWeek: schedule.daysOfWeek,
    createdAt: now.getTime(),
    enabled: true,
  };
  if (priority !== undefined) task.priority = priority;
  if (schedule.intervalDays !== undefined) task.intervalDays = schedule.intervalDays;
  if (schedule.dayOfMonth !== undefined) task.dayOfMonth = schedule.dayOfMonth;
  if (schedule.anchorDate) task.anchorDate = schedule.anchorDate;
  const initialGeneratedDate = getInitialRecurringTaskGeneratedDate(task, now);
  if (initialGeneratedDate) task.lastGeneratedDate = initialGeneratedDate;

  recurringTasks.unshift(task);
  while (recurringTasks.length > MAX_RECURRING_TASKS) recurringTasks.pop();
  saveRecurringTasks(recurringTasks);
  broadcastRecurringTasks();
  return cloneRecurringTask(task);
}

export function removeRecurringTask(id: string): boolean {
  const existingIndex = recurringTasks.findIndex(task => task.id === id);
  if (existingIndex < 0) return false;

  recurringTasks.splice(existingIndex, 1);
  saveRecurringTasks(recurringTasks);
  broadcastRecurringTasks();
  return true;
}

function readOptionalTaskPriority(value: unknown): number | undefined | null {
  if (value === undefined || value === null || value === '') return undefined;
  return normalizeTaskPriority(value) ?? null;
}
