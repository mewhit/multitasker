import type { RecurringTaskState } from '../../../shared/settings';
import { saveRecurringTasks } from '../../../shared/settings';
import { recurringTasks, getRecurringTaskTimer, setRecurringTaskTimer } from '../../state/tasks';
import { RECURRING_TASK_CHECK_INTERVAL_MS } from '../../core/constants';
import { getLocalMinutesSinceMidnight, getLocalDateKey, parseLocalDateKey, getLocalDateDiffDays, getDaysInMonth } from '../../utils/date';
import { createManualTask } from '../manual-tasks/service';
import { broadcastRecurringTasks } from './broadcast';
import { parseRecurringTimeMinutes } from './schedule-parse';

export function startRecurringTaskScheduler(): void {
  const existingTimer = getRecurringTaskTimer();
  if (existingTimer) clearInterval(existingTimer);
  runDueRecurringTasks();
  setRecurringTaskTimer(setInterval(runDueRecurringTasks, RECURRING_TASK_CHECK_INTERVAL_MS));
}

export function stopRecurringTaskScheduler(): void {
  const timer = getRecurringTaskTimer();
  if (!timer) return;
  clearInterval(timer);
  setRecurringTaskTimer(null);
}

export function runDueRecurringTasks(now = new Date()): void {
  let changed = false;
  const today = getLocalDateKey(now);
  for (const task of recurringTasks) {
    if (!isRecurringTaskDue(task, now)) continue;
    if (task.lastGeneratedDate === today) continue;

    if (createManualTask(task.text, task.priority)) {
      task.lastGeneratedDate = today;
      changed = true;
    }
  }

  if (changed) {
    saveRecurringTasks(recurringTasks);
    broadcastRecurringTasks();
  }
}

export function isRecurringTaskDue(task: RecurringTaskState, now: Date): boolean {
  if (!task.enabled) return false;
  const taskMinutes = parseRecurringTimeMinutes(task.time);
  if (taskMinutes === null) return false;
  if (getLocalMinutesSinceMidnight(now) < taskMinutes) return false;

  const frequency = task.frequency ?? 'weekly';
  if (frequency === 'daily') return true;
  if (frequency === 'interval') return isRecurringIntervalDue(task, now);
  if (frequency === 'monthly') return isRecurringMonthlyDue(task, now);
  return task.daysOfWeek.includes(now.getDay());
}

export function isRecurringIntervalDue(task: RecurringTaskState, now: Date): boolean {
  const intervalDays = task.intervalDays;
  if (intervalDays === undefined || intervalDays < 1) return false;
  const anchorDate = parseLocalDateKey(task.anchorDate || getLocalDateKey(new Date(task.createdAt)));
  if (!anchorDate) return false;
  const daysSinceAnchor = getLocalDateDiffDays(anchorDate, now);
  return daysSinceAnchor >= 0 && daysSinceAnchor % intervalDays === 0;
}

export function isRecurringMonthlyDue(task: RecurringTaskState, now: Date): boolean {
  const dayOfMonth = task.dayOfMonth;
  if (dayOfMonth === undefined) return false;
  return now.getDate() === Math.min(dayOfMonth, getDaysInMonth(now));
}

export function getInitialRecurringTaskGeneratedDate(task: RecurringTaskState, now: Date): string {
  if (!isRecurringTaskDue(task, now)) return '';
  return getLocalDateKey(now);
}
