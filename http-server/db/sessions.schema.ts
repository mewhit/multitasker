import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import type { PersistedClientMetadata, SessionSshOptions } from '../../shared/settings';
import { sessionStatusEnum, shellTypeEnum } from './database-enums.schema';

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  cmd: text('cmd').notNull(),
  cwd: text('cwd').notNull(),
  shellType: shellTypeEnum('shell_type').notNull(),
  sshCommand: text('ssh_command'),
  sshOptions: jsonb('ssh_options').$type<SessionSshOptions>(),
  terminalRef: text('terminal_ref'),
  terminalPid: integer('terminal_pid'),
  clientMetadata: jsonb('client_metadata').$type<PersistedClientMetadata>(),
  status: sessionStatusEnum('status').default('needs_attention').notNull(),
  lastActivity: bigint('last_activity', { mode: 'number' }).notNull(),
  gitChanges: boolean('git_changes').default(false).notNull(),
  terminalExitCode: integer('terminal_exit_code'),
  terminalExitReason: text('terminal_exit_reason'),
  terminalCaptureState: text('terminal_capture_state'),
  terminalCaptureReason: text('terminal_capture_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, table => [
  index('sessions_status_idx').on(table.status),
  index('sessions_terminal_ref_idx').on(table.terminalRef),
]);

export type SessionRow = typeof sessions.$inferSelect;
