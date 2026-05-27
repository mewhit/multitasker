import { WebClient } from '@slack/web-api';
import type { SlackChannelInfo } from '../types';

export const slackUserNameById = new Map<string, string>();
export const slackBotNameById = new Map<string, string>();
export const slackChannelInfoById = new Map<string, SlackChannelInfo>();
export const slackClientByToken = new Map<string, WebClient>();
export const slackThreadWrittenByAuthedUser = new Map<string, boolean>();

export const slackUserNameCache = new Map<string, string>();
export const slackBotNameCache = new Map<string, string>();
export const slackChannelNameCache = new Map<string, string>();
export const slackTeamNameCache = new Map<string, string>();

let slackApiEnv: Record<string, string> = {};
let slackApiEnvFingerprint = '';
let slackAuthedUserId = '';
let slackTeamId = '';
let slackAuthedUserConversationIds: Set<string> | undefined;
let slackAuthedUserConversationsLoadedAt = 0;
let slackChannelCache = new Map<string, SlackChannelInfo>();

export function getSlackApiEnv(): Record<string, string> {
  return slackApiEnv;
}

export function setSlackApiEnv(env: Record<string, string>): void {
  slackApiEnv = env;
}

export function getSlackApiEnvFingerprint(): string {
  return slackApiEnvFingerprint;
}

export function setSlackApiEnvFingerprint(fingerprint: string): void {
  slackApiEnvFingerprint = fingerprint;
}

export function getSlackAuthedUserId(): string {
  return slackAuthedUserId;
}

export function setSlackAuthedUserId(id: string): void {
  slackAuthedUserId = id;
}

export function getSlackTeamId(): string {
  return slackTeamId;
}

export function setSlackTeamId(id: string): void {
  slackTeamId = id;
}

export function getSlackAuthedUserConversationIds(): Set<string> | undefined {
  return slackAuthedUserConversationIds;
}

export function setSlackAuthedUserConversationIds(ids: Set<string> | undefined): void {
  slackAuthedUserConversationIds = ids;
}

export function getSlackAuthedUserConversationsLoadedAt(): number {
  return slackAuthedUserConversationsLoadedAt;
}

export function setSlackAuthedUserConversationsLoadedAt(timestamp: number): void {
  slackAuthedUserConversationsLoadedAt = timestamp;
}

export function getSlackChannelCache(): Map<string, SlackChannelInfo> {
  return slackChannelCache;
}

export function clearSlackChannelCache(): void {
  slackChannelCache = new Map();
}
