import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HttpModule, RouteDef } from '../../core/types';
import type { GitHubPullRequest } from '../../types';
import { loadSettings } from '../../../shared/settings';
import {
  seenGitHubReviewRequestKeys,
  getGitHubReviewTimer,
  setGitHubReviewTimer,
  isGitHubReviewPollInFlight,
  setGitHubReviewPollInFlight,
} from '../../state/github';
import { getStorageDirectory } from '../../state/sessions';
import { getServerEnvValue } from '../../core/env';
import { getErrorMessage } from '../../core/util';
import { GITHUB_TOKEN_ENV, GITHUB_API_BASE_URL, DEFAULT_GITHUB_REVIEW_POLL_MINUTES } from '../../core/constants';
import { truncateTaskText } from '../../utils/date';
import { isRecord, readStringField } from '../../utils/payload';
import { publishIntegrationManualTask } from '../manual-tasks/integrations';

export function startGitHubReviewScheduler(): void {
  stopGitHubReviewScheduler();
  void pollGitHubReviewRequests();
  setGitHubReviewTimer(setInterval(() => {
    void pollGitHubReviewRequests();
  }, getGitHubReviewPollIntervalMs()));
}

export function stopGitHubReviewScheduler(): void {
  const timer = getGitHubReviewTimer();
  if (!timer) return;
  clearInterval(timer);
  setGitHubReviewTimer(null);
}

function getGitHubReviewPollIntervalMs(): number {
  const settings = loadSettings().githubReview;
  const pollMinutes = Number.isFinite(settings.pollMinutes)
    ? Math.max(1, Math.min(60, Math.floor(settings.pollMinutes)))
    : DEFAULT_GITHUB_REVIEW_POLL_MINUTES;
  return pollMinutes * 60 * 1000;
}

async function pollGitHubReviewRequests(): Promise<void> {
  if (isGitHubReviewPollInFlight()) return;
  const settings = loadSettings().githubReview;
  if (!settings.enabled) return;
  if (!settings.owner.trim() || !settings.repo.trim()) return;

  const token = getServerEnvValue(GITHUB_TOKEN_ENV).trim();
  if (!token) return;

  setGitHubReviewPollInFlight(true);
  try {
    const viewerLogin = await fetchGitHubViewerLogin(token);
    if (!viewerLogin) return;
    const prs = await fetchOpenPullRequests(settings.owner, settings.repo, token);
    const now = Date.now();
    let changed = false;
    for (const pr of prs) {
      if (!isPullRequestRequestedForViewer(pr, viewerLogin)) continue;
      const requestKey = `${settings.owner}/${settings.repo}#${pr.number}`;
      if (seenGitHubReviewRequestKeys.has(requestKey)) continue;
      seenGitHubReviewRequestKeys.add(requestKey);
      changed = true;
      publishIntegrationManualTask({
        id: `manual-${randomUUID()}`,
        text: truncateTaskText(`Review PR ${requestKey}: ${pr.title} (${pr.html_url})`),
        createdAt: now,
      });
    }
    if (changed) saveSeenGitHubReviewRequests();
  } catch (error) {
    console.error(`GitHub review polling failed: ${getErrorMessage(error)}`);
  } finally {
    setGitHubReviewPollInFlight(false);
  }
}

function isPullRequestRequestedForViewer(pr: GitHubPullRequest, viewerLogin: string): boolean {
  if (pr.draft) return false;
  const requestedReviewers = Array.isArray(pr.requested_reviewers) ? pr.requested_reviewers : [];
  return requestedReviewers.some(reviewer => reviewer?.login?.toLowerCase() === viewerLogin.toLowerCase());
}

async function fetchGitHubViewerLogin(token: string): Promise<string> {
  const response = await fetch(`${GITHUB_API_BASE_URL}/user`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'multitasker-local-backend',
    },
  });
  const body = parseJsonResponseBody(await response.text());
  if (!response.ok || !isRecord(body)) {
    throw new Error(`GitHub /user failed (${response.status})`);
  }
  return readStringField(body, 'login').trim();
}

async function fetchOpenPullRequests(owner: string, repo: string, token: string): Promise<GitHubPullRequest[]> {
  const url = new URL(`${GITHUB_API_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`);
  url.searchParams.set('state', 'open');
  url.searchParams.set('sort', 'updated');
  url.searchParams.set('direction', 'desc');
  url.searchParams.set('per_page', '50');
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'multitasker-local-backend',
    },
  });
  const body = parseJsonResponseBody(await response.text());
  if (!response.ok || !Array.isArray(body)) {
    throw new Error(`GitHub pulls listing failed (${response.status})`);
  }
  return body.filter(isGitHubPullRequest);
}

function isGitHubPullRequest(value: unknown): value is GitHubPullRequest {
  if (!isRecord(value)) return false;
  if (!Number.isInteger(value['number'])) return false;
  if (typeof value['title'] !== 'string' || !value['title'].trim()) return false;
  if (typeof value['html_url'] !== 'string' || !value['html_url'].trim()) return false;
  if (value['requested_reviewers'] !== undefined && !Array.isArray(value['requested_reviewers'])) return false;
  if (value['draft'] !== undefined && typeof value['draft'] !== 'boolean') return false;
  return true;
}

function parseJsonResponseBody(rawBody: string): unknown {
  if (!rawBody.trim()) return {};
  try {
    return JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
}

export function loadSeenGitHubReviewRequests(): void {
  seenGitHubReviewRequestKeys.clear();
  try {
    const raw = fs.readFileSync(getGitHubReviewSeenPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const value of parsed) {
      if (typeof value === 'string' && value.trim()) seenGitHubReviewRequestKeys.add(value.trim());
    }
  } catch {
    // No previous file yet.
  }
}

function saveSeenGitHubReviewRequests(): void {
  const filePath = getGitHubReviewSeenPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify([...seenGitHubReviewRequestKeys], null, 2));
}

function getGitHubReviewSeenPath(): string {
  const baseDirectory = getStorageDirectory() || path.join(process.cwd(), '.multitasker-data');
  return path.join(baseDirectory, 'github-review-seen.json');
}

export const githubReviewsModule: HttpModule = {
  name: 'github-reviews',
  init() {
    loadSeenGitHubReviewRequests();
    startGitHubReviewScheduler();
  },
  dispose() {
    stopGitHubReviewScheduler();
  },
  routes(): RouteDef[] {
    return [];
  },
};
