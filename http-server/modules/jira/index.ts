import type { HttpModule, RouteDef } from '../../core/types';
import { writeJsonResponse } from '../../core/body';
import { getErrorMessage } from '../../core/util';
import {
  completeJiraAuthorization,
  createJiraAuthorizationUrl,
  getJiraOAuthConfig,
  isJiraOAuthConfigured,
} from './auth';
import { getJiraJql, getJiraPollMinutes, pollJiraIssues, startJiraScheduler, stopJiraScheduler } from './scheduler';
import { clearJiraConnection, getJiraConnection, getJiraPollingStatus, loadJiraState } from './state';

export const jiraModule: HttpModule = {
  name: 'jira',
  init() {
    loadJiraState();
    startJiraScheduler();
  },
  dispose() {
    stopJiraScheduler();
  },
  routes(): RouteDef[] {
    return [
      {
        method: 'GET',
        path: '/api/jira/status',
        handler({ response }) {
          const connection = getJiraConnection();
          const config = getJiraOAuthConfig();
          writeJsonResponse(response, 200, {
            ok: true,
            configured: isJiraOAuthConfigured(),
            connected: Boolean(connection),
            site: connection ? {
              cloudId: connection.cloudId,
              name: connection.siteName,
              url: connection.siteUrl,
            } : null,
            preferredSiteUrl: config.preferredSiteUrl,
            jql: getJiraJql(),
            pollMinutes: getJiraPollMinutes(),
            connectUrl: '/api/jira/oauth/start',
            ...getJiraPollingStatus(),
          });
        },
      },
      {
        method: 'GET',
        path: '/api/jira/oauth/start',
        handler({ response }) {
          try {
            response.writeHead(302, { Location: createJiraAuthorizationUrl() });
            response.end();
          } catch (error) {
            writeJsonResponse(response, 400, { ok: false, error: getErrorMessage(error) });
          }
        },
      },
      {
        method: 'GET',
        path: '/api/jira/oauth/callback',
        async handler({ url, response }) {
          const oauthError = url.searchParams.get('error');
          if (oauthError) {
            writeOAuthResult(response, 400, 'Jira connection failed', url.searchParams.get('error_description') || oauthError);
            return;
          }
          try {
            const connection = await completeJiraAuthorization(
              url.searchParams.get('code') || '',
              url.searchParams.get('state') || '',
            );
            writeOAuthResult(response, 200, 'Jira connected', `Connected to ${connection.siteName || connection.siteUrl}. You can close this window.`);
            void pollJiraIssues().catch(error => {
              console.error(`Initial Jira polling failed: ${getErrorMessage(error)}`);
            });
          } catch (error) {
            writeOAuthResult(response, 400, 'Jira connection failed', getErrorMessage(error));
          }
        },
      },
      {
        method: 'POST',
        path: '/api/jira/poll',
        async handler({ response }) {
          try {
            const result = await pollJiraIssues();
            writeJsonResponse(response, 200, { ok: true, ...result });
          } catch (error) {
            writeJsonResponse(response, 502, { ok: false, error: getErrorMessage(error) });
          }
        },
      },
      {
        method: 'POST',
        path: '/api/jira/disconnect',
        handler({ response }) {
          clearJiraConnection();
          writeJsonResponse(response, 200, { ok: true });
        },
      },
    ];
  },
};

function writeOAuthResult(
  response: import('node:http').ServerResponse,
  statusCode: number,
  title: string,
  message: string,
): void {
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
