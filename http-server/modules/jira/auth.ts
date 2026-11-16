import { randomBytes } from 'node:crypto';
import {
  HOST,
  JIRA_ACCESSIBLE_RESOURCES_URL,
  JIRA_AUTHORIZE_URL,
  JIRA_CLIENT_ID_ENV,
  JIRA_CLIENT_SECRET_ENV,
  JIRA_REDIRECT_URI_ENV,
  JIRA_SITE_URL_ENV,
  JIRA_TOKEN_URL,
  PORT,
} from '../../core/constants';
import { getServerEnvValue } from '../../core/env';
import { isRecord, readStringField } from '../../utils/payload';
import { getJiraConnection, setJiraConnection } from './state';
import type { JiraConnectionState, JiraOAuthConfig, JiraResource } from './types';

const JIRA_OAUTH_SCOPES = ['read:jira-work', 'offline_access'];
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000;
const pendingOAuthStates = new Map<string, number>();

interface JiraTokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
}

export function getJiraOAuthConfig(): JiraOAuthConfig {
  return {
    clientId: getServerEnvValue(JIRA_CLIENT_ID_ENV),
    clientSecret: getServerEnvValue(JIRA_CLIENT_SECRET_ENV),
    redirectUri: getServerEnvValue(JIRA_REDIRECT_URI_ENV) || `http://${HOST}:${PORT}/api/jira/oauth/callback`,
    preferredSiteUrl: normalizeSiteUrl(getServerEnvValue(JIRA_SITE_URL_ENV)),
  };
}

export function isJiraOAuthConfigured(): boolean {
  const config = getJiraOAuthConfig();
  return Boolean(config.clientId && config.clientSecret && config.redirectUri);
}

export function createJiraAuthorizationUrl(): string {
  const config = requireJiraOAuthConfig();
  pruneExpiredOAuthStates();
  const state = randomBytes(32).toString('base64url');
  pendingOAuthStates.set(state, Date.now() + OAUTH_STATE_TTL_MS);

  const url = new URL(JIRA_AUTHORIZE_URL);
  url.searchParams.set('audience', 'api.atlassian.com');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('scope', JIRA_OAUTH_SCOPES.join(' '));
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

export async function completeJiraAuthorization(code: string, state: string): Promise<JiraConnectionState> {
  if (!consumeOAuthState(state)) throw new Error('Invalid or expired Jira OAuth state');
  if (!code.trim()) throw new Error('Missing Jira OAuth authorization code');

  const config = requireJiraOAuthConfig();
  const token = await requestJiraToken({
    grant_type: 'authorization_code',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code: code.trim(),
    redirect_uri: config.redirectUri,
  });
  if (!token.refreshToken) {
    throw new Error('Atlassian did not return a refresh token; ensure offline_access is enabled');
  }

  const resources = await fetchAccessibleJiraResources(token.accessToken);
  const resource = selectJiraResource(resources, config.preferredSiteUrl);
  const connection: JiraConnectionState = {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: Date.now() + token.expiresIn * 1000,
    scope: token.scope,
    cloudId: resource.id,
    siteName: resource.name,
    siteUrl: normalizeSiteUrl(resource.url),
    connectedAt: Date.now(),
  };
  setJiraConnection(connection);
  return connection;
}

export async function getAuthorizedJiraConnection(forceRefresh = false): Promise<JiraConnectionState> {
  const connection = getJiraConnection();
  if (!connection) throw new Error('Jira is not connected');
  if (!forceRefresh && connection.expiresAt > Date.now() + TOKEN_EXPIRY_MARGIN_MS) return connection;
  return refreshJiraConnection(connection);
}

async function refreshJiraConnection(connection: JiraConnectionState): Promise<JiraConnectionState> {
  const config = requireJiraOAuthConfig();
  const token = await requestJiraToken({
    grant_type: 'refresh_token',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: connection.refreshToken,
  });
  const refreshed: JiraConnectionState = {
    ...connection,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken || connection.refreshToken,
    expiresAt: Date.now() + token.expiresIn * 1000,
    scope: token.scope || connection.scope,
  };
  setJiraConnection(refreshed);
  return refreshed;
}

async function requestJiraToken(body: Record<string, string>): Promise<JiraTokenResponse> {
  const response = await fetch(JIRA_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const rawBody = await response.text();
  const payload = parseJsonResponseBody(rawBody);
  if (!response.ok || !isRecord(payload)) {
    throw new Error(`Atlassian token request failed (${response.status}): ${readAtlassianError(payload, rawBody)}`);
  }

  const accessToken = readStringField(payload, 'access_token').trim();
  const refreshToken = readStringField(payload, 'refresh_token').trim();
  const scope = readStringField(payload, 'scope').trim();
  const expiresInValue = payload['expires_in'];
  const expiresIn = typeof expiresInValue === 'number' && Number.isFinite(expiresInValue)
    ? Math.max(1, expiresInValue)
    : 3600;
  if (!accessToken) throw new Error('Atlassian token response did not contain an access token');
  return { accessToken, refreshToken, expiresIn, scope };
}

async function fetchAccessibleJiraResources(accessToken: string): Promise<JiraResource[]> {
  const response = await fetch(JIRA_ACCESSIBLE_RESOURCES_URL, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const rawBody = await response.text();
  const payload = parseJsonResponseBody(rawBody);
  if (!response.ok || !Array.isArray(payload)) {
    throw new Error(`Atlassian accessible-resources failed (${response.status}): ${readAtlassianError(payload, rawBody)}`);
  }
  return payload.map(normalizeJiraResource).filter((resource): resource is JiraResource => resource !== null);
}

function selectJiraResource(resources: JiraResource[], preferredSiteUrl: string): JiraResource {
  const readableResources = resources.filter(resource => resource.scopes.includes('read:jira-work'));
  if (preferredSiteUrl) {
    const match = readableResources.find(resource => normalizeSiteUrl(resource.url).toLowerCase() === preferredSiteUrl.toLowerCase());
    if (match) return match;
    throw new Error(`${JIRA_SITE_URL_ENV} does not match an authorized Jira site`);
  }
  if (readableResources.length === 1) return readableResources[0]!;
  if (readableResources.length === 0) throw new Error('No Jira site with read:jira-work access was authorized');
  throw new Error(`Multiple Jira sites were authorized; set ${JIRA_SITE_URL_ENV} to select one`);
}

function normalizeJiraResource(value: unknown): JiraResource | null {
  if (!isRecord(value)) return null;
  const id = readStringField(value, 'id').trim();
  const name = readStringField(value, 'name').trim();
  const url = readStringField(value, 'url').trim();
  const rawScopes = value['scopes'];
  const scopes = Array.isArray(rawScopes)
    ? rawScopes.filter((scope): scope is string => typeof scope === 'string').map(scope => scope.trim()).filter(Boolean)
    : [];
  return id && url ? { id, name, url, scopes } : null;
}

function requireJiraOAuthConfig(): JiraOAuthConfig {
  const config = getJiraOAuthConfig();
  if (!config.clientId) throw new Error(`${JIRA_CLIENT_ID_ENV} is required`);
  if (!config.clientSecret) throw new Error(`${JIRA_CLIENT_SECRET_ENV} is required`);
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

function normalizeSiteUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function parseJsonResponseBody(rawBody: string): unknown {
  if (!rawBody.trim()) return {};
  try {
    return JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
}

function readAtlassianError(payload: unknown, rawBody: string): string {
  if (isRecord(payload)) {
    const description = readStringField(payload, 'error_description').trim();
    if (description) return description;
    const error = readStringField(payload, 'error').trim();
    if (error) return error;
    const messages = payload['errorMessages'];
    if (Array.isArray(messages)) {
      const message = messages.find((value): value is string => typeof value === 'string' && Boolean(value.trim()));
      if (message) return message.trim();
    }
  }
  return rawBody.trim() || 'Unknown Atlassian API error';
}
