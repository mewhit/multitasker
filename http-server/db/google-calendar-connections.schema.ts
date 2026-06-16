import { bigint, boolean, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import type { GoogleCalendarAuthState } from '../../shared/settings';

export const googleCalendarConnections = pgTable('google_calendar_connections', {
  id: text('id').primaryKey(),
  accountEmail: text('account_email'),
  accountName: text('account_name'),
  calendarId: text('calendar_id').notNull(),
  lookAheadDays: integer('look_ahead_days').notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  connectedAt: bigint('connected_at', { mode: 'number' }).notNull(),
  lastSyncedAt: bigint('last_synced_at', { mode: 'number' }),
  authError: text('auth_error'),
  auth: jsonb('auth').$type<GoogleCalendarAuthState>().notNull(),
}, table => [
  index('google_calendar_connections_enabled_idx').on(table.enabled),
]);

export type GoogleCalendarConnectionRow = typeof googleCalendarConnections.$inferSelect;
