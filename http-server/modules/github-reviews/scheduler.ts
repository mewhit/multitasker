import { randomUUID } from 'node:crypto';
import {
  DEFAULT_GITHUB_REVIEW_POLL_MINUTES,
  GITHUB_POLL_MINUTES_ENV,
} from '../../core/constants';
import { getServerEnvValue } from '../../core/env';
import { getErrorMessage } from '../../core/util';
import { loadSettings } from '../../../shared/settings';
import { truncateTaskText } from '../../utils/date';
import { publishIntegrationManualTask } from '../manual-tasks/integrations';
import { getAuthorizedGitHubToken } from './auth';
import { fetchGitHubReviewNotifications } from './client';
import {
  getGitHubPollTimer,
  getTrackedGitHubReviewRequestIds,
  isGitHubPollInFlight,
  recordGitHubPollError,
  recordGitHubPollSuccess,
  setGitHubPollInFlight,
  setGitHubPollTimer,
  setTrackedGitHubReviewRequestIds,
} from './state';
import type { GitHubNotification, GitHubPollResult } from './types';

export function startGitHubReviewScheduler(): void {
  stopGitHubReviewScheduler();
  void runGitHubPollSafely();
  setGitHubPollTimer(setInterval(() => {
    void runGitHubPollSafely();
  }, getGitHubPollIntervalMs()));
}

export function stopGitHubReviewScheduler(): void {
  const timer = getGitHubPollTimer();
  if (!timer) return;
  clearInterval(timer);
  setGitHubPollTimer(null);
}

export function getGitHubPollMinutes(): number {
  const configuredValue = getServerEnvValue(GITHUB_POLL_MINUTES_ENV);
  const configured = Number(configuredValue);
  if (configuredValue && Number.isFinite(configured)) return Math.max(1, Math.min(60, Math.floor(configured)));
  const setting = loadSettings().githubReview.pollMinutes;
  return Number.isFinite(setting)
    ? Math.max(1, Math.min(60, Math.floor(setting)))
    : DEFAULT_GITHUB_REVIEW_POLL_MINUTES;
}

export async function pollGitHubReviewRequests(): Promise<GitHubPollResult> {
  if (isGitHubPollInFlight()) return { reviewRequestCount: 0, newReviewRequestCount: 0, skipped: 'already_running' };
  const token = getAuthorizedGitHubToken();
  if (!token) return { reviewRequestCount: 0, newReviewRequestCount: 0, skipped: 'not_connected' };

  setGitHubPollInFlight(true);
  try {
    const notifications = await fetchGitHubReviewNotifications(token);
    const previousIds = new Set(getTrackedGitHubReviewRequestIds());
    const newNotifications = notifications.filter(notification => !previousIds.has(notification.id));
    for (const notification of newNotifications) publishReviewTask(notification);
    setTrackedGitHubReviewRequestIds(notifications.map(notification => notification.id));
    recordGitHubPollSuccess();
    return {
      reviewRequestCount: notifications.length,
      newReviewRequestCount: newNotifications.length,
    };
  } catch (error) {
    recordGitHubPollError(getErrorMessage(error));
    throw error;
  } finally {
    setGitHubPollInFlight(false);
  }
}

async function runGitHubPollSafely(): Promise<void> {
  try {
    await pollGitHubReviewRequests();
  } catch (error) {
    console.error(`GitHub review polling failed: ${getErrorMessage(error)}`);
  }
}

function publishReviewTask(notification: GitHubNotification): void {
  const pullRequestUrl = buildPullRequestUrl(notification);
  publishIntegrationManualTask({
    id: `manual-${randomUUID()}`,
    text: truncateTaskText(`Review GitHub PR ${notification.repositoryFullName}: ${notification.subjectTitle} (${pullRequestUrl})`),
    createdAt: Date.now(),
  });
}

function buildPullRequestUrl(notification: GitHubNotification): string {
  const match = notification.subjectUrl.match(/\/pulls\/(\d+)(?:\?.*)?$/i);
  return match ? `${notification.repositoryUrl}/pull/${match[1]}` : notification.repositoryUrl;
}

function getGitHubPollIntervalMs(): number {
  return getGitHubPollMinutes() * 60 * 1000;
}
