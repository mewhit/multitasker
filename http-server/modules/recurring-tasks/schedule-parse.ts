import type { RecurringTaskFrequency } from '../../../shared/settings';
import { readStringField } from '../../utils/payload';
import { getLocalDateKey } from '../../utils/date';

export interface RecurringSchedule {
  frequency: RecurringTaskFrequency;
  daysOfWeek: number[];
  intervalDays?: number;
  dayOfMonth?: number;
  anchorDate?: string;
}

export function parseRecurringSchedule(value: unknown): RecurringSchedule | null {
  if (Array.isArray(value)) {
    const daysOfWeek = normalizeRecurringDays(value);
    return daysOfWeek.length > 0 ? { frequency: 'weekly', daysOfWeek } : null;
  }

  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const frequency = normalizeRecurringFrequency(readStringField(record, 'frequency'));
  if (frequency === 'daily') return { frequency, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] };

  if (frequency === 'interval') {
    const intervalDays = normalizeRecurringIntervalDays(record['intervalDays']);
    if (intervalDays === null) return null;
    return { frequency, daysOfWeek: [], intervalDays, anchorDate: getLocalDateKey(new Date()) };
  }

  if (frequency === 'monthly') {
    const dayOfMonth = normalizeRecurringDayOfMonth(record['dayOfMonth']);
    if (dayOfMonth === null) return null;
    return { frequency, daysOfWeek: [], dayOfMonth };
  }

  const daysOfWeek = normalizeRecurringDays(record['daysOfWeek']);
  return daysOfWeek.length > 0 ? { frequency, daysOfWeek } : null;
}

export function normalizeRecurringDays(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const days = value
    .filter((day): day is number => typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6);
  return [...new Set(days)].sort((a, b) => a - b);
}

function normalizeRecurringFrequency(value: string): RecurringTaskFrequency {
  return value === 'daily' || value === 'interval' || value === 'monthly' ? value : 'weekly';
}

function normalizeRecurringIntervalDays(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 3650 ? value : null;
}

function normalizeRecurringDayOfMonth(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 31 ? value : null;
}

export function parseRecurringTimeMinutes(time: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours * 60 + minutes;
}
