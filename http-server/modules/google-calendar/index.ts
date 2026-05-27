import type { HttpModule, RouteDef } from '../../core/types';
import type { GoogleCalendarOAuthConfig } from '../../types';
import { writeJsonResponse } from '../../core/body';
import { getServerEnvValue } from '../../core/env';
import { getErrorMessage } from '../../core/util';
import { GOOGLE_CALENDAR_CLIENT_ID_ENV, GOOGLE_CALENDAR_CLIENT_SECRET_ENV, GOOGLE_CALENDAR_TOKEN_URL } from '../../core/constants';
import { isRecord, readStringField } from '../../utils/payload';

export const googleCalendarModule: HttpModule = {
  name: 'google-calendar',
  routes(): RouteDef[] {
    return [
      {
        method: 'GET',
        path: '/api/google-calendar/oauth-config',
        handler({ response }) {
          const config = getGoogleCalendarOAuthConfig();
          writeJsonResponse(response, 200, {
            ok: true,
            configured: Boolean(config.clientId),
            clientId: config.clientId,
            hasClientSecret: Boolean(config.clientSecret),
          });
        },
      },
      {
        method: 'POST',
        path: '/api/google-calendar/token',
        async handler({ payload, response }) {
          const tokenRequest = parseGoogleCalendarTokenRequest(payload);
          if (!tokenRequest) {
            writeJsonResponse(response, 400, { ok: false, error: 'invalid_google_calendar_token_request' });
            return;
          }

          const config = getGoogleCalendarOAuthConfig();
          if (!config.clientId) {
            writeJsonResponse(response, 400, { ok: false, error: `${GOOGLE_CALENDAR_CLIENT_ID_ENV} is required` });
            return;
          }

          const body = new URLSearchParams(tokenRequest);
          body.set('client_id', config.clientId);
          if (config.clientSecret) body.set('client_secret', config.clientSecret);

          try {
            const tokenResponse = await fetch(GOOGLE_CALENDAR_TOKEN_URL, {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: body.toString(),
            });
            const rawBody = await tokenResponse.text();
            const payloadBody = parseJsonResponseBody(rawBody);
            if (!tokenResponse.ok) {
              writeJsonResponse(response, tokenResponse.status, {
                ok: false,
                error: getGoogleApiErrorMessage(payloadBody, rawBody),
              });
              return;
            }
            writeJsonResponse(response, 200, { ok: true, token: payloadBody });
          } catch (error) {
            writeJsonResponse(response, 502, { ok: false, error: getErrorMessage(error) });
          }
        },
      },
    ];
  },
};

function getGoogleCalendarOAuthConfig(): GoogleCalendarOAuthConfig {
  return {
    clientId: getServerEnvValue(GOOGLE_CALENDAR_CLIENT_ID_ENV),
    clientSecret: getServerEnvValue(GOOGLE_CALENDAR_CLIENT_SECRET_ENV),
  };
}

function parseGoogleCalendarTokenRequest(payload: unknown): Record<string, string> | null {
  if (!isRecord(payload)) return null;
  const grantType = readStringField(payload, 'grant_type').trim();
  if (grantType !== 'authorization_code' && grantType !== 'refresh_token') return null;

  const tokenRequest: Record<string, string> = { grant_type: grantType };
  for (const key of ['code', 'redirect_uri', 'code_verifier', 'refresh_token']) {
    const value = readStringField(payload, key).trim();
    if (value) tokenRequest[key] = value;
  }

  if (grantType === 'authorization_code') {
    return tokenRequest['code'] && tokenRequest['redirect_uri'] && tokenRequest['code_verifier']
      ? tokenRequest
      : null;
  }

  return tokenRequest['refresh_token'] ? tokenRequest : null;
}

function parseJsonResponseBody(rawBody: string): unknown {
  if (!rawBody.trim()) return {};
  try {
    return JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
}

function getGoogleApiErrorMessage(payload: unknown, rawBody: string): string {
  if (isRecord(payload)) {
    const error = payload['error'];
    if (typeof error === 'string' && error.trim()) return error.trim();
    if (isRecord(error)) {
      const message = readStringField(error, 'message').trim();
      if (message) return message;
    }
    const errorDescription = readStringField(payload, 'error_description').trim();
    if (errorDescription) return errorDescription;
  }
  return rawBody.trim() || 'Unknown Google API error';
}
