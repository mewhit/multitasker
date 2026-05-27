import type { SlackNotificationState } from '../../../desktop/settings';
import { MAX_SLACK_TEXT_LENGTH, MAX_SLACK_DEBUG_TEXT_LENGTH } from '../../core/constants';
import { readStringField, readOptionalNumberField } from '../../utils/payload';
import { normalizeSlackPriorityRank, isSlackNotificationPriorityLabel } from './priority';

export function readSlackRecord(value: unknown, key?: string): Record<string, unknown> | undefined {
  const candidate = key && typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : value;
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : undefined;
}

export function readSlackString(record: Record<string, unknown> | undefined, key: string): string {
  if (!record) return '';
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function readSlackStringArray(record: Record<string, unknown> | undefined, key: string): string[] {
  if (!record) return [];
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map(item => item.trim());
}

export function readSlackBoolean(record: Record<string, unknown> | undefined, key: string): boolean | undefined {
  if (!record) return undefined;
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

export function isRawSlackId(value: string): boolean {
  return /^[A-Z][A-Z0-9]{8,}$/.test(value);
}

export function getSlackDebugTextPreview(text: string): string {
  const preview = text.replace(/\s+/g, ' ').trim();
  if (preview.length <= MAX_SLACK_DEBUG_TEXT_LENGTH) return preview;
  return `${preview.slice(0, MAX_SLACK_DEBUG_TEXT_LENGTH - 1)}…`;
}

export function parseSlackNotificationRequest(payload: unknown): SlackNotificationState | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const id = readStringField(record, 'id').trim();
  const receivedAt = readOptionalNumberField(record, 'receivedAt') ?? Date.now();
  if (!id || !Number.isFinite(receivedAt)) return null;

  const notification: SlackNotificationState = {
    id,
    text: truncateSlackText(readStringField(record, 'text').trim() || '(no text)'),
    receivedAt,
  };
  addOptionalSlackString(notification, 'teamId', readStringField(record, 'teamId'));
  addOptionalSlackString(notification, 'teamName', readStringField(record, 'teamName'));
  addOptionalSlackString(notification, 'channelId', readStringField(record, 'channelId'));
  addOptionalSlackString(notification, 'channelName', readStringField(record, 'channelName'));
  addOptionalSlackString(notification, 'channelType', readStringField(record, 'channelType'));
  addOptionalSlackString(notification, 'userId', readStringField(record, 'userId'));
  addOptionalSlackString(notification, 'userName', readStringField(record, 'userName'));
  addOptionalSlackString(notification, 'ts', readStringField(record, 'ts'));
  addOptionalSlackString(notification, 'threadTs', readStringField(record, 'threadTs'));
  addOptionalSlackString(notification, 'permalink', readStringField(record, 'permalink'));
  const messageCount = readOptionalNumberField(record, 'messageCount');
  if (messageCount !== undefined && messageCount > 1) notification.messageCount = Math.floor(messageCount);
  const priorityRank = readOptionalNumberField(record, 'priorityRank');
  if (priorityRank !== undefined) notification.priorityRank = normalizeSlackPriorityRank(priorityRank);
  const priorityLabel = readStringField(record, 'priorityLabel').trim();
  if (isSlackNotificationPriorityLabel(priorityLabel)) notification.priorityLabel = priorityLabel;
  return notification;
}

export function parseSlackNotificationDismissRequest(payload: unknown): import('../../types').SlackNotificationDismissRequest | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const channelId = readStringField(record, 'channelId').trim();
  if (!channelId) return null;

  const request: import('../../types').SlackNotificationDismissRequest = { channelId };
  const teamId = readStringField(record, 'teamId').trim();
  if (teamId) request.teamId = teamId;
  const channelType = readStringField(record, 'channelType').trim();
  if (channelType) request.channelType = channelType;
  const reason = readStringField(record, 'reason').trim();
  if (reason) request.reason = reason;
  const targetTs = readStringField(record, 'targetTs').trim();
  if (targetTs) request.targetTs = targetTs;
  const replyTs = readStringField(record, 'replyTs').trim();
  if (replyTs) request.replyTs = replyTs;
  const ts = readStringField(record, 'ts').trim();
  if (ts) request.ts = ts;
  const receivedAt = readOptionalNumberField(record, 'receivedAt');
  if (receivedAt !== undefined) request.receivedAt = receivedAt;
  return request;
}

export function addOptionalSlackString(
  notification: SlackNotificationState,
  key: Exclude<keyof SlackNotificationState, 'id' | 'text' | 'receivedAt' | 'messageCount' | 'priorityRank' | 'priorityLabel'>,
  value: string
): void {
  const trimmedValue = value.trim();
  if (trimmedValue) notification[key] = trimmedValue;
}

export function truncateSlackText(text: string): string {
  if (text.length <= MAX_SLACK_TEXT_LENGTH) return text;
  return `${text.slice(0, MAX_SLACK_TEXT_LENGTH - 1)}…`;
}

export function parseSlackTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
