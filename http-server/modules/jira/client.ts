import { getAuthorizedJiraConnection } from './auth';
import type { JiraConnectionState, JiraIssue } from './types';
import { isRecord, readStringField } from '../../utils/payload';

const MAX_RESULTS_PER_PAGE = 100;
const MAX_SEARCH_PAGES = 100;

export async function fetchJiraIssues(jql: string): Promise<JiraIssue[]> {
  let connection = await getAuthorizedJiraConnection();
  let nextPageToken = '';
  let refreshedAfterUnauthorized = false;
  const issuesById = new Map<string, JiraIssue>();

  for (let page = 0; page < MAX_SEARCH_PAGES; page += 1) {
    const response = await searchJiraIssuesPage(connection, jql, nextPageToken);
    if (response.status === 401 && !refreshedAfterUnauthorized) {
      connection = await getAuthorizedJiraConnection(true);
      refreshedAfterUnauthorized = true;
      page -= 1;
      continue;
    }

    const rawBody = await response.text();
    const payload = parseJsonResponseBody(rawBody);
    if (!response.ok || !isRecord(payload)) {
      throw new Error(`Jira issue search failed (${response.status}): ${readJiraError(payload, rawBody)}`);
    }

    const rawIssues = payload['issues'];
    if (!Array.isArray(rawIssues)) throw new Error('Jira issue search response did not contain an issues array');
    for (const rawIssue of rawIssues) {
      const issue = normalizeJiraIssue(rawIssue);
      if (issue) issuesById.set(issue.id, issue);
    }

    const isLast = payload['isLast'] === true;
    nextPageToken = readStringField(payload, 'nextPageToken').trim();
    if (isLast || !nextPageToken) return [...issuesById.values()];
  }

  throw new Error(`Jira issue search exceeded ${MAX_SEARCH_PAGES} pages`);
}

function searchJiraIssuesPage(
  connection: JiraConnectionState,
  jql: string,
  nextPageToken: string,
): Promise<Response> {
  const url = `https://api.atlassian.com/ex/jira/${encodeURIComponent(connection.cloudId)}/rest/api/3/search/jql`;
  const body: {
    jql: string;
    fields: string[];
    maxResults: number;
    nextPageToken?: string;
  } = {
    jql,
    fields: ['summary'],
    maxResults: MAX_RESULTS_PER_PAGE,
  };
  if (nextPageToken) body.nextPageToken = nextPageToken;
  return fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${connection.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function normalizeJiraIssue(value: unknown): JiraIssue | null {
  if (!isRecord(value)) return null;
  const id = readStringField(value, 'id').trim();
  const key = readStringField(value, 'key').trim();
  const fields = value['fields'];
  const summary = isRecord(fields) ? readStringField(fields, 'summary').trim() : '';
  return id && key ? { id, key, summary: summary || key } : null;
}

function parseJsonResponseBody(rawBody: string): unknown {
  if (!rawBody.trim()) return {};
  try {
    return JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
}

function readJiraError(payload: unknown, rawBody: string): string {
  if (isRecord(payload)) {
    const messages = payload['errorMessages'];
    if (Array.isArray(messages)) {
      const message = messages.find((value): value is string => typeof value === 'string' && Boolean(value.trim()));
      if (message) return message.trim();
    }
    const message = readStringField(payload, 'message').trim();
    if (message) return message;
  }
  return rawBody.trim() || 'Unknown Jira API error';
}
