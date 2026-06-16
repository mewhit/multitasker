import { bigint, boolean, index, pgTable, text } from 'drizzle-orm/pg-core';

export const googleCalendarEvents = pgTable('google_calendar_events', {
  id: text('id').primaryKey(),
  connectionId: text('connection_id').notNull(),
  accountEmail: text('account_email'),
  accountName: text('account_name'),
  calendarId: text('calendar_id').notNull(),
  summary: text('summary').notNull(),
  start: text('start').notNull(),
  end: text('end').notNull(),
  startMs: bigint('start_ms', { mode: 'number' }).notNull(),
  endMs: bigint('end_ms', { mode: 'number' }).notNull(),
  allDay: boolean('all_day').default(false).notNull(),
  htmlLink: text('html_link'),
  location: text('location'),
  updated: text('updated'),
}, table => [
  index('google_calendar_events_connection_idx').on(table.connectionId),
  index('google_calendar_events_start_ms_idx').on(table.startMs),
]);

export type GoogleCalendarEventRow = typeof googleCalendarEvents.$inferSelect;
