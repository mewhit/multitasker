import type { ServerResponse } from 'node:http';
import type { HttpModule, RouteDef } from '../../core/types';
import { writeJsonResponse } from '../../core/body';
import { getErrorMessage } from '../../core/util';
import {
  completeGitHubAuthorization,
  createGitHubAuthorizationUrl,
  hasGitHubTokenFallback,
  isGitHubOAuthConfigured,
} from './auth';
import {
  getGitHubPollMinutes,
  pollGitHubReviewRequests,
  startGitHubReviewScheduler,
  stopGitHubReviewScheduler,
} from './scheduler';
import {
  clearGitHubConnection,
  getGitHubConnection,
  getGitHubPollingStatus,
  loadGitHubState,
} from './state';

export { startGitHubReviewScheduler } from './scheduler';

export const githubReviewsModule: HttpModule = {
  name: 'github-reviews',
  init() {
    loadGitHubState();
    startGitHubReviewScheduler();
  },
  dispose() {
    stopGitHubReviewScheduler();
  },
  routes(): RouteDef[] {
    return [
      {
        method: 'GET',
        path: '/api/github/status',
        handler({ response }) {
          const connection = getGitHubConnection();
          const tokenFallback = hasGitHubTokenFallback();
          writeJsonResponse(response, 200, {
            ok: true,
            configured: isGitHubOAuthConfigured() || tokenFallback,
            oauthConfigured: isGitHubOAuthConfigured(),
            connected: Boolean(connection) || tokenFallback,
            authMode: connection ? 'oauth' : tokenFallback ? 'token' : null,
            account: connection ? {
              login: connection.login,
              avatarUrl: connection.avatarUrl,
              profileUrl: connection.profileUrl,
            } : null,
            pollMinutes: getGitHubPollMinutes(),
            connectUrl: '/api/github/oauth/start',
            ...getGitHubPollingStatus(),
          });
        },
      },
      {
        method: 'GET',
        path: '/api/github/oauth/start',
        handler({ response }) {
          try {
            response.writeHead(302, { Location: createGitHubAuthorizationUrl() });
            response.end();
          } catch (error) {
            writeJsonResponse(response, 400, { ok: false, error: getErrorMessage(error) });
          }
        },
      },
      {
        method: 'GET',
        path: '/api/github/oauth/callback',
        async handler({ url, response }) {
          const oauthError = url.searchParams.get('error');
          if (oauthError) {
            writeOAuthResult(response, 400, 'GitHub connection failed', url.searchParams.get('error_description') || oauthError);
            return;
          }
          try {
            const connection = await completeGitHubAuthorization(
              url.searchParams.get('code') || '',
              url.searchParams.get('state') || '',
            );
            writeOAuthResult(response, 200, 'GitHub connected', `Connected as ${connection.login}. You can close this window.`);
            void pollGitHubReviewRequests().catch(error => {
              console.error(`Initial GitHub review polling failed: ${getErrorMessage(error)}`);
            });
          } catch (error) {
            writeOAuthResult(response, 400, 'GitHub connection failed', getErrorMessage(error));
          }
        },
      },
      {
        method: 'POST',
        path: '/api/github/poll',
        async handler({ response }) {
          try {
            const result = await pollGitHubReviewRequests();
            writeJsonResponse(response, 200, { ok: true, ...result });
          } catch (error) {
            writeJsonResponse(response, 502, { ok: false, error: getErrorMessage(error) });
          }
        },
      },
      {
        method: 'POST',
        path: '/api/github/disconnect',
        handler({ response }) {
          clearGitHubConnection();
          writeJsonResponse(response, 200, { ok: true });
        },
      },
    ];
  },
};

function writeOAuthResult(response: ServerResponse, statusCode: number, title: string, message: string): void {
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>` +
    `<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
  response.writeHead(statusCode, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
