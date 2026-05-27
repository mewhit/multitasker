import { getSlackAuthedUserId, slackUserNameCache, slackBotNameCache } from '../../state/slack';
import { getSlackUserToken, getSlackBotToken, getSlackWebApiToken } from './env';
import { slackApiWithFallback } from './api';
import { readSlackRecord, readSlackString, isRawSlackId } from './parse';
import { debugSlackLog } from './debug';
import { getErrorMessage } from '../../core/util';

let pendingUserNameRequests: Map<string, Promise<string>> = new Map();
let pendingBotNameRequests: Map<string, Promise<string>> = new Map();

export async function getSlackUserName(userId: string): Promise<string> {
  if (!isRawSlackId(userId)) return userId;
  const cached = slackUserNameCache.get(userId);
  if (cached !== undefined) return cached;

  const pending = pendingUserNameRequests.get(userId);
  if (pending) return pending;

  const promise = resolveSlackUserName(userId);
  pendingUserNameRequests.set(userId, promise);
  try {
    return await promise;
  } finally {
    pendingUserNameRequests.delete(userId);
  }
}

async function resolveSlackUserName(userId: string): Promise<string> {
  const token = getSlackWebApiToken();
  if (!token) return userId;

  try {
    const response = await slackApiWithFallback('users.info', [getSlackUserToken(), getSlackBotToken()], {
      user: userId,
    });
    const user = readSlackRecord(response, 'user');
    const displayName = readSlackString(user, 'real_name')
      || readSlackString(readSlackRecord(user, 'profile'), 'display_name')
      || readSlackString(user, 'name')
      || userId;
    slackUserNameCache.set(userId, displayName);
    return displayName;
  } catch (error) {
    debugSlackLog('Failed to get Slack user name', { userId, error: getErrorMessage(error) });
    slackUserNameCache.set(userId, userId);
    return userId;
  }
}

export async function getSlackBotName(botId: string): Promise<string> {
  const cached = slackBotNameCache.get(botId);
  if (cached !== undefined) return cached;

  const pending = pendingBotNameRequests.get(botId);
  if (pending) return pending;

  const promise = resolveSlackBotName(botId);
  pendingBotNameRequests.set(botId, promise);
  try {
    return await promise;
  } finally {
    pendingBotNameRequests.delete(botId);
  }
}

async function resolveSlackBotName(botId: string): Promise<string> {
  const token = getSlackWebApiToken();
  if (!token) return botId;

  try {
    const response = await slackApiWithFallback('bots.info', [getSlackUserToken(), getSlackBotToken()], {
      bot: botId,
    });
    const bot = readSlackRecord(response, 'bot');
    const name = readSlackString(bot, 'name') || botId;
    slackBotNameCache.set(botId, name);
    return name;
  } catch (error) {
    debugSlackLog('Failed to get Slack bot name', { botId, error: getErrorMessage(error) });
    slackBotNameCache.set(botId, botId);
    return botId;
  }
}

export async function getSlackMessageSenderName(event: Record<string, unknown>): Promise<string> {
  const userId = readSlackString(event, 'user');
  if (userId) return getSlackUserName(userId);
  const botId = readSlackString(event, 'bot_id');
  if (botId) return getSlackBotName(botId);
  return '';
}

export function isSlackMessageFromCurrentUser(event: Record<string, unknown>): boolean {
  const userId = readSlackString(event, 'user');
  const authedUserId = getSlackAuthedUserId();
  return !!(authedUserId && userId === authedUserId);
}

export function clearPendingNameRequests(): void {
  pendingUserNameRequests = new Map();
  pendingBotNameRequests = new Map();
}
