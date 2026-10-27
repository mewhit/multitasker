import fs from 'node:fs';
import path from 'node:path';
import { getStorageDirectory } from '../../state/sessions';
import { isRecord, readStringArrayField, readStringField } from '../../utils/payload';
import type { JiraConnectionState } from './types';

interface JiraPersistedState {
  connection: JiraConnectionState | null;
  trackedIssueIds: string[];
  lastPolledAt?: number;
  lastError?: string;
}

let jiraState: JiraPersistedState = {
  connection: null,
  trackedIssueIds: [],
};

let jiraPollTimer: ReturnType<typeof setInterval> | null = null;
let jiraPollInFlight = false;

export function loadJiraState(): void {
  jiraState = {
    connection: null,
    trackedIssueIds: [],
  };
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(getJiraStatePath(), 'utf8'));
    if (!isRecord(parsed)) return;
    const connection = normalizeJiraConnection(parsed['connection']);
    const trackedIssueIds = readStringArrayField(parsed, 'trackedIssueIds');
    const lastPolledAt = readFiniteNumber(parsed['lastPolledAt']);
    const lastError = readStringField(parsed, 'lastError').trim();
    jiraState = { connection, trackedIssueIds };
    if (lastPolledAt !== undefined) jiraState.lastPolledAt = lastPolledAt;
    if (lastError) jiraState.lastError = lastError;
  } catch {
    // The Jira integration has not been connected yet.
  }
}

export function getJiraConnection(): JiraConnectionState | null {
  return jiraState.connection ? { ...jiraState.connection } : null;
}

export function setJiraConnection(connection: JiraConnectionState): void {
  const previousCloudId = jiraState.connection?.cloudId;
  jiraState.connection = { ...connection };
  if (previousCloudId && previousCloudId !== connection.cloudId) {
    jiraState.trackedIssueIds = [];
    delete jiraState.lastPolledAt;
  }
  delete jiraState.lastError;
  saveJiraState();
}

export function clearJiraConnection(): void {
  jiraState.connection = null;
  delete jiraState.lastError;
  saveJiraState();
}

export function getTrackedJiraIssueIds(): string[] {
  return [...jiraState.trackedIssueIds];
}

export function setTrackedJiraIssueIds(issueIds: string[]): void {
  jiraState.trackedIssueIds = [...new Set(issueIds.map(value => value.trim()).filter(Boolean))];
  saveJiraState();
}

export function recordJiraPollSuccess(polledAt = Date.now()): void {
  jiraState.lastPolledAt = polledAt;
  delete jiraState.lastError;
  saveJiraState();
}

export function recordJiraPollError(error: string): void {
  jiraState.lastError = error.trim() || 'Unknown Jira polling error';
  saveJiraState();
}

export function getJiraPollingStatus(): {
  trackedIssueCount: number;
  lastPolledAt?: number;
  lastError?: string;
} {
  const status: {
    trackedIssueCount: number;
    lastPolledAt?: number;
    lastError?: string;
  } = {
    trackedIssueCount: jiraState.trackedIssueIds.length,
  };
  if (jiraState.lastPolledAt !== undefined) status.lastPolledAt = jiraState.lastPolledAt;
  if (jiraState.lastError) status.lastError = jiraState.lastError;
  return status;
}

export function getJiraPollTimer(): ReturnType<typeof setInterval> | null {
  return jiraPollTimer;
}

export function setJiraPollTimer(timer: ReturnType<typeof setInterval> | null): void {
  jiraPollTimer = timer;
}

export function isJiraPollInFlight(): boolean {
  return jiraPollInFlight;
}

export function setJiraPollInFlight(value: boolean): void {
  jiraPollInFlight = value;
}

function saveJiraState(): void {
  const filePath = getJiraStatePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(jiraState, null, 2));
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // File permissions are best-effort on Windows.
  }
}

function getJiraStatePath(): string {
  const baseDirectory = getStorageDirectory() || path.join(process.cwd(), '.multitasker-data');
  return path.join(baseDirectory, 'jira-state.json');
}

function normalizeJiraConnection(value: unknown): JiraConnectionState | null {
  if (!isRecord(value)) return null;
  const accessToken = readStringField(value, 'accessToken').trim();
  const refreshToken = readStringField(value, 'refreshToken').trim();
  const scope = readStringField(value, 'scope').trim();
  const cloudId = readStringField(value, 'cloudId').trim();
  const siteName = readStringField(value, 'siteName').trim();
  const siteUrl = readStringField(value, 'siteUrl').trim();
  const expiresAt = readFiniteNumber(value['expiresAt']);
  const connectedAt = readFiniteNumber(value['connectedAt']);
  if (!accessToken || !refreshToken || !cloudId || !siteUrl || expiresAt === undefined || connectedAt === undefined) {
    return null;
  }
  return {
    accessToken,
    refreshToken,
    expiresAt,
    scope,
    cloudId,
    siteName,
    siteUrl,
    connectedAt,
  };
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
