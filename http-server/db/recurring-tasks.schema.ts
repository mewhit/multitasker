import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { recurringTaskFrequencyEnum } from './database-enums.schema';

export const recurringTasks = pgTable('recurring_tasks', {
  id: text('id').primaryKey(),
  text: text('text').notNull(),
  time: text('time').notNull(),
  frequency: recurringTaskFrequencyEnum('frequency').default('weekly').notNull(),
  daysOfWeek: jsonb('days_of_week').$type<number[]>().default(sql`'[]'::jsonb`).notNull(),
  intervalDays: integer('interval_days'),
  dayOfMonth: integer('day_of_month'),
  anchorDate: text('anchor_date'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  priority: integer('priority'),
  enabled: boolean('enabled').default(true).notNull(),
  lastGeneratedDate: text('last_generated_date'),
}, table => [
  index('recurring_tasks_enabled_idx').on(table.enabled),
  index('recurring_tasks_created_at_idx').on(table.createdAt),
]);

export type RecurringTaskRow = typeof recurringTasks.$inferSelect;
