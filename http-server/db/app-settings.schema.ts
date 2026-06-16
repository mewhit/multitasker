import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { AppSettings } from '../../shared/settings';

export const appSettings = pgTable('app_settings', {
  id: text('id').primaryKey().default('default'),
  settings: jsonb('settings').$type<AppSettings>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type AppSettingsRow = typeof appSettings.$inferSelect;
