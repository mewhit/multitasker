import type { SlackNotificationState } from '../../../shared/settings';
import type { SlackNotificationPriority, SlackNotificationPriorityLabel } from '../../types';

export const SLACK_PRIORITY_MENTION: SlackNotificationPriority = { rank: 0, label: 'mention' };
export const SLACK_PRIORITY_DM: SlackNotificationPriority = { rank: 1, label: 'dm' };
export const SLACK_PRIORITY_THREAD_MENTION: SlackNotificationPriority = { rank: 2, label: 'thread_mention' };
export const SLACK_PRIORITY_THREAD_WRITTEN: SlackNotificationPriority = { rank: 3, label: 'thread_written' };
export const SLACK_PRIORITY_OTHER: SlackNotificationPriority = { rank: 4, label: 'other' };

export function getSlackPriorityLabelForRank(rank: number): SlackNotificationPriorityLabel {
  switch (normalizeSlackPriorityRank(rank)) {
    case SLACK_PRIORITY_MENTION.rank:
      return SLACK_PRIORITY_MENTION.label;
    case SLACK_PRIORITY_DM.rank:
      return SLACK_PRIORITY_DM.label;
    case SLACK_PRIORITY_THREAD_MENTION.rank:
      return SLACK_PRIORITY_THREAD_MENTION.label;
    case SLACK_PRIORITY_THREAD_WRITTEN.rank:
      return SLACK_PRIORITY_THREAD_WRITTEN.label;
    default:
      return SLACK_PRIORITY_OTHER.label;
  }
}

export function normalizeSlackPriorityRank(value: number): number {
  if (!Number.isFinite(value)) return 4;
  return Math.max(0, Math.min(4, Math.floor(value)));
}

export function isSlackNotificationPriorityLabel(value: string): value is NonNullable<SlackNotificationState['priorityLabel']> {
  return value === 'mention' ||
    value === 'dm' ||
    value === 'thread_mention' ||
    value === 'thread_written' ||
    value === 'other';
}

export function isSlackDirectMessageChannel(channelId: string, channelType?: string): boolean {
  return channelType === 'im' || channelType === 'mpim' || channelId.startsWith('D');
}
