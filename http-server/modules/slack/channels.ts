import type { SlackChannelInfo } from '../../types';
import { getSlackChannelCache, slackChannelNameCache } from '../../state/slack';
import { getSlackUserToken, getSlackBotToken, getSlackWebApiToken } from './env';
import { slackApiWithFallback } from './api';
import { readSlackRecord, readSlackString, readSlackBoolean } from './parse';
import { debugSlackLog } from './debug';
import { getErrorMessage } from '../../core/util';

let pendingChannelInfoRequests: Map<string, Promise<SlackChannelInfo>> = new Map();

export async function getSlackChannelInfo(channelId: string): Promise<SlackChannelInfo> {
  const cache = getSlackChannelCache();
  const cached = cache.get(channelId);
  if (cached) return cached;

  const pending = pendingChannelInfoRequests.get(channelId);
  if (pending) return pending;

  const promise = resolveSlackChannelInfo(channelId);
  pendingChannelInfoRequests.set(channelId, promise);
  try {
    return await promise;
  } finally {
    pendingChannelInfoRequests.delete(channelId);
  }
}

async function resolveSlackChannelInfo(channelId: string): Promise<SlackChannelInfo> {
  const cache = getSlackChannelCache();
  const token = getSlackWebApiToken();
  if (!token) {
    return { id: channelId, name: channelId, type: channelId.startsWith('D') ? 'im' : 'channel' };
  }

  try {
    const response = await slackApiWithFallback('conversations.info', [getSlackUserToken(), getSlackBotToken()], {
      channel: channelId,
    });
    const channel = readSlackRecord(response, 'channel');
    const isIm = readSlackBoolean(channel, 'is_im');
    const isMpim = readSlackBoolean(channel, 'is_mpim');
    const isPrivate = readSlackBoolean(channel, 'is_private');
    const isGroup = readSlackBoolean(channel, 'is_group');

    const type = isIm === true
      ? 'im'
      : isMpim === true
        ? 'mpim'
        : (isPrivate === true || isGroup === true)
          ? 'private_channel'
          : 'channel';

    const info: SlackChannelInfo = {
      id: channelId,
      name: readSlackString(channel, 'name') || channelId,
      type,
    };
    cache.set(channelId, info);
    slackChannelNameCache.set(channelId, info.name);
    return info;
  } catch (error) {
    debugSlackLog('Failed to get Slack channel info', { channelId, error: getErrorMessage(error) });
    return { id: channelId, name: channelId, type: 'channel' };
  }
}

export async function getSlackChannelName(channelId: string): Promise<string> {
  const cached = slackChannelNameCache.get(channelId);
  if (cached) return cached;
  const info = await getSlackChannelInfo(channelId);
  return info.name;
}

export function shouldAcceptSlackChannel(channelId: string, channelType: string | undefined): boolean {
  const normalizedType = channelType ?? (channelId.startsWith('D') ? 'im' : 'channel');

  // Always accept DMs and MPIMs
  if (normalizedType === 'im' || normalizedType === 'mpim') {
    return true;
  }

  // Accept all channels by default - no filtering is currently configured
  return true;
}

export function clearPendingChannelRequests(): void {
  pendingChannelInfoRequests = new Map();
}
