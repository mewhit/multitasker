import { randomUUID } from 'node:crypto';
import type { ManualTaskState } from '../../../shared/settings';
import { normalizeTaskPriority, saveManualTasks } from '../../../shared/settings';
import { manualTasks } from '../../state/tasks';
import { MAX_MANUAL_TASKS } from '../../core/constants';
import { truncateTaskText } from '../../utils/date';
import { cloneManualTask } from '../../utils/clone';
import { readStringField, readOptionalNumberField } from '../../utils/payload';
import { broadcastManualTasks } from './broadcast';

export function createManualTask(textValue: unknown, priorityValue?: unknown): ManualTaskState | null {
  const text = typeof textValue === 'string' ? textValue.trim() : '';
  if (!text) return null;

  const priority = readOptionalTaskPriority(priorityValue);
  if (priority === null) return null;

  const task: ManualTaskState = {
    id: `manual-${randomUUID()}`,
    text: truncateTaskText(text),
    createdAt: Date.now(),
  };
  if (priority !== undefined) task.priority = priority;
  return storeManualTask(task);
}

export function parseManualTaskAddRequest(payload: unknown): ManualTaskState | null {
  const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : undefined;
  const rawText = typeof payload === 'string'
    ? payload
    : readStringField(record, 'text') || readStringField(record, 'title') || readStringField(record, 'task');
  const text = rawText.trim();
  if (!text) return null;

  const id = readStringField(record, 'id').trim() || `manual-${randomUUID()}`;
  const createdAt = record ? readOptionalNumberField(record, 'createdAt') ?? Date.now() : Date.now();
  if (!Number.isFinite(createdAt)) return null;

  const priority = record ? readOptionalTaskPriority(record['priority'] ?? record['priorityRank']) : undefined;
  if (priority === null) return null;

  const task: ManualTaskState = {
    id,
    text: truncateTaskText(text),
    createdAt,
  };
  if (priority !== undefined) task.priority = priority;
  return task;
}

export function storeManualTask(task: ManualTaskState): ManualTaskState {
  const existingIndex = manualTasks.findIndex(existing => existing.id === task.id);
  if (existingIndex >= 0) manualTasks.splice(existingIndex, 1);
  manualTasks.unshift(cloneManualTask(task));
  while (manualTasks.length > MAX_MANUAL_TASKS) manualTasks.pop();
  saveManualTasks(manualTasks);
  broadcastManualTasks();
  return cloneManualTask(task);
}

export function removeManualTask(id: string): boolean {
  const existingIndex = manualTasks.findIndex(task => task.id === id);
  if (existingIndex < 0) return false;

  manualTasks.splice(existingIndex, 1);
  saveManualTasks(manualTasks);
  broadcastManualTasks();
  return true;
}

function readOptionalTaskPriority(value: unknown): number | undefined | null {
  if (value === undefined || value === null || value === '') return undefined;
  return normalizeTaskPriority(value) ?? null;
}
