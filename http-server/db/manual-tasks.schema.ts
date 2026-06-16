import { bigint, index, integer, pgTable, text } from 'drizzle-orm/pg-core';

export const manualTasks = pgTable('manual_tasks', {
  id: text('id').primaryKey(),
  text: text('text').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  priority: integer('priority'),
}, table => [
  index('manual_tasks_created_at_idx').on(table.createdAt),
]);

export type ManualTaskRow = typeof manualTasks.$inferSelect;
