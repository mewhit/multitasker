import { randomUUID } from 'node:crypto';
import {
  DEFAULT_JIRA_JQL,
  DEFAULT_JIRA_POLL_MINUTES,
  JIRA_JQL_ENV,
  JIRA_POLL_MINUTES_ENV,
} from '../../core/constants';
import { getServerEnvValue } from '../../core/env';
import { getErrorMessage } from '../../core/util';
import { truncateTaskText } from '../../utils/date';
import { publishIntegrationManualTask } from '../manual-tasks/integrations';
import { fetchJiraIssues } from './client';
import {
  getJiraConnection,
  getJiraPollTimer,
  getTrackedJiraIssueIds,
  isJiraPollInFlight,
  recordJiraPollError,
  recordJiraPollSuccess,
  setJiraPollInFlight,
  setJiraPollTimer,
  setTrackedJiraIssueIds,
} from './state';
import type { JiraPollResult } from './types';

export function startJiraScheduler(): void {
  stopJiraScheduler();
  void runJiraPollSafely();
  setJiraPollTimer(setInterval(() => {
    void runJiraPollSafely();
  }, getJiraPollIntervalMs()));
}

export function stopJiraScheduler(): void {
  const timer = getJiraPollTimer();
  if (!timer) return;
  clearInterval(timer);
  setJiraPollTimer(null);
}

export function getJiraJql(): string {
  return getServerEnvValue(JIRA_JQL_ENV) || DEFAULT_JIRA_JQL;
}

export function getJiraPollMinutes(): number {
  const configured = Number(getServerEnvValue(JIRA_POLL_MINUTES_ENV));
  return Number.isFinite(configured)
    ? Math.max(1, Math.min(24 * 60, Math.floor(configured)))
    : DEFAULT_JIRA_POLL_MINUTES;
}

export async function pollJiraIssues(): Promise<JiraPollResult> {
  if (isJiraPollInFlight()) return { issueCount: 0, newIssueCount: 0, skipped: 'already_running' };
  if (!getJiraConnection()) return { issueCount: 0, newIssueCount: 0, skipped: 'not_connected' };

  setJiraPollInFlight(true);
  try {
    const issues = await fetchJiraIssues(getJiraJql());
    const previousIds = new Set(getTrackedJiraIssueIds());
    const newIssues = issues.filter(issue => !previousIds.has(issue.id));
    const connection = getJiraConnection();
    if (!connection) throw new Error('Jira was disconnected while polling');

    for (const issue of newIssues) {
      const issueUrl = `${connection.siteUrl}/browse/${encodeURIComponent(issue.key)}`;
      publishIntegrationManualTask({
        id: `manual-${randomUUID()}`,
        text: truncateTaskText(`Jira ${issue.key}: ${issue.summary} (${issueUrl})`),
        createdAt: Date.now(),
      });
    }

    setTrackedJiraIssueIds(issues.map(issue => issue.id));
    recordJiraPollSuccess();
    return { issueCount: issues.length, newIssueCount: newIssues.length };
  } catch (error) {
    recordJiraPollError(getErrorMessage(error));
    throw error;
  } finally {
    setJiraPollInFlight(false);
  }
}

async function runJiraPollSafely(): Promise<void> {
  try {
    await pollJiraIssues();
  } catch (error) {
    console.error(`Jira polling failed: ${getErrorMessage(error)}`);
  }
}

function getJiraPollIntervalMs(): number {
  return getJiraPollMinutes() * 60 * 1000;
}
