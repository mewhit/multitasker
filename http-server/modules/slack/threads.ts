import { getSlackAuthedUserId, slackThreadWrittenByAuthedUser } from '../../state/slack';
import { getSlackUserToken, getSlackBotToken, getSlackWebApiToken } from './env';
import { slackApiWithFallback } from './api';
import { readSlackRecord, readSlackString } from './parse';
import { debugSlackLog } from './debug';
import { getErrorMessage } from '../../core/util';

export function rememberSlackAuthedUserThread(event: Record<string, unknown>): void {
  const eventUserId = readSlackString(event, 'user');
  const authedUserId = getSlackAuthedUserId();
  if (!authedUserId || eventUserId !== authedUserId) return;

  const channelId = readSlackString(event, 'channel');
  const ts = readSlackString(event, 'ts') || readSlackString(event, 'event_ts');
  const threadTs = readSlackString(event, 'thread_ts') || ts;
  if (!channelId || !threadTs) return;

  slackThreadWrittenByAuthedUser.set(getSlackThreadKey(channelId, threadTs), true);
}

export async function isSlackThreadWrittenByAuthedUser(
  channelId: string,
  threadTs: string,
  event: Record<string, unknown>
): Promise<boolean> {
  const authedUserId = getSlackAuthedUserId();
  if (!channelId || !threadTs || !authedUserId) return false;

  const cacheKey = getSlackThreadKey(channelId, threadTs);
  const cached = slackThreadWrittenByAuthedUser.get(cacheKey);
  if (cached !== undefined) return cached;

  if (readSlackString(event, 'parent_user_id') === authedUserId) {
    slackThreadWrittenByAuthedUser.set(cacheKey, true);
    return true;
  }

  if (!getSlackWebApiToken()) return false;

  try {
    const response = await slackApiWithFallback('conversations.replies', [getSlackUserToken(), getSlackBotToken()], {
      channel: channelId,
      ts: threadTs,
      limit: 200,
    });
    const messages = Array.isArray(response['messages']) ? response['messages'] : [];
    const wroteThread = messages.some(message => {
      const messageRecord = readSlackRecord(message);
      return readSlackString(messageRecord, 'user') === authedUserId;
    });
    slackThreadWrittenByAuthedUser.set(cacheKey, wroteThread);
    return wroteThread;
  } catch (error) {
    debugSlackLog('Could not inspect Slack thread participation', {
      channelId,
      threadTs,
      error: getErrorMessage(error),
    });
    return false;
  }
}

export function getSlackThreadKey(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}
