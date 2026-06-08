import type { SlackNotificationState } from '../../../shared/settings';
import { getSlackAuthedUserId, slackTeamNameCache } from '../../state/slack';
import {
  readSlackRecord,
  readSlackString,
  getSlackDebugTextPreview,
  truncateSlackText,
} from './parse';
import {
  isSlackDirectMessageChannel,
  SLACK_PRIORITY_OTHER,
} from './priority';
import { slackEventMentionsUser, resolveSlackMessageMentions } from './mentions';
import { rememberSlackAuthedUserThread, isSlackThreadWrittenByAuthedUser } from './threads';
import { getSlackChannelInfo, shouldAcceptSlackChannel } from './channels';
import { getSlackMessageSenderName, isSlackMessageFromCurrentUser } from './users';
import { handleSlackNotification, dismissSlackNotification, getSlackNotificationPriority } from './notifications';
import { debugSlackEventDecision, debugSlackLog } from './debug';
import { getErrorMessage } from '../../core/util';

export interface SlackEventEnvelopeResponse {
  challenge?: string;
  ok?: boolean;
}

export async function handleSlackEventEnvelope(payload: unknown): Promise<SlackEventEnvelopeResponse> {
  const envelope = readSlackRecord(payload);
  if (!envelope) {
    debugSlackLog('Invalid Slack event envelope', { payload: String(payload) });
    return { ok: false };
  }

  const type = readSlackString(envelope, 'type');

  if (type === 'url_verification') {
    const challenge = readSlackString(envelope, 'challenge');
    debugSlackLog('Slack URL verification', { challenge });
    return { challenge };
  }

  if (type === 'event_callback') {
    const event = readSlackRecord(envelope, 'event');
    const teamId = readSlackString(envelope, 'team_id');
    if (event) {
      await handleSlackEvent(event, teamId);
    }
  }

  return { ok: true };
}

async function handleSlackEvent(event: Record<string, unknown>, teamId: string): Promise<void> {
  const eventType = readSlackString(event, 'type');

  if (eventType === 'message') {
    await handleSlackMessageEvent(event, teamId);
    return;
  }

  if (eventType === 'channel_marked' || eventType === 'im_marked' || eventType === 'group_marked' || eventType === 'mpim_marked') {
    await handleSlackChannelMarked(event, teamId, eventType);
    return;
  }

  debugSlackEventDecision('ignored', { eventType, reason: 'unsupported_event_type' });
}

async function handleSlackMessageEvent(event: Record<string, unknown>, teamId: string): Promise<void> {
  const subtype = readSlackString(event, 'subtype');
  if (subtype === 'message_deleted' || subtype === 'message_changed') {
    debugSlackEventDecision('ignored', { subtype, reason: 'message_update' });
    return;
  }

  rememberSlackAuthedUserThread(event);

  if (isSlackMessageFromCurrentUser(event)) {
    const channelId = readSlackString(event, 'channel');
    const ts = readSlackString(event, 'ts');
    const threadTs = readSlackString(event, 'thread_ts');
    dismissSlackNotification({
      channelId,
      teamId,
      reason: 'user_reply',
      targetTs: threadTs || ts,
      replyTs: ts,
      receivedAt: Date.now(),
    });
    debugSlackEventDecision('dismissed', { channelId, reason: 'user_sent_message' });
    return;
  }

  const channelId = readSlackString(event, 'channel');
  const channelType = readSlackString(event, 'channel_type');

  if (!shouldAcceptSlackChannel(channelId, channelType)) {
    debugSlackEventDecision('ignored', { channelId, reason: 'channel_filter' });
    return;
  }

  try {
    const notification = await buildSlackNotification(event, teamId, channelId, channelType);
    if (notification) {
      handleSlackNotification(notification);
      debugSlackEventDecision('accepted', {
        channelId,
        priority: notification.priorityLabel,
        text: getSlackDebugTextPreview(notification.text),
      });
    }
  } catch (error) {
    debugSlackLog('Failed to build Slack notification', { error: getErrorMessage(error) });
  }
}

async function handleSlackChannelMarked(
  event: Record<string, unknown>,
  teamId: string,
  eventType: string
): Promise<void> {
  const channelId = readSlackString(event, 'channel');
  const ts = readSlackString(event, 'ts');

  const reason = eventType.includes('marked') ? 'channel_marked' : 'channel_read';
  const dismissed = dismissSlackNotification({
    channelId,
    teamId,
    reason,
    ts,
    receivedAt: Date.now(),
  });
  debugSlackEventDecision(dismissed ? 'dismissed' : 'no_match', { channelId, eventType, ts });
}

export async function buildSlackNotification(
  event: Record<string, unknown>,
  teamId: string,
  channelId: string,
  channelType: string
): Promise<SlackNotificationState | null> {
  const text = readSlackString(event, 'text');
  if (!text) return null;

  const ts = readSlackString(event, 'ts');
  const threadTs = readSlackString(event, 'thread_ts');
  const eventTs = readSlackString(event, 'event_ts');
  const userId = readSlackString(event, 'user');

  const authedUserId = getSlackAuthedUserId();
  const mentionsUser = slackEventMentionsUser(event);
  const isDirectMessage = isSlackDirectMessageChannel(channelId, channelType);
  const isThread = !!threadTs;
  const threadMentionsUser = isThread && mentionsUser;
  const isThreadWrittenByUser = isThread && authedUserId
    ? await isSlackThreadWrittenByAuthedUser(channelId, threadTs, event)
    : false;

  const priority = getSlackNotificationPriority(mentionsUser, isDirectMessage, threadMentionsUser, isThreadWrittenByUser);

  if (priority === SLACK_PRIORITY_OTHER && !isThread && !mentionsUser && !isDirectMessage) {
    debugSlackEventDecision('ignored', { channelId, reason: 'low_priority_channel_message' });
    return null;
  }

  const [resolvedText, userName, channelInfo] = await Promise.all([
    resolveSlackMessageMentions(text),
    getSlackMessageSenderName(event),
    getSlackChannelInfo(channelId),
  ]);

  const notification: SlackNotificationState = {
    id: `${teamId}:${channelId}:${ts || eventTs}`,
    text: truncateSlackText(resolvedText),
    receivedAt: Date.now(),
    priorityRank: priority.rank,
    priorityLabel: priority.label,
  };

  if (teamId) notification.teamId = teamId;
  const teamName = slackTeamNameCache.get(teamId);
  if (teamName) notification.teamName = teamName;

  if (channelId) notification.channelId = channelId;
  if (channelInfo.name) notification.channelName = channelInfo.name;
  if (channelInfo.type) notification.channelType = channelInfo.type;

  if (userId) notification.userId = userId;
  if (userName) notification.userName = userName;

  if (ts) notification.ts = ts;
  if (threadTs) notification.threadTs = threadTs;

  return notification;
}
