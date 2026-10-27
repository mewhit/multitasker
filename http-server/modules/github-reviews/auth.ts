import { randomBytes } from 'node:crypto';
import {
  GITHUB_AUTHORIZE_URL,
  GITHUB_CLIENT_ID_ENV,
  GITHUB_CLIENT_SECRET_ENV,
  GITHUB_REDIRECT_URI_ENV,
  GITHUB_TOKEN_ENV,
  GITHUB_TOKEN_URL,
  HOST,
  PORT,
} from '../../core/constants';
import { getServerEnvValue } from '../../core/env';
import { isRecord, readStringField } from '../../utils/payload';
import { fetchGitHubViewer } from './client';
import { getGitHubConnection, setGitHubConnection } from './state';
import type { GitHubConnectionState, GitHubOAuthConfig } from './types';

const GITHUB_OAUTH_SCOPES = ['notifications', 'read:user'];
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const pendingOAuthStates = new Map<string, number>();

export function getGitHubOAuthConfig(): GitHubOAuthConfig {
  return {
    clientId: getServerEnvValue(GITHUB_CLIENT_ID_ENV),
    clientSecret: getServerEnvValue(GITHUB_CLIENT_SECRET_ENV),
    redirectUri: getServerEnvValue(GITHUB_REDIRECT_URI_ENV) || `http://${HOST}:${PORT}/api/github/oauth/callback`,
  };
}

export function isGitHubOAuthConfigured(): boolean {
  const config = getGitHubOAuthConfig();
  return Boolean(config.clientId && config.clientSecret && config.redirectUri);
}

export function hasGitHubTokenFallback(): boolean {
  return Boolean(getServerEnvValue(GITHUB_TOKEN_ENV));
}

export function getAuthorizedGitHubToken(): string {
  return getGitHubConnection()?.accessToken || getServerEnvValue(GITHUB_TOKEN_ENV);
}

export function createGitHubAuthorizationUrl(): string {
  const config = requireGitHubOAuthConfig();
  pruneExpiredOAuthStates();
  const state = randomBytes(32).toString('base64url');
  pendingOAuthStates.set(state, Date.now() + OAUTH_STATE_TTL_MS);

  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', GITHUB_OAUTH_SCOPES.join(' '));
  url.searchParams.set('state', state);
  return url.toString();
}

export async function completeGitHubAuthorization(code: string, state: string): Promise<GitHubConnectionState> {
  if (!consumeOAuthState(state)) throw new Error('Invalid or expired GitHub OAuth state');
  if (!code.trim()) throw new Error('Missing GitHub OAuth authorization code');
  const config = requireGitHubOAuthConfig();
  const response = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code: code.trim(),
      redirect_uri: config.redirectUri,
    }),
  });
  const rawBody = await response.text();
  const payload = parseJsonResponseBody(rawBody);
  if (!response.ok || !isRecord(payload)) {
    throw new Error(`GitHub token request failed (${response.status}): ${readGitHubError(payload, rawBody)}`);
  }
  const accessToken = readStringField(payload, 'access_token').trim();
  if (!accessToken) throw new Error(`GitHub did not return an access token: ${readGitHubError(payload, rawBody)}`);
  const viewer = await fetchGitHubViewer(accessToken);
  const connection: GitHubConnectionState = {
    accessToken,
    tokenType: readStringField(payload, 'token_type').trim() || 'bearer',
    scope: readStringField(payload, 'scope').trim(),
    login: viewer.login,
    avatarUrl: viewer.avatarUrl,
    profileUrl: viewer.profileUrl,
    connectedAt: Date.now(),
  };
  setGitHubConnection(connection);
  return connection;
}

function requireGitHubOAuthConfig(): GitHubOAuthConfig {
  const config = getGitHubOAuthConfig();
  if (!config.clientId) throw new Error(`${GITHUB_CLIENT_ID_ENV} is required`);
  if (!config.clientSecret) throw new Error(`${GITHUB_CLIENT_SECRET_ENV} is required`);
  return config;
}

function consumeOAuthState(state: string): boolean {
  const expiresAt = pendingOAuthStates.get(state);
  pendingOAuthStates.delete(state);
  return expiresAt !== undefined && expiresAt >= Date.now();
}

function pruneExpiredOAuthStates(): void {
  const now = Date.now();
  for (const [state, expiresAt] of pendingOAuthStates) {
    if (expiresAt < now) pendingOAuthStates.delete(state);
  }
}

function parseJsonResponseBody(rawBody: string): unknown {
  if (!rawBody.trim()) return {};
  try {
    return JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
}

function readGitHubError(payload: unknown, rawBody: string): string {
  if (isRecord(payload)) {
    const description = readStringField(payload, 'error_description').trim();
    if (description) return description;
    const error = readStringField(payload, 'error').trim();
    if (error) return error;
    const message = readStringField(payload, 'message').trim();
    if (message) return message;
  }
  return rawBody.trim() || 'Unknown GitHub API error';
}
