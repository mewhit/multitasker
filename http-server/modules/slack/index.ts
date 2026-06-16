import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { SlackNotificationState } from '../../../shared/settings';
import { saveSlackNotifications } from '../../../shared/settings';
import { getBackendNextUpItems, getBackendState } from '../../core/backend-state';
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

const slackUserNameCache = new Map<string, string>();
const slackChannelNameCache = new Map<string, string>();
const slackChannelPeerUserIdCache = new Map<string, string>();

export const slackModule: HttpModule = {
  name: 'slack',
  routes(): RouteDef[] {
    return [
      {
        method: 'POST',
        path: SLACK_EVENT_PATH,
        async handler({ payload, response }) {
          await handleSlackEventPost(payload, response);
        },
      },
      {
        method: 'POST',
        path: '/slack',
        async handler({ payload, response }) {
          await handleSlackEventPost(payload, response);
        },
      },
      {
        method: 'POST',
        path: EXTENSION_SLACK_EVENT_PATH,
        async handler({ payload, response }) {
          await handleSlackEventPost(payload, response);
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

async function handleSlackEventPost(payload: unknown, response: ServerResponse): Promise<void> {
  const result = await parseSlackEvent(payload);
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

async function parseSlackEvent(payload: unknown): Promise<SlackEventResult> {
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
  const authedUserIds = getSlackAuthedUserIds(eventPayload, payload);
  if (!shouldCreateSlackNotificationForEvent(event, authedUserIds)) return { kind: 'skipped', reason: 'not_actionable' };

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
  const teamName = readStringField(eventPayload, 'team_name').trim() || readStringField(payload, 'team_name').trim();
  if (teamName) notification.teamName = teamName;
  if (channelId) notification.channelId = channelId;
  const channelName = readStringField(event, 'channel_name').trim() || readStringField(eventPayload, 'channel_name').trim();
  if (channelName) notification.channelName = channelName;
  if (channelType) notification.channelType = channelType;
  if (userId) notification.userId = userId;
  const userName = readSlackUserDisplayName(event) || readStringField(eventPayload, 'user_name').trim();
  if (userName) notification.userName = userName;
  if (ts) notification.ts = ts;
  if (threadTs) notification.threadTs = threadTs;
  if (permalink) notification.permalink = permalink;
  await enrichSlackNotification(notification);
  const priority = slackNotificationPriority(event, channelType, authedUserIds);
  notification.priorityRank = priority.rank;
  notification.priorityLabel = priority.label;

  return {
    kind: 'notification',
    notification,
  };
}

function shouldCreateSlackNotificationForEvent(event: Record<string, unknown>, authedUserIds: ReadonlySet<string>): boolean {
  if (isSlackEventSentByAuthedUser(event, authedUserIds)) return false;

  const eventType = readStringField(event, 'type').trim();
  if (eventType === 'app_mention') return true;
  if (eventType !== 'message') return false;

  const subtype = readStringField(event, 'subtype').trim();
  if (subtype) return false;

  const channelType = readStringField(event, 'channel_type').trim();
  const channelId = readStringField(event, 'channel').trim();
  if (channelType === 'im' || channelType === 'mpim' || channelId.startsWith('D')) return true;

  const text = readStringField(event, 'text');
  return isMessageMentioningAuthedUser(text, authedUserIds);
}

function isSlackEventSentByAuthedUser(event: Record<string, unknown>, authedUserIds: ReadonlySet<string>): boolean {
  if (authedUserIds.size === 0) return false;
  const senderUserId = readStringField(event, 'user').trim();
  return Boolean(senderUserId && authedUserIds.has(senderUserId));
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
  broadcastSseEvent('next-up:list-update', getBackendNextUpItems());
}

function slackNotificationPriority(
  event: Record<string, unknown>,
  channelType: string,
  authedUserIds: ReadonlySet<string>
): { rank: number; label: NonNullable<SlackNotificationState['priorityLabel']> } {
  if (channelType === 'im' || channelType === 'mpim') return { rank: 0, label: 'dm' };
  const text = readStringField(event, 'text');
  if (isMessageMentioningAuthedUser(text, authedUserIds)) return { rank: 1, label: 'mention' };
  if (readStringField(event, 'type').trim() === 'app_mention') return { rank: 1, label: 'mention' };
  return { rank: 4, label: 'other' };
}

function isMessageMentioningAuthedUser(text: string, authedUserIds: ReadonlySet<string>): boolean {
  if (!text || authedUserIds.size === 0) return false;
  for (const slackUserId of authedUserIds) {
    if (text.includes(`<@${slackUserId}>`)) return true;
  }
  return false;
}

function getSlackAuthedUserIds(eventPayload: Record<string, unknown>, payload: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  addSlackUserId(ids, getSlackEnvValue('SLACK_USER_ID'));
  addSlackUserId(ids, readStringField(eventPayload, 'user_id').trim());
  addSlackUserId(ids, readStringField(payload, 'user_id').trim());

  const authedUsers = eventPayload['authed_users'];
  if (Array.isArray(authedUsers)) {
    for (const value of authedUsers) {
      addSlackUserId(ids, typeof value === 'string' ? value.trim() : '');
    }
  }

  const authorizations = Array.isArray(eventPayload['authorizations'])
    ? eventPayload['authorizations']
    : Array.isArray(payload['authorizations'])
      ? payload['authorizations']
      : [];
  for (const authorization of authorizations) {
    if (!isRecord(authorization)) continue;
    addSlackUserId(ids, readStringField(authorization, 'user_id').trim());
  }

  return ids;
}

function addSlackUserId(collection: Set<string>, value: string): void {
  const userId = value.trim();
  if (userId) collection.add(userId);
}

function readSlackUserDisplayName(event: Record<string, unknown>): string {
  const profile = isRecord(event['user_profile']) ? event['user_profile'] : undefined;
  return readStringField(profile ?? {}, 'display_name').trim() ||
    readStringField(profile ?? {}, 'real_name').trim() ||
    readStringField(profile ?? {}, 'name').trim() ||
    readStringField(event, 'username').trim();
}

async function enrichSlackNotification(notification: SlackNotificationState): Promise<void> {
  if (!notification.teamName) {
    const teamName = getSlackEnvValue('SLACK_TEAM_NAME');
    if (teamName) notification.teamName = teamName;
  }

  if (notification.channelId && (!notification.channelName || isGenericDmLabel(notification.channelName))) {
    const channel = await resolveSlackChannelMetadata(notification.channelId);
    if (channel.channelName) notification.channelName = channel.channelName;
    if (!notification.userId && channel.peerUserId) notification.userId = channel.peerUserId;
  }

  if (notification.userId && !notification.userName) {
    notification.userName = await resolveSlackUserName(notification.userId);
  }

  if (notification.channelType === 'im' && (!notification.channelName || isGenericDmLabel(notification.channelName)) && notification.userName) {
    notification.channelName = notification.userName;
  }
}

async function resolveSlackChannelMetadata(channelId: string): Promise<{ channelName: string; peerUserId: string }> {
  const cachedChannelName = slackChannelNameCache.get(channelId) ?? '';
  const cachedPeerUserId = slackChannelPeerUserIdCache.get(channelId) ?? '';
  if (cachedChannelName || cachedPeerUserId) {
    return { channelName: cachedChannelName, peerUserId: cachedPeerUserId };
  }

  const response = await callSlackApi('conversations.info', { channel: channelId });
  const channel = isRecord(response?.['channel']) ? response['channel'] : undefined;
  if (!channel) return { channelName: '', peerUserId: '' };

  const channelName = readStringField(channel, 'name').trim();
  if (channelName) slackChannelNameCache.set(channelId, channelName);

  const peerUserId = readStringField(channel, 'user').trim();
  if (peerUserId) slackChannelPeerUserIdCache.set(channelId, peerUserId);

  return {
    channelName,
    peerUserId,
  };
}

async function resolveSlackUserName(userId: string): Promise<string> {
  const cachedUserName = slackUserNameCache.get(userId);
  if (cachedUserName) return cachedUserName;

  const response = await callSlackApi('users.info', { user: userId });
  const user = isRecord(response?.['user']) ? response['user'] : undefined;
  if (!user) return '';
  const profile = isRecord(user['profile']) ? user['profile'] : undefined;
  const userName = readStringField(profile ?? {}, 'display_name').trim() ||
    readStringField(profile ?? {}, 'real_name').trim() ||
    readStringField(user, 'real_name').trim() ||
    readStringField(user, 'name').trim();
  if (userName) slackUserNameCache.set(userId, userName);
  return userName;
}

async function callSlackApi(method: string, query: Record<string, string>): Promise<Record<string, unknown> | null> {
  const token = getSlackApiToken();
  if (!token) return null;

  const url = new URL(`https://slack.com/api/${method}`);
  for (const [key, value] of Object.entries(query)) {
    const fieldValue = value.trim();
    if (fieldValue) url.searchParams.set(key, fieldValue);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn(`Slack API ${method} failed with HTTP ${response.status}`);
      return null;
    }
    const payload = await response.json();
    if (!isRecord(payload)) return null;
    if (payload['ok'] !== true) {
      const error = readStringField(payload, 'error').trim() || 'unknown_error';
      console.warn(`Slack API ${method} returned error: ${error}`);
      return null;
    }
    return payload;
  } catch (error) {
    console.warn(`Slack API ${method} request failed: ${String(error)}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function getSlackApiToken(): string {
  return getSlackEnvValue('SLACK_USER_TOKEN') || getSlackEnvValue('SLACK_BOT_TOKEN');
}

function isGenericDmLabel(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === 'dm' || normalized === 'direct message';
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
