import type { SlackNotificationState } from '../../../desktop/settings';
import type { SlackNotificationDismissRequest } from '../../types';
import { slackNotifications } from '../../state/tasks';
import { MAX_SLACK_NOTIFICATIONS } from '../../core/constants';
import { broadcastSlackListUpdate } from './broadcast';
import {
  SLACK_PRIORITY_MENTION,
  SLACK_PRIORITY_DM,
  SLACK_PRIORITY_THREAD_MENTION,
  SLACK_PRIORITY_THREAD_WRITTEN,
  SLACK_PRIORITY_OTHER,
} from './priority';
import { parseSlackTimestamp, truncateSlackText } from './parse';

export function handleSlackNotification(notification: SlackNotificationState): boolean {
  const existingIndex = slackNotifications.findIndex(n =>
    n.channelId === notification.channelId &&
    (!n.teamId || !notification.teamId || n.teamId === notification.teamId)
  );

  if (existingIndex >= 0) {
    const existing = slackNotifications[existingIndex];
    if (existing) {
      const merged = mergeSlackNotifications(existing, notification);
      slackNotifications[existingIndex] = merged;
      broadcastSlackListUpdate();
      return true;
    }
  }

  slackNotifications.push(notification);

  while (slackNotifications.length > MAX_SLACK_NOTIFICATIONS) {
    slackNotifications.pop();
  }

  slackNotifications.sort((a, b) => {
    const rankA = a.priorityRank ?? SLACK_PRIORITY_OTHER.rank;
    const rankB = b.priorityRank ?? SLACK_PRIORITY_OTHER.rank;
    if (rankA !== rankB) return rankA - rankB;
    return b.receivedAt - a.receivedAt;
  });

  broadcastSlackListUpdate();
  return true;
}

export function mergeSlackNotifications(
  existing: SlackNotificationState,
  incoming: SlackNotificationState
): SlackNotificationState {
  const existingRank = existing.priorityRank ?? SLACK_PRIORITY_OTHER.rank;
  const incomingRank = incoming.priorityRank ?? SLACK_PRIORITY_OTHER.rank;

  const useIncoming = incomingRank < existingRank
    || (incomingRank === existingRank && incoming.receivedAt >= existing.receivedAt);

  const base = useIncoming ? incoming : existing;
  const other = useIncoming ? existing : incoming;

  const merged: SlackNotificationState = {
    id: base.id,
    text: truncateSlackText(base.text),
    receivedAt: Math.max(existing.receivedAt, incoming.receivedAt),
  };

  if (base.teamId) merged.teamId = base.teamId;
  else if (other.teamId) merged.teamId = other.teamId;

  if (base.teamName) merged.teamName = base.teamName;
  else if (other.teamName) merged.teamName = other.teamName;

  if (base.channelId) merged.channelId = base.channelId;
  else if (other.channelId) merged.channelId = other.channelId;

  if (base.channelName) merged.channelName = base.channelName;
  else if (other.channelName) merged.channelName = other.channelName;

  if (base.channelType) merged.channelType = base.channelType;
  else if (other.channelType) merged.channelType = other.channelType;

  if (base.userId) merged.userId = base.userId;
  else if (other.userId) merged.userId = other.userId;

  if (base.userName) merged.userName = base.userName;
  else if (other.userName) merged.userName = other.userName;

  if (base.ts) merged.ts = base.ts;
  if (base.threadTs) merged.threadTs = base.threadTs;
  if (base.permalink) merged.permalink = base.permalink;

  const existingCount = existing.messageCount ?? 1;
  const incomingCount = incoming.messageCount ?? 1;
  merged.messageCount = Math.max(existingCount, incomingCount) + 1;

  merged.priorityRank = Math.min(existingRank, incomingRank);
  const priorityLabel = base.priorityLabel ?? other.priorityLabel;
  if (priorityLabel) merged.priorityLabel = priorityLabel;

  return merged;
}

export function dismissSlackNotification(request: SlackNotificationDismissRequest): boolean {
  const { channelId, teamId, targetTs, replyTs, ts, receivedAt, reason } = request;

  const index = slackNotifications.findIndex(n =>
    n.channelId === channelId &&
    (!teamId || !n.teamId || n.teamId === teamId)
  );

  if (index < 0) return false;

  const notification = slackNotifications[index];
  if (!notification) return false;

  const shouldDismiss = shouldDismissSlackNotification(notification, targetTs, replyTs, ts, receivedAt, reason);
  if (!shouldDismiss) return false;

  slackNotifications.splice(index, 1);
  broadcastSlackListUpdate();
  return true;
}

function shouldDismissSlackNotification(
  notification: SlackNotificationState,
  targetTs: string | undefined,
  replyTs: string | undefined,
  ts: string | undefined,
  receivedAt: number | undefined,
  reason: string | undefined
): boolean {
  if (reason === 'channel_read' || reason === 'channel_marked') {
    if (!ts) return true;
    const notificationTs = parseSlackTimestamp(notification.ts);
    const dismissTs = parseSlackTimestamp(ts);
    if (notificationTs === null || dismissTs === null) return true;
    return notificationTs <= dismissTs;
  }

  if (reason === 'user_reply' && replyTs) {
    const replyTsNum = parseSlackTimestamp(replyTs);
    if (replyTsNum !== null && receivedAt && replyTsNum * 1000 > notification.receivedAt) {
      return true;
    }
    const notificationTs = parseSlackTimestamp(notification.ts) ?? parseSlackTimestamp(notification.threadTs);
    const targetTsNum = parseSlackTimestamp(targetTs);
    if (notificationTs !== null && targetTsNum !== null && notificationTs <= targetTsNum) {
      return true;
    }
  }

  if (reason === 'thread_marked' && ts) {
    const markedTs = parseSlackTimestamp(ts);
    const notificationThreadTs = parseSlackTimestamp(notification.threadTs);
    if (markedTs !== null && notificationThreadTs !== null && notificationThreadTs === markedTs) {
      return true;
    }
  }

  return true;
}

export function getSlackNotificationPriority(
  mentionsUser: boolean,
  isDirectMessage: boolean,
  threadMentionsUser: boolean,
  isThreadWrittenByUser: boolean
): typeof SLACK_PRIORITY_MENTION | typeof SLACK_PRIORITY_DM | typeof SLACK_PRIORITY_THREAD_MENTION | typeof SLACK_PRIORITY_THREAD_WRITTEN | typeof SLACK_PRIORITY_OTHER {
  if (mentionsUser) return SLACK_PRIORITY_MENTION;
  if (isDirectMessage) return SLACK_PRIORITY_DM;
  if (threadMentionsUser) return SLACK_PRIORITY_THREAD_MENTION;
  if (isThreadWrittenByUser) return SLACK_PRIORITY_THREAD_WRITTEN;
  return SLACK_PRIORITY_OTHER;
}
