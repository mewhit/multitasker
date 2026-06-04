import type { HttpModule, RouteDef, RouteContext } from '../../core/types';
import { readJsonBody, writeJsonResponse } from '../../core/body';
import { slackNotifications } from '../../state/tasks';
import { getSlackTeamId, setSlackAuthedUserId, setSlackTeamId, slackTeamNameCache } from '../../state/slack';
import { cloneSlackNotification } from '../../utils/clone';
import { refreshSlackApiEnvFromDisk, getSlackUserToken, getSlackBotToken, getSlackClientId, getSlackClientSecret, getSlackAppLevelToken, getSlackWebApiToken } from './env';
import { getSlackClient } from './api';
import { parseSlackNotificationRequest, parseSlackNotificationDismissRequest, readSlackRecord, readSlackString } from './parse';
import { handleSlackEventEnvelope } from './events';
import { handleSlackNotification, dismissSlackNotification } from './notifications';
import { broadcastSlackListUpdate } from './broadcast';
import { debugSlackLog } from './debug';
import { getErrorMessage } from '../../core/util';

let slackSocketModeEnabled = false;

export const slackModule: HttpModule = {
  name: 'slack',
  routes: getSlackRoutes,

  async init() {
    await refreshSlackApiEnvFromDisk();
    if (getSlackAppLevelToken()) {
      await startSlackSocketMode();
    }
  },

  async dispose() {
    await stopSlackSocketMode();
  },
};

function getSlackRoutes(): RouteDef[] {
  return [
    {
      method: 'GET',
      path: '/api/slack/notifications',
      handler: handleGetSlackNotifications,
    },
    {
      method: 'POST',
      path: '/api/slack/notifications',
      handler: handlePostSlackNotification,
    },
    {
      method: 'POST',
      path: '/api/slack/notifications/dismiss',
      handler: handleDismissSlackNotification,
    },
    {
      method: 'POST',
      path: '/api/slack/events',
      handler: handleSlackEvents,
    },
    {
      method: 'GET',
      path: '/api/slack/oauth/config',
      handler: handleGetSlackOAuthConfig,
    },
    {
      method: 'POST',
      path: '/api/slack/oauth/token',
      handler: handlePostSlackOAuthToken,
    },
    {
      method: 'GET',
      path: '/api/slack/auth/test',
      handler: handleSlackAuthTest,
    },
  ];
}

async function handleGetSlackNotifications(ctx: RouteContext): Promise<void> {
  writeJsonResponse(ctx.response, 200, { ok: true, slackNotifications: slackNotifications.map(cloneSlackNotification) });
}

async function handlePostSlackNotification(ctx: RouteContext): Promise<void> {
  const body = await readJsonBody(ctx.request);
  const notification = parseSlackNotificationRequest(body);
  if (!notification) {
    writeJsonResponse(ctx.response, 400, { error: 'Invalid notification payload' });
    return;
  }
  handleSlackNotification(notification);
  writeJsonResponse(ctx.response, 200, { ok: true });
}

async function handleDismissSlackNotification(ctx: RouteContext): Promise<void> {
  const body = await readJsonBody(ctx.request);
  const request = parseSlackNotificationDismissRequest(body);
  if (!request) {
    writeJsonResponse(ctx.response, 400, { error: 'Invalid dismiss request' });
    return;
  }
  const dismissed = dismissSlackNotification(request);
  writeJsonResponse(ctx.response, 200, { ok: true, dismissed });
}

async function handleSlackEvents(ctx: RouteContext): Promise<void> {
  const body = await readJsonBody(ctx.request);
  const response = await handleSlackEventEnvelope(body);
  writeJsonResponse(ctx.response, 200, response);
}

async function handleGetSlackOAuthConfig(ctx: RouteContext): Promise<void> {
  await refreshSlackApiEnvFromDisk();
  const clientId = getSlackClientId();
  const clientSecret = getSlackClientSecret();
  const hasCredentials = !!(clientId && clientSecret);
  writeJsonResponse(ctx.response, 200, {
    hasCredentials,
    clientId: hasCredentials ? clientId : undefined,
  });
}

async function handlePostSlackOAuthToken(ctx: RouteContext): Promise<void> {
  const body = await readJsonBody(ctx.request);
  const record = readSlackRecord(body);
  const code = readSlackString(record, 'code');
  const redirectUri = readSlackString(record, 'redirectUri') || undefined;

  if (!code) {
    writeJsonResponse(ctx.response, 400, { error: 'Missing code' });
    return;
  }

  await refreshSlackApiEnvFromDisk();
  const clientId = getSlackClientId();
  const clientSecret = getSlackClientSecret();

  if (!clientId || !clientSecret) {
    writeJsonResponse(ctx.response, 400, { error: 'Slack OAuth not configured' });
    return;
  }

  try {
    const token = getSlackWebApiToken();
    if (!token) {
      writeJsonResponse(ctx.response, 400, { error: 'No Slack token configured for OAuth' });
      return;
    }
    const client = getSlackClient(token);
    const oauthArgs = {
      client_id: clientId,
      client_secret: clientSecret,
      code,
      ...(redirectUri ? { redirect_uri: redirectUri } : {}),
    };
    const result = await client.oauth.v2.access(oauthArgs);

    const userId = readSlackString(readSlackRecord(result.authed_user), 'id');
    const teamId = result.team?.id;
    const teamName = result.team?.name;

    if (userId) setSlackAuthedUserId(userId);
    if (teamId) {
      setSlackTeamId(teamId);
      if (teamName) slackTeamNameCache.set(teamId, teamName);
    }

    writeJsonResponse(ctx.response, 200, {
      ok: true,
      userId,
      teamId,
      teamName,
      accessToken: result.access_token,
      botToken: result.access_token,
      userToken: readSlackString(readSlackRecord(result.authed_user), 'access_token'),
    });
  } catch (error) {
    debugSlackLog('OAuth token exchange failed', { error: getErrorMessage(error) });
    writeJsonResponse(ctx.response, 400, { error: getErrorMessage(error) });
  }
}

async function handleSlackAuthTest(ctx: RouteContext): Promise<void> {
  await refreshSlackApiEnvFromDisk();
  const userToken = getSlackUserToken();
  const botToken = getSlackBotToken();

  if (!userToken && !botToken) {
    writeJsonResponse(ctx.response, 200, { ok: false, error: 'No Slack tokens configured' });
    return;
  }

  try {
    const client = getSlackClient(userToken || botToken);
    const result = await client.auth.test();

    const userId = result.user_id;
    const teamId = result.team_id;
    const teamName = result.team;

    if (userId) setSlackAuthedUserId(userId);
    if (teamId) {
      setSlackTeamId(teamId);
      if (teamName) slackTeamNameCache.set(teamId, teamName);
    }

    writeJsonResponse(ctx.response, 200, {
      ok: true,
      userId,
      userName: result.user,
      teamId,
      teamName,
    });
  } catch (error) {
    debugSlackLog('Auth test failed', { error: getErrorMessage(error) });
    writeJsonResponse(ctx.response, 200, { ok: false, error: getErrorMessage(error) });
  }
}

async function startSlackSocketMode(): Promise<void> {
  if (slackSocketModeEnabled) return;

  const appToken = getSlackAppLevelToken();
  const botToken = getSlackBotToken();

  if (!appToken || !botToken) {
    debugSlackLog('Slack Socket Mode not started', { reason: 'missing_tokens' });
    return;
  }

  try {
    // @slack/bolt is an optional dependency for Socket Mode support
    // Dynamic import with error handling for missing module
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const bolt: { App: new (config: { token: string; appToken: string; socketMode: boolean }) => {
      event(name: string, handler: (ctx: { event: unknown }) => Promise<void>): void;
      start(): Promise<void>;
    } } | null = await (async () => {
      try {
        return await import('@slack/bolt' as string) as typeof bolt;
      } catch {
        return null;
      }
    })();
    if (!bolt) {
      debugSlackLog('Slack Socket Mode not available', { reason: 'bolt_not_installed' });
      return;
    }
    const app = new bolt.App({
      token: botToken,
      appToken,
      socketMode: true,
    });

    app.event('message', async ({ event }: { event: unknown }) => {
      try {
        const eventRecord = event as Record<string, unknown>;
        await handleSlackEventEnvelope({
          type: 'event_callback',
          team_id: getSlackTeamId(),
          event: eventRecord,
        });
      } catch (error) {
        debugSlackLog('Socket mode message handling failed', { error: getErrorMessage(error) });
      }
    });

    await app.start();
    slackSocketModeEnabled = true;
    debugSlackLog('Slack Socket Mode started');
  } catch (error) {
    debugSlackLog('Failed to start Slack Socket Mode', { error: getErrorMessage(error) });
  }
}

async function stopSlackSocketMode(): Promise<void> {
  if (!slackSocketModeEnabled) return;
  slackSocketModeEnabled = false;
  debugSlackLog('Slack Socket Mode stopped');
}

export { broadcastSlackListUpdate };
