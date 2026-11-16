import { GITHUB_API_BASE_URL } from '../../core/constants';
import { isRecord, readStringField } from '../../utils/payload';
import type { GitHubNotification, GitHubViewer } from './types';

const MAX_NOTIFICATION_PAGES = 10;

export async function fetchGitHubViewer(token: string): Promise<GitHubViewer> {
  const response = await githubFetch('/user', token);
  const rawBody = await response.text();
  const payload = parseJsonResponseBody(rawBody);
  if (!response.ok || !isRecord(payload)) {
    throw new Error(`GitHub user lookup failed (${response.status}): ${readGitHubError(payload, rawBody)}`);
  }
  const login = readStringField(payload, 'login').trim();
  if (!login) throw new Error('GitHub user response did not contain a login');
  return {
    login,
    avatarUrl: readStringField(payload, 'avatar_url').trim(),
    profileUrl: readStringField(payload, 'html_url').trim() || `https://github.com/${encodeURIComponent(login)}`,
  };
}

export async function fetchGitHubReviewNotifications(token: string): Promise<GitHubNotification[]> {
  const notificationsById = new Map<string, GitHubNotification>();
  let viewer: GitHubViewer | undefined;
  for (let page = 1; page <= MAX_NOTIFICATION_PAGES; page += 1) {
    const url = new URL(`${GITHUB_API_BASE_URL}/notifications`);
    // Reading a GitHub notification must not hide an outstanding review request.
    url.searchParams.set('all', 'true');
    url.searchParams.set('participating', 'true');
    url.searchParams.set('per_page', '50');
    url.searchParams.set('page', String(page));
    const response = await githubFetch(url, token);
    const rawBody = await response.text();
    const payload = parseJsonResponseBody(rawBody);
    if (!response.ok || !Array.isArray(payload)) {
      throw new Error(`GitHub notifications lookup failed (${response.status}): ${readGitHubError(payload, rawBody)}`);
    }
    for (const value of payload) {
      const notification = normalizeNotification(value);
      if (notification?.reason === 'review_requested' && notification.subjectType === 'PullRequest') {
        if (!notification.unread) {
          viewer ??= await fetchGitHubViewer(token);
          if (!await isOutstandingDirectReview(notification, viewer.login, token)) continue;
        }
        notificationsById.set(notification.id, notification);
      }
    }
    if (payload.length < 50) return [...notificationsById.values()];
  }
  throw new Error(`GitHub notifications lookup exceeded ${MAX_NOTIFICATION_PAGES} pages`);
}

async function isOutstandingDirectReview(notification: GitHubNotification, login: string, token: string): Promise<boolean> {
  let url: URL;
  try { url = new URL(notification.subjectUrl); } catch { return false; }
  if (url.origin !== GITHUB_API_BASE_URL || !/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(url.pathname)) return false;
  const response = await githubFetch(url, token);
  if (response.status === 404 || response.status === 410) return false;
  const rawBody = await response.text();
  const payload = parseJsonResponseBody(rawBody);
  if (!response.ok || !isRecord(payload)) {
    throw new Error(`GitHub review lookup failed (${response.status}): ${readGitHubError(payload, rawBody)}`);
  }
  if (payload['state'] !== 'open' || !Array.isArray(payload['requested_reviewers'])) return false;
  return payload['requested_reviewers'].some(reviewer =>
    isRecord(reviewer) && readStringField(reviewer, 'login').toLowerCase() === login.toLowerCase());
}

function githubFetch(pathOrUrl: string | URL, token: string): Promise<Response> {
  const url = pathOrUrl instanceof URL ? pathOrUrl : `${GITHUB_API_BASE_URL}${pathOrUrl}`;
  return fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'multitasker-local-backend',
    },
  });
}

function normalizeNotification(value: unknown): GitHubNotification | null {
  if (!isRecord(value)) return null;
  const id = readStringField(value, 'id').trim();
  const reason = readStringField(value, 'reason').trim();
  const subject = value['subject'];
  const repository = value['repository'];
  if (!id || !isRecord(subject) || !isRecord(repository)) return null;
  const repositoryFullName = readStringField(repository, 'full_name').trim();
  const repositoryUrl = readStringField(repository, 'html_url').trim();
  const subjectTitle = readStringField(subject, 'title').trim();
  const subjectType = readStringField(subject, 'type').trim();
  const subjectUrl = readStringField(subject, 'url').trim();
  if (!repositoryFullName || !repositoryUrl || !subjectTitle) return null;
  return {
    id,
    reason,
    unread: value['unread'] === true,
    repositoryFullName,
    repositoryUrl,
    subjectTitle,
    subjectType,
    subjectUrl,
  };
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
    const message = readStringField(payload, 'message').trim();
    if (message) return message;
  }
  return rawBody.trim() || 'Unknown GitHub API error';
}
