import fs from 'node:fs';
import path from 'node:path';
import { SLACK_ENV_RELATIVE_PATH } from '../../core/constants';
import { readEnvFile } from '../../core/env';
import {
  getSlackApiEnv,
  setSlackApiEnv,
  getSlackApiEnvFingerprint,
  setSlackApiEnvFingerprint,
  setSlackAuthedUserId,
  setSlackAuthedUserConversationIds,
  setSlackAuthedUserConversationsLoadedAt,
  slackUserNameById,
  slackBotNameById,
  slackChannelInfoById,
  slackClientByToken,
  slackThreadWrittenByAuthedUser,
} from '../../state/slack';

export function refreshSlackApiEnvFromDisk(): void {
  const nextEnv = readSlackEnvFromDisk();
  const fingerprint = JSON.stringify(nextEnv);
  if (fingerprint === getSlackApiEnvFingerprint()) return;
  setSlackApiEnvFingerprint(fingerprint);
  resetSlackApiState(nextEnv);
}

function readSlackEnvFromDisk(): Record<string, string> {
  const candidates = [
    path.join(process.cwd(), SLACK_ENV_RELATIVE_PATH),
    path.join(__dirname, '..', '..', SLACK_ENV_RELATIVE_PATH),
  ];
  const envPath = candidates.find(candidate => fs.existsSync(candidate));
  return envPath ? readEnvFile(envPath) : {};
}

function resetSlackApiState(nextSlackEnv: Record<string, string>): void {
  setSlackApiEnv(nextSlackEnv);
  slackUserNameById.clear();
  slackBotNameById.clear();
  slackChannelInfoById.clear();
  slackClientByToken.clear();
  slackThreadWrittenByAuthedUser.clear();
  setSlackAuthedUserId(getSlackApiEnvValue('SLACK_USER_ID'));
  setSlackAuthedUserConversationIds(undefined);
  setSlackAuthedUserConversationsLoadedAt(0);
}

export function getSlackApiEnvValue(key: string): string {
  const processValue = process.env[key];
  if (typeof processValue === 'string' && processValue.trim()) return processValue.trim();

  const envValue = getSlackApiEnv()[key];
  return typeof envValue === 'string' ? envValue.trim() : '';
}

export function getSlackUserToken(): string {
  return getSlackApiEnvValue('SLACK_USER_TOKEN');
}

export function getSlackBotToken(): string {
  return getSlackApiEnvValue('SLACK_BOT_TOKEN');
}

export function getSlackWebApiToken(): string {
  return getSlackUserToken() || getSlackBotToken();
}

export function isSlackOnlyUserChannelsEnabled(): boolean {
  return getSlackApiEnvValue('SLACK_ONLY_USER_CHANNELS') !== '0';
}

export function getSlackClientId(): string {
  return getSlackApiEnvValue('SLACK_CLIENT_ID');
}

export function getSlackClientSecret(): string {
  return getSlackApiEnvValue('SLACK_CLIENT_SECRET');
}

export function getSlackAppLevelToken(): string {
  return getSlackApiEnvValue('SLACK_APP_TOKEN');
}

export function clearSlackEnvCache(): void {
  setSlackApiEnvFingerprint('');
}
