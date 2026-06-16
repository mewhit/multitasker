import { bigint, index, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { slackNotificationPriorityLabelEnum } from './database-enums.schema';

export const slackNotifications = pgTable('slack_notifications', {
  id: text('id').primaryKey(),
  teamId: text('team_id'),
  teamName: text('team_name'),
  channelId: text('channel_id'),
  channelName: text('channel_name'),
  channelType: text('channel_type'),
  userId: text('user_id'),
  userName: text('user_name'),
  text: text('text').notNull(),
  ts: text('ts'),
  threadTs: text('thread_ts'),
  permalink: text('permalink'),
  receivedAt: bigint('received_at', { mode: 'number' }).notNull(),
  messageCount: integer('message_count'),
  priorityRank: integer('priority_rank'),
  priorityLabel: slackNotificationPriorityLabelEnum('priority_label'),
}, table => [
  index('slack_notifications_received_at_idx').on(table.receivedAt),
  index('slack_notifications_channel_idx').on(table.teamId, table.channelId),
]);

export type SlackNotificationRow = typeof slackNotifications.$inferSelect;
