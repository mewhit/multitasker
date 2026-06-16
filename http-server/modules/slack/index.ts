import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { SlackNotificationState } from '../../../shared/settings';
import { saveSlackNotifications } from '../../../shared/settings';
import { getBackendState } from '../../core/backend-state';
import { broadcastSseEvent } from '../../core/sse';
import type { HttpModule, RouteDef } from '../../core/types';
import { writeJsonResponse } from '../../core/body';
import {
  EXTENSION_SLACK_EVENT_PATH,
  MAX_SLACK_NOTIFICATIONS,
  MAX_SLACK_TEXT_LENGTH,
  SLACK_ENV_RELATIVE_PATH,
  SLACK_EVENT_PATH,
} from '../../core/constants';
import { getServerEnvValue, readEnvFile } from '../../core/env';
import { slackNotifications } from '../../state/tasks';
import { cloneSlackNotification } from '../../utils/clone';
import { isRecord, readStringField } from '../../utils/payload';

type SlackEventResult =
  | { kind: 'notification'; notification: SlackNotificationState }
  | { kind: 'challenge'; challenge: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'invalid'; error: string };

export const slackModule: HttpModule = {
  name: 'slack',
  routes(): RouteDef[] {
    return [
      {
        method: 'POST',
        path: SLACK_EVENT_PATH,
        handler({ payload, response }) {
          handleSlackEventPost(payload, response);
        },
      },
      {
        method: 'POST',
        path: '/slack',
        handler({ payload, response }) {
          handleSlackEventPost(payload, response);
        },
      },
      {
        method: 'POST',
        path: EXTENSION_SLACK_EVENT_PATH,
        handler({ payload, response }) {
          handleSlackEventPost(payload, response);
        },
      },
      {
        method: 'GET',
        path: '/api/slack-notifications',
        handler({ response }) {
          writeJsonResponse(response, 200, { ok: true, slackNotifications: slackNotifications.map(cloneSlackNotification) });
        },
      },
      {
        method: 'POST',
        path: '/api/slack-notification/remove',
        handler({ payload, response }) {
          const id = isRecord(payload) ? readStringField(payload, 'id').trim() : '';
          if (!id) {
            writeJsonResponse(response, 400, { ok: false, error: 'missing_notification_id' });
            return;
          }
          writeJsonResponse(response, 200, { ok: true, removed: removeSlackNotification(id) });
        },
      },
      {
        method: 'POST',
        path: '/api/slack-notifications/clear',
        handler({ response }) {
          clearSlackNotifications();
          writeJsonResponse(response, 200, { ok: true });
        },
      },
    ];
  },
};

function handleSlackEventPost(payload: unknown, response: ServerResponse): void {
  const result = parseSlackEvent(payload);
  if (result.kind === 'invalid') {
    writeJsonResponse(response, 400, { ok: false, error: result.error });
    return;
  }
  if (result.kind === 'challenge') {
    writeJsonResponse(response, 200, { challenge: result.challenge });
    return;
  }
  if (result.kind === 'skipped') {
    writeJsonResponse(response, 200, { ok: true, skipped: true, reason: result.reason });
    return;
  }

  writeJsonResponse(response, 200, { ok: true, notification: storeSlackNotification(result.notification) });
}

function parseSlackEvent(payload: unknown): SlackEventResult {
  if (!isRecord(payload)) return { kind: 'invalid', error: 'invalid_slack_event' };

  const eventPayload = isRecord(payload['payload']) ? payload['payload'] : payload;
  const payloadType = readStringField(eventPayload, 'type').trim();
  if (payloadType === 'url_verification') {
    const challenge = readStringField(eventPayload, 'challenge').trim();
    return challenge
      ? { kind: 'challenge', challenge }
      : { kind: 'invalid', error: 'missing_slack_challenge' };
  }

  const event = isRecord(eventPayload['event']) ? eventPayload['event'] : undefined;
  if (!event) return { kind: 'skipped', reason: 'missing_event' };
  if (!shouldCreateSlackNotificationForEvent(event)) return { kind: 'skipped', reason: 'not_actionable' };

  const text = normalizeSlackText(readStringField(event, 'text'));
  if (!text) return { kind: 'skipped', reason: 'missing_text' };

  const teamId = readStringField(eventPayload, 'team_id').trim() || readStringField(payload, 'team_id').trim();
  const channelId = readStringField(event, 'channel').trim();
  const channelType = readStringField(event, 'channel_type').trim();
  const userId = readStringField(event, 'user').trim() || readStringField(event, 'bot_id').trim();
  const ts = readStringField(event, 'ts').trim() || readStringField(event, 'event_ts').trim();
  const threadTs = readStringField(event, 'thread_ts').trim();
  const permalink = readStringField(event, 'permalink').trim();
  const eventId = readStringField(eventPayload, 'event_id').trim() || readStringField(payload, 'envelope_id').trim();
  const receivedAt = parseSlackTimestampMs(ts) ?? parseSlackEventTimeMs(eventPayload['event_time']) ?? Date.now();
  const notification: SlackNotificationState = {
    id: getSlackNotificationId({ teamId, channelId, ts, eventId, userId, text }),
    text: truncateSlackText(text),
    receivedAt,
  };
  if (teamId) notification.teamId = teamId;
  if (channelId) notification.channelId = channelId;
  if (channelType) notification.channelType = channelType;
  if (userId) notification.userId = userId;
  if (ts) notification.ts = ts;
  if (threadTs) notification.threadTs = threadTs;
  if (permalink) notification.permalink = permalink;
  const priority = slackNotificationPriority(event, channelType);
  notification.priorityRank = priority.rank;
  notification.priorityLabel = priority.label;

  return {
    kind: 'notification',
    notification,
  };
}

function shouldCreateSlackNotificationForEvent(event: Record<string, unknown>): boolean {
  const eventType = readStringField(event, 'type').trim();
  if (eventType === 'app_mention') return true;
  if (eventType !== 'message') return false;

  const subtype = readStringField(event, 'subtype').trim();
  if (subtype) return false;

  const channelType = readStringField(event, 'channel_type').trim();
  const channelId = readStringField(event, 'channel').trim();
  if (channelType === 'im' || channelType === 'mpim' || channelId.startsWith('D')) return true;

  const slackUserId = getSlackEnvValue('SLACK_USER_ID');
  const text = readStringField(event, 'text');
  return Boolean(slackUserId && text.includes(`<@${slackUserId}>`));
}

function getSlackNotificationId(identity: {
  teamId: string;
  channelId: string;
  ts: string;
  eventId: string;
  userId: string;
  text: string;
}): string {
  const stableValue = [
    identity.teamId,
    identity.channelId,
    identity.ts,
    identity.eventId,
    identity.userId,
    identity.text,
  ].join('\n');
  return `slack-${createHash('sha256').update(stableValue).digest('hex').slice(0, 16)}`;
}

function storeSlackNotification(notification: SlackNotificationState): SlackNotificationState {
  const existingIndex = slackNotifications.findIndex(existing => existing.id === notification.id);
  if (existingIndex >= 0) slackNotifications.splice(existingIndex, 1);
  const storedNotification = cloneSlackNotification(notification);
  slackNotifications.unshift(storedNotification);
  while (slackNotifications.length > MAX_SLACK_NOTIFICATIONS) slackNotifications.pop();
  saveSlackNotifications(slackNotifications);
  broadcastSseEvent('slack:notification', cloneSlackNotification(storedNotification));
  broadcastSlackNotifications();
  return cloneSlackNotification(storedNotification);
}

function removeSlackNotification(id: string): boolean {
  const existingIndex = slackNotifications.findIndex(notification => notification.id === id);
  if (existingIndex < 0) return false;
  slackNotifications.splice(existingIndex, 1);
  saveSlackNotifications(slackNotifications);
  broadcastSlackNotifications();
  return true;
}

function clearSlackNotifications(): void {
  if (slackNotifications.length === 0) return;
  slackNotifications.length = 0;
  saveSlackNotifications(slackNotifications);
  broadcastSlackNotifications();
}

function broadcastSlackNotifications(): void {
  broadcastSseEvent('slack:list-update', slackNotifications.map(cloneSlackNotification));
  broadcastSseEvent('state', getBackendState());
}

function slackNotificationPriority(
  event: Record<string, unknown>,
  channelType: string
): { rank: number; label: NonNullable<SlackNotificationState['priorityLabel']> } {
  if (channelType === 'im' || channelType === 'mpim') return { rank: 0, label: 'dm' };
  const slackUserId = getSlackEnvValue('SLACK_USER_ID');
  const text = readStringField(event, 'text');
  if (slackUserId && text.includes(`<@${slackUserId}>`)) return { rank: 1, label: 'mention' };
  if (readStringField(event, 'type').trim() === 'app_mention') return { rank: 1, label: 'mention' };
  return { rank: 4, label: 'other' };
}

function truncateSlackText(text: string): string {
  if (text.length <= MAX_SLACK_TEXT_LENGTH) return text;
  return `${text.slice(0, MAX_SLACK_TEXT_LENGTH - 1)}…`;
}

function normalizeSlackText(text: string): string {
  return decodeSlackEntities(text)
    .replace(/<@([A-Z0-9]+)>/gi, '@$1')
    .replace(/<#([A-Z0-9]+)\|([^>]+)>/gi, '#$2')
    .replace(/<([^>|]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<([^>]+)>/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeSlackEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function parseSlackTimestampMs(value: string): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds * 1000) : undefined;
}

function parseSlackEventTimeMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value * 1000) : undefined;
}

function getSlackEnvValue(key: string): string {
  const serverValue = getServerEnvValue(key);
  if (serverValue) return serverValue;

  const slackEnvPath = path.join(process.cwd(), SLACK_ENV_RELATIVE_PATH);
  if (!fs.existsSync(slackEnvPath)) return '';
  const value = readEnvFile(slackEnvPath)[key];
  return typeof value === 'string' ? value.trim() : '';
}
