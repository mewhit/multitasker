import { defineConfig } from 'drizzle-kit';

const DEFAULT_DATABASE_URL = 'postgres://multitasker:multitasker@127.0.0.1:5432/multitasker';
const databaseUrl =
  process.env['MULTITASKER_DATABASE_URL']?.trim() ||
  process.env['DATABASE_URL']?.trim() ||
  DEFAULT_DATABASE_URL;

export default defineConfig({
  schema: './db/**/*.schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: databaseUrl,
  },
  strict: true,
  verbose: true,
});
