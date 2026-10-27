import fs from 'node:fs';
import path from 'node:path';
import { getStorageDirectory } from '../../state/sessions';
import { isRecord, readStringArrayField, readStringField } from '../../utils/payload';
import type { GitHubConnectionState } from './types';

interface GitHubPersistedState {
  connection: GitHubConnectionState | null;
  trackedReviewRequestIds: string[];
  lastPolledAt?: number;
  lastError?: string;
}

let githubState: GitHubPersistedState = {
  connection: null,
  trackedReviewRequestIds: [],
};
let githubPollTimer: ReturnType<typeof setInterval> | null = null;
let githubPollInFlight = false;

export function loadGitHubState(): void {
  githubState = { connection: null, trackedReviewRequestIds: [] };
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(getGitHubStatePath(), 'utf8'));
    if (!isRecord(parsed)) return;
    const connection = normalizeConnection(parsed['connection']);
    const trackedReviewRequestIds = readStringArrayField(parsed, 'trackedReviewRequestIds');
    const lastPolledAt = readFiniteNumber(parsed['lastPolledAt']);
    const lastError = readStringField(parsed, 'lastError').trim();
    githubState = { connection, trackedReviewRequestIds };
    if (lastPolledAt !== undefined) githubState.lastPolledAt = lastPolledAt;
    if (lastError) githubState.lastError = lastError;
  } catch {
    // The GitHub integration has not been connected yet.
  }
}

export function getGitHubConnection(): GitHubConnectionState | null {
  return githubState.connection ? { ...githubState.connection } : null;
}

export function setGitHubConnection(connection: GitHubConnectionState): void {
  const previousLogin = githubState.connection?.login;
  githubState.connection = { ...connection };
  if (previousLogin && previousLogin.toLowerCase() !== connection.login.toLowerCase()) {
    githubState.trackedReviewRequestIds = [];
    delete githubState.lastPolledAt;
  }
  delete githubState.lastError;
  saveGitHubState();
}

export function clearGitHubConnection(): void {
  githubState.connection = null;
  githubState.trackedReviewRequestIds = [];
  delete githubState.lastPolledAt;
  delete githubState.lastError;
  saveGitHubState();
}

export function getTrackedGitHubReviewRequestIds(): string[] {
  return [...githubState.trackedReviewRequestIds];
}

export function setTrackedGitHubReviewRequestIds(ids: string[]): void {
  githubState.trackedReviewRequestIds = [...new Set(ids.map(value => value.trim()).filter(Boolean))];
  saveGitHubState();
}

export function recordGitHubPollSuccess(polledAt = Date.now()): void {
  githubState.lastPolledAt = polledAt;
  delete githubState.lastError;
  saveGitHubState();
}

export function recordGitHubPollError(error: string): void {
  githubState.lastError = error.trim() || 'Unknown GitHub polling error';
  saveGitHubState();
}

export function getGitHubPollingStatus(): {
  trackedReviewRequestCount: number;
  lastPolledAt?: number;
  lastError?: string;
} {
  const status: {
    trackedReviewRequestCount: number;
    lastPolledAt?: number;
    lastError?: string;
  } = { trackedReviewRequestCount: githubState.trackedReviewRequestIds.length };
  if (githubState.lastPolledAt !== undefined) status.lastPolledAt = githubState.lastPolledAt;
  if (githubState.lastError) status.lastError = githubState.lastError;
  return status;
}

export function getGitHubPollTimer(): ReturnType<typeof setInterval> | null {
  return githubPollTimer;
}

export function setGitHubPollTimer(timer: ReturnType<typeof setInterval> | null): void {
  githubPollTimer = timer;
}

export function isGitHubPollInFlight(): boolean {
  return githubPollInFlight;
}

export function setGitHubPollInFlight(value: boolean): void {
  githubPollInFlight = value;
}

function saveGitHubState(): void {
  const filePath = getGitHubStatePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(githubState, null, 2));
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // File permissions are best-effort on Windows.
  }
}

function getGitHubStatePath(): string {
  const baseDirectory = getStorageDirectory() || path.join(process.cwd(), '.multitasker-data');
  return path.join(baseDirectory, 'github-state.json');
}

function normalizeConnection(value: unknown): GitHubConnectionState | null {
  if (!isRecord(value)) return null;
  const accessToken = readStringField(value, 'accessToken').trim();
  const tokenType = readStringField(value, 'tokenType').trim();
  const scope = readStringField(value, 'scope').trim();
  const login = readStringField(value, 'login').trim();
  const avatarUrl = readStringField(value, 'avatarUrl').trim();
  const profileUrl = readStringField(value, 'profileUrl').trim();
  const connectedAt = readFiniteNumber(value['connectedAt']);
  if (!accessToken || !login || connectedAt === undefined) return null;
  return { accessToken, tokenType, scope, login, avatarUrl, profileUrl, connectedAt };
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
