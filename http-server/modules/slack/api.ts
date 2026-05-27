import { WebClient } from '@slack/web-api';
import { getErrorMessage } from '../../core/util';
import { slackClientByToken } from '../../state/slack';
import { readSlackRecord, readSlackString, readSlackStringArray } from './parse';

export async function slackApi(
  method: string,
  token: string,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const trimmedToken = token.trim();
  if (!trimmedToken) throw new Error(`${method} failed: missing Slack token`);

  try {
    const response: unknown = await getSlackClient(trimmedToken).apiCall(method, payload);
    const responseRecord = readSlackRecord(response);
    if (!responseRecord) throw new Error('Slack returned an invalid response');
    return responseRecord;
  } catch (error) {
    throw new Error(formatSlackApiError(method, error));
  }
}

export function getSlackClient(token: string): WebClient {
  const cachedClient = slackClientByToken.get(token);
  if (cachedClient) return cachedClient;

  const client = new WebClient(token);
  slackClientByToken.set(token, client);
  return client;
}

export function formatSlackApiError(method: string, error: unknown): string {
  const errorRecord = readSlackRecord(error);
  const data = errorRecord ? readSlackRecord(errorRecord, 'data') : undefined;
  if (data) {
    const details = [
      readSlackString(data, 'error'),
      readSlackString(data, 'needed') ? `needed=${readSlackString(data, 'needed')}` : '',
      readSlackString(data, 'provided') ? `provided=${readSlackString(data, 'provided')}` : '',
    ].filter(Boolean);

    details.push(...readSlackStringArray(readSlackRecord(data, 'response_metadata'), 'messages'));
    if (details.length > 0) return `${method} failed: ${details.join('; ')}`;
  }

  return `${method} failed: ${getErrorMessage(error)}`;
}

export async function slackApiWithFallback(
  method: string,
  tokens: string[],
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const usableTokens = tokens.filter(token => token.trim());
  let lastError: unknown;
  for (const token of usableTokens) {
    try {
      return await slackApi(method, token, payload);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error(`${method} failed: missing Slack token`);
}
