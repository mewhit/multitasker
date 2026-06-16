import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { getServerEnvValue } from '../core/env';
import * as appSettingsSchema from './app-settings.schema';
import * as databaseEnumsSchema from './database-enums.schema';
import * as googleCalendarConnectionsSchema from './google-calendar-connections.schema';
import * as googleCalendarEventsSchema from './google-calendar-events.schema';
import * as manualTasksSchema from './manual-tasks.schema';
import * as recurringTasksSchema from './recurring-tasks.schema';
import * as sessionsSchema from './sessions.schema';
import * as slackNotificationsSchema from './slack-notifications.schema';

const schema = {
  ...appSettingsSchema,
  ...databaseEnumsSchema,
  ...googleCalendarConnectionsSchema,
  ...googleCalendarEventsSchema,
  ...manualTasksSchema,
  ...recurringTasksSchema,
  ...sessionsSchema,
  ...slackNotificationsSchema,
};

export const MULTITASKER_DATABASE_URL_ENV = 'MULTITASKER_DATABASE_URL';
export const DEFAULT_DATABASE_URL = 'postgres://multitasker:multitasker@127.0.0.1:5432/multitasker';

export type MultitaskerDatabase = NodePgDatabase<typeof schema>;

let pool: Pool | null = null;
let database: MultitaskerDatabase | null = null;

export function getDatabaseUrl(): string {
  return getServerEnvValue(MULTITASKER_DATABASE_URL_ENV) ||
    getServerEnvValue('DATABASE_URL') ||
    DEFAULT_DATABASE_URL;
}

export function getDatabase(): MultitaskerDatabase {
  if (database) return database;

  pool = new Pool({ connectionString: getDatabaseUrl(), connectionTimeoutMillis: 5000 });
  database = drizzle(pool, { schema });
  return database;
}

export async function checkDatabaseConnection(): Promise<void> {
  await getDatabase().execute(sql`select 1`);
}

export async function closeDatabase(): Promise<void> {
  const currentPool = pool;
  pool = null;
  database = null;
  if (currentPool) await currentPool.end();
}
