import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebClient } from '@slack/web-api';
import { SessionManager, type Session, type SessionStatus, type TerminalBinding, type TerminalUpdate } from '../desktop/sessionManager';
import {
  loadSettings,
  saveSettings,
  loadSessions,
  saveSessions,
  loadManualTasks,
  saveManualTasks,
  loadRecurringTasks,
  saveRecurringTasks,
  loadSlackNotifications,
  saveSlackNotifications,
  setStorageDirectory,
  type AppSettings,
  type ManualTaskState,
  type RecurringTaskFrequency,
  type RecurringTaskState,
  type SessionState,
  type ShellType,
  type LocalShellType,
  type SlackNotificationState,
} from '../desktop/settings';
import type { TerminalCaptureState, TerminalEvent, TerminalEventType } from '../desktop/terminalEvents';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 39017;
const PORT = readBackendPort();
const TERMINAL_UPDATE_PATH = '/terminal-update';
const TERMINAL_EVENT_PATH = '/terminal-event';
const VSCODE_WINDOW_PATH = '/vscode-window';
const VSCODE_COMMAND_PATH = '/vscode-command';
const SLACK_EVENT_PATH = '/slack-event';
const SLACK_NOTIFICATION_PATH = '/slack-notification';
const SLACK_NOTIFICATION_DISMISS_PATH = '/slack-notification-dismiss';
const EXTENSION_VSCODE_TERMINAL_UPDATE_PATH = '/extensions/vscode/terminal-updates';
const EXTENSION_VSCODE_TERMINAL_EVENT_PATH = '/extensions/vscode/terminal-events';
const EXTENSION_VSCODE_WINDOW_PATH = '/extensions/vscode/windows';
const EXTENSION_VSCODE_COMMAND_PATH = '/extensions/vscode/commands';
const EXTENSION_VSCODE_TASKS_PATH = '/extensions/vscode/tasks';
const EXTENSION_SLACK_EVENT_PATH = '/extensions/slack/events';
const EXTENSION_SLACK_NOTIFICATION_PATH = '/extensions/slack/notifications';
const EXTENSION_SLACK_NOTIFICATION_DISMISS_PATH = '/extensions/slack/notification-dismiss';
const MAX_HTTP_BODY_BYTES = 512 * 1024;
const MAX_MANUAL_TASKS = 200;
const MAX_MANUAL_TASK_TEXT_LENGTH = 4000;
const MAX_RECURRING_TASKS = 100;
const RECURRING_TASK_CHECK_INTERVAL_MS = 30 * 1000;
const MAX_SLACK_NOTIFICATIONS = 100;
const MAX_SLACK_TEXT_LENGTH = 4000;
const MAX_SLACK_DEBUG_TEXT_LENGTH = 700;
const MAX_PENDING_TERMINAL_EVENTS_PER_SESSION = 200;
const MAX_PENDING_VSCODE_COMMANDS_PER_WINDOW = 50;
const VSCODE_COMMAND_LONG_POLL_TIMEOUT_MS = 25000;
const SLACK_USER_CONVERSATIONS_REFRESH_MS = 5 * 60 * 1000;
const DEBUG_LOG_DIRECTORY = 'debug-log';
const DEBUG_LOG_FILE_EXTENSION = '.log';
const TERMINAL_UPDATE_DEBUG_ENV = 'MULTITASKER_DEBUG_TERMINAL';
const SLACK_SOCKET_DEBUG_LOG_FILE = 'slack-connector.log';
const SLACK_ENV_RELATIVE_PATH = path.join('extension', 'slack', '.env');
const BACKEND_OWNS_STATE_ENV = 'MULTITASKER_BACKEND_OWNS_STATE';
const GOOGLE_CALENDAR_CLIENT_ID_ENV = 'MULTITASKER_GOOGLE_CALENDAR_CLIENT_ID';
const GOOGLE_CALENDAR_CLIENT_SECRET_ENV = 'MULTITASKER_GOOGLE_CALENDAR_CLIENT_SECRET';
const GITHUB_TOKEN_ENV = 'MULTITASKER_GITHUB_TOKEN';
const GOOGLE_CALENDAR_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GITHUB_API_BASE_URL = 'https://api.github.com';
const DEFAULT_GITHUB_REVIEW_POLL_MINUTES = 5;
const SERVER_ENV_FILE_NAMES = ['.env', '.env.local'];

type SlackNotificationPriorityLabel = NonNullable<SlackNotificationState['priorityLabel']>;

interface SlackNotificationPriority {
  rank: number;
  label: SlackNotificationPriorityLabel;
}

interface SlackNotificationPriorityDecision extends SlackNotificationPriority {
  reason: string;
  mentionsAuthedUser: boolean;
  directMessage: boolean;
  threadReply: boolean;
  threadWrittenByAuthedUser: boolean;
  threadTs?: string;
}

interface SlackChannelInfo {
  name: string;
  isUserMember: boolean;
  type: string;
}

const SLACK_PRIORITY_MENTION: SlackNotificationPriority = { rank: 0, label: 'mention' };
const SLACK_PRIORITY_DM: SlackNotificationPriority = { rank: 1, label: 'dm' };
const SLACK_PRIORITY_THREAD_MENTION: SlackNotificationPriority = { rank: 2, label: 'thread_mention' };
const SLACK_PRIORITY_THREAD_WRITTEN: SlackNotificationPriority = { rank: 3, label: 'thread_written' };
const SLACK_PRIORITY_OTHER: SlackNotificationPriority = { rank: 4, label: 'other' };

interface MultitaskerCreateSessionRequest {
  id?: string;
  name: string;
  cmd: string;
  cwd: string;
  shellType: ShellType;
  sshCommand?: string;
  vscodeWindowId?: string;
  terminalRef?: string;
  terminalPid?: number;
  terminalName?: string;
  launchId?: string;
}

interface VsCodeWindowRegistration {
  windowId: string;
  workspaceFolder?: string;
  workspaceName?: string;
  pid?: number;
  terminals?: VsCodeTerminalRegistration[];
  sessionIds?: string[];
}

interface VsCodeTerminalRegistration {
  terminalRef: string;
  terminalName?: string;
  terminalCwd?: string;
  terminalPid?: number;
  shellType?: ShellType;
  isActive?: boolean;
  captureState?: TerminalCaptureState;
  captureReason?: string;
}

interface VsCodeWindowEntry extends VsCodeWindowRegistration {
  lastSeenAt: number;
}

interface VsCodeSessionTerminalMatch {
  session: Session;
  reason: string;
}

interface PendingVsCodeCommandPoll {
  response: ServerResponse;
  timeout: ReturnType<typeof setTimeout>;
}

interface FocusTerminalCommand {
  id: string;
  type: 'focus-terminal';
  terminalRef: string;
}

interface DisconnectSessionCommand {
  id: string;
  type: 'disconnect-session';
  terminalRef: string;
}

type VsCodeCommand = FocusTerminalCommand | DisconnectSessionCommand;

interface SlackNotificationDismissRequest {
  channelId: string;
  teamId?: string;
  channelType?: string;
  reason?: string;
  targetTs?: string;
  replyTs?: string;
  ts?: string;
  receivedAt?: number;
}

interface TerminalEventIdentity {
  explicitTaskId: string;
  terminalRef: string;
  launchId: string;
  windowId: string;
  terminalPid: number | undefined;
  terminalName: string;
  terminalCwd: string;
}

interface BackendState {
  sessions: Session[];
  manualTasks: ManualTaskState[];
  recurringTasks: RecurringTaskState[];
  slackNotifications: SlackNotificationState[];
  vscodeWindows: VsCodeWindowEntry[];
}

interface GoogleCalendarOAuthConfig {
  clientId: string;
  clientSecret: string;
}

interface GitHubPullRequest {
  number: number;
  title: string;
  html_url: string;
  requested_reviewers?: Array<{ login?: string }>;
  draft?: boolean;
}

const storageDirectory = process.env['MULTITASKER_DATA_DIR']?.trim() || process.env['MULTITASKER_STORAGE_DIR']?.trim();
if (storageDirectory) setStorageDirectory(storageDirectory);

const sessionManager = new SessionManager();
const pendingTerminalUpdates = new Map<string, TerminalUpdate>();
const pendingTerminalEvents = new Map<string, TerminalEvent[]>();
const removedSessionIds = new Set<string>();
const vscodeWindowsById = new Map<string, VsCodeWindowEntry>();
const taskIdByTerminalRef = new Map<string, string>();
const pendingLaunchTaskIdByLaunchId = new Map<string, string>();
const pendingVsCodeCommandsByWindowId = new Map<string, VsCodeCommand[]>();
const pendingVsCodeCommandPollsByWindowId = new Map<string, PendingVsCodeCommandPoll>();
const terminalDebugLogFileBySessionId = new Map<string, string>();
const reportedDebugLogWriteFailures = new Set<string>();
const manualTasks: ManualTaskState[] = [];
const recurringTasks: RecurringTaskState[] = [];
const slackNotifications: SlackNotificationState[] = [];
const slackUserNameById = new Map<string, string>();
const slackBotNameById = new Map<string, string>();
const slackChannelInfoById = new Map<string, SlackChannelInfo>();
const slackClientByToken = new Map<string, WebClient>();
const slackThreadWrittenByAuthedUser = new Map<string, boolean>();
const sseClients = new Set<ServerResponse>();
let slackApiEnv: Record<string, string> = {};
let slackApiEnvFingerprint = '';
let slackAuthedUserId = '';
let slackAuthedUserConversationIds: Set<string> | undefined;
let slackAuthedUserConversationsLoadedAt = 0;
let recurringTaskTimer: ReturnType<typeof setInterval> | null = null;
let githubReviewTimer: ReturnType<typeof setInterval> | null = null;
let githubReviewPollInFlight = false;
let server: Server | null = null;
const seenGitHubReviewRequestKeys = new Set<string>();

refreshSlackApiEnvFromDisk();
sessionManager.on('sessionUpdate', (sessions: unknown) => {
  broadcastSseEvent('session:list-update', sessions);
  broadcastSseEvent('state', getBackendState());
});

restorePersistedState();
startRecurringTaskScheduler();
loadSeenGitHubReviewRequests();
startGitHubReviewScheduler();
startServer();

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function startServer(): void {
  if (server) return;

  server = createServer((request, response) => {
    void handleHttpRequest(request, response);
  });
  server.on('error', error => {
    console.error(`Failed to start Multitasker backend: ${getErrorMessage(error)}`);
    shutdown();
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    console.info(`Multitasker backend listening on http://${HOST}:${PORT}`);
  });
}

function shutdown(): void {
  stopRecurringTaskScheduler();
  stopGitHubReviewScheduler();
  closePendingVsCodeCommandPolls();
  for (const client of [...sseClients]) client.end();
  sseClients.clear();
  if (server) {
    try {
      server.close();
    } catch {
      // The server may fail before it starts listening.
    }
    server = null;
  }
}

async function handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'content-type');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  const requestUrl = new URL(request.url ?? '/', `http://${HOST}`);
  const requestPath = requestUrl.pathname;
  if (request.method === 'GET' && requestPath === '/api/health') {
    writeJsonResponse(response, 200, { ok: true });
    return;
  }
  if (request.method === 'GET' && requestPath === '/api/events') {
    handleSseClient(response);
    return;
  }
  if (request.method === 'GET' && requestPath === '/api/state') {
    writeJsonResponse(response, 200, { ok: true, state: getBackendState() });
    return;
  }
  if (request.method === 'GET' && requestPath === '/api/settings') {
    writeJsonResponse(response, 200, { ok: true, settings: loadSettings() });
    return;
  }
  if (request.method === 'GET' && requestPath === '/api/google-calendar/oauth-config') {
    handleGoogleCalendarOAuthConfigGet(response);
    return;
  }
  if (request.method === 'GET' && requestPath === '/api/sessions') {
    sessionManager.refreshGitChanges();
    writeJsonResponse(response, 200, { ok: true, sessions: sessionManager.getSessions() });
    return;
  }
  if (request.method === 'GET' && requestPath === '/api/manual-tasks') {
    writeJsonResponse(response, 200, { ok: true, manualTasks: manualTasks.map(cloneManualTask) });
    return;
  }
  if (request.method === 'GET' && requestPath === '/api/recurring-tasks') {
    writeJsonResponse(response, 200, { ok: true, recurringTasks: recurringTasks.map(cloneRecurringTask) });
    return;
  }
  if (request.method === 'GET' && requestPath === '/api/slack/notifications') {
    writeJsonResponse(response, 200, { ok: true, slackNotifications: slackNotifications.map(cloneSlackNotification) });
    return;
  }
  if (request.method === 'GET' && isVsCodeCommandPath(requestPath)) {
    handleVsCodeCommandPoll(requestUrl, response);
    return;
  }

  const postPaths = new Set([
    TERMINAL_UPDATE_PATH,
    TERMINAL_EVENT_PATH,
    VSCODE_WINDOW_PATH,
    SLACK_EVENT_PATH,
    SLACK_NOTIFICATION_PATH,
    SLACK_NOTIFICATION_DISMISS_PATH,
    EXTENSION_VSCODE_TERMINAL_UPDATE_PATH,
    EXTENSION_VSCODE_TERMINAL_EVENT_PATH,
    EXTENSION_VSCODE_WINDOW_PATH,
    EXTENSION_VSCODE_TASKS_PATH,
    EXTENSION_SLACK_EVENT_PATH,
    EXTENSION_SLACK_NOTIFICATION_PATH,
    EXTENSION_SLACK_NOTIFICATION_DISMISS_PATH,
    '/api/settings',
    '/api/google-calendar/token',
    '/api/session/create',
    '/api/session/remove',
    '/api/session/rename',
    '/api/session/touch',
    '/api/tasks',
    '/api/task/add',
    '/api/manual-task/add',
    '/api/manual-task/remove',
    '/api/recurring-task/add',
    '/api/recurring-task/remove',
    '/api/slack/clear',
    '/api/slack/remove',
    '/api/vscode/register-launch',
    '/api/vscode/queue-command',
    '/api/deeplink',
  ]);
  if (request.method !== 'POST' || !postPaths.has(requestPath)) {
    writeJsonResponse(response, 404, { ok: false, error: 'not_found' });
    return;
  }

  let parsedPayload: unknown;
  try {
    const rawBody = await readHttpBody(request);
    parsedPayload = rawBody ? JSON.parse(rawBody) : {};
  } catch (error) {
    const statusCode = error instanceof HttpBodyTooLargeError ? 413 : 400;
    writeJsonResponse(response, statusCode, { ok: false, error: getErrorMessage(error) });
    return;
  }

  await handlePostRequest(requestPath, parsedPayload, response);
}

async function handlePostRequest(requestPath: string, payload: unknown, response: ServerResponse): Promise<void> {
  switch (requestPath) {
    case TERMINAL_UPDATE_PATH:
    case EXTENSION_VSCODE_TERMINAL_UPDATE_PATH:
      handleTerminalUpdatePost(payload, response);
      return;
    case TERMINAL_EVENT_PATH:
    case EXTENSION_VSCODE_TERMINAL_EVENT_PATH:
      handleTerminalEventPost(payload, response);
      return;
    case VSCODE_WINDOW_PATH:
    case EXTENSION_VSCODE_WINDOW_PATH:
      handleVsCodeWindowPost(payload, response);
      return;
    case SLACK_EVENT_PATH:
    case EXTENSION_SLACK_EVENT_PATH:
      await handleSlackEventPost(payload, response);
      return;
    case SLACK_NOTIFICATION_PATH:
    case EXTENSION_SLACK_NOTIFICATION_PATH:
      handleSlackNotificationPost(payload, response);
      return;
    case SLACK_NOTIFICATION_DISMISS_PATH:
    case EXTENSION_SLACK_NOTIFICATION_DISMISS_PATH:
      handleSlackNotificationDismissPost(payload, response);
      return;
    case '/api/settings':
      handleSettingsPost(payload, response);
      return;
    case '/api/google-calendar/token':
      await handleGoogleCalendarTokenPost(payload, response);
      return;
    case '/api/session/create':
      handleSessionCreatePost(payload, response);
      return;
    case '/api/session/remove':
      handleSessionRemovePost(payload, response);
      return;
    case '/api/session/rename':
      handleSessionRenamePost(payload, response);
      return;
    case '/api/session/touch':
      handleSessionTouchPost(payload, response);
      return;
    case '/api/tasks':
    case '/api/task/add':
    case '/api/manual-task/add':
    case EXTENSION_VSCODE_TASKS_PATH:
      handleManualTaskAddPost(payload, response);
      return;
    case '/api/manual-task/remove':
      handleManualTaskRemovePost(payload, response);
      return;
    case '/api/recurring-task/add':
      handleRecurringTaskAddPost(payload, response);
      return;
    case '/api/recurring-task/remove':
      handleRecurringTaskRemovePost(payload, response);
      return;
    case '/api/slack/clear':
      handleSlackClearPost(response);
      return;
    case '/api/slack/remove':
      handleSlackRemovePost(payload, response);
      return;
    case '/api/vscode/register-launch':
      handleVsCodeRegisterLaunchPost(payload, response);
      return;
    case '/api/vscode/queue-command':
      handleVsCodeQueueCommandPost(payload, response);
      return;
    case '/api/deeplink':
      handleDeepLinkPost(payload, response);
      return;
    default:
      writeJsonResponse(response, 404, { ok: false, error: 'not_found' });
  }
}

function handleTerminalUpdatePost(payload: unknown, response: ServerResponse): void {
  const update = parseTerminalUpdateRequest(payload);
  if (!update) {
    writeJsonResponse(response, 400, { ok: false, error: 'invalid_terminal_update' });
    return;
  }
  if (shouldBackendOwnState()) {
    handleTerminalUpdate(update);
  } else {
    broadcastSseEvent('terminal:update', update);
  }
  writeJsonResponse(response, 200, { ok: true });
}

function handleTerminalEventPost(payload: unknown, response: ServerResponse): void {
  if (shouldBackendOwnState()) {
    const event = parseTerminalEventRequest(payload);
    if (!event) {
      writeJsonResponse(response, 400, { ok: false, error: 'invalid_terminal_event' });
      return;
    }
    handleTerminalEvent(event);
    writeJsonResponse(response, 200, { ok: true });
    return;
  }

  if (!isTerminalEventRelayPayload(payload)) {
    writeJsonResponse(response, 400, { ok: false, error: 'invalid_terminal_event' });
    return;
  }
  broadcastSseEvent('terminal:event', payload);
  writeJsonResponse(response, 200, { ok: true });
}

function handleVsCodeWindowPost(payload: unknown, response: ServerResponse): void {
  const registration = parseVsCodeWindowRegistration(payload);
  if (!registration) {
    writeJsonResponse(response, 400, { ok: false, error: 'invalid_vscode_window' });
    return;
  }
  rememberVsCodeWindow(registration);
  writeJsonResponse(response, 200, { ok: true });
}

async function handleSlackEventPost(payload: unknown, response: ServerResponse): Promise<void> {
  try {
    await handleSlackEventEnvelope(payload);
    writeJsonResponse(response, 200, { ok: true });
  } catch (error) {
    const message = getErrorMessage(error);
    debugSlackLog('Slack event handling failed', { error: message });
    writeJsonResponse(response, 500, { ok: false, error: message });
  }
}

function handleSlackNotificationPost(payload: unknown, response: ServerResponse): void {
  const notification = parseSlackNotificationRequest(payload);
  if (!notification) {
    writeJsonResponse(response, 400, { ok: false, error: 'invalid_slack_notification' });
    return;
  }
  handleSlackNotification(notification);
  writeJsonResponse(response, 200, { ok: true });
}

function handleSlackNotificationDismissPost(payload: unknown, response: ServerResponse): void {
  const dismissRequest = parseSlackNotificationDismissRequest(payload);
  if (!dismissRequest) {
    writeJsonResponse(response, 400, { ok: false, error: 'invalid_slack_notification_dismiss' });
    return;
  }
  const removed = handleSlackNotificationDismiss(dismissRequest);
  writeJsonResponse(response, 200, { ok: true, removed });
}

function handleGoogleCalendarOAuthConfigGet(response: ServerResponse): void {
  const config = getGoogleCalendarOAuthConfig();
  writeJsonResponse(response, 200, {
    ok: true,
    configured: Boolean(config.clientId),
    clientId: config.clientId,
    hasClientSecret: Boolean(config.clientSecret),
  });
}

async function handleGoogleCalendarTokenPost(payload: unknown, response: ServerResponse): Promise<void> {
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

function handleSettingsPost(payload: unknown, response: ServerResponse): void {
  if (typeof payload !== 'object' || payload === null) {
    writeJsonResponse(response, 400, { ok: false, error: 'invalid_settings' });
    return;
  }
  const settings = payload as Partial<AppSettings>;
  const currentSettings = loadSettings();
  saveSettings({
    reviewTool: typeof settings.reviewTool === 'string' ? settings.reviewTool : currentSettings.reviewTool,
    defaultShell: isLocalShellType(settings.defaultShell) ? settings.defaultShell : currentSettings.defaultShell,
    googleCalendar: typeof settings.googleCalendar === 'object' && settings.googleCalendar !== null
      ? settings.googleCalendar
      : currentSettings.googleCalendar,
    githubReview: typeof settings.githubReview === 'object' && settings.githubReview !== null
      ? settings.githubReview
      : currentSettings.githubReview,
  });
  startGitHubReviewScheduler();
  writeJsonResponse(response, 200, { ok: true, settings: loadSettings() });
}

function handleSessionCreatePost(payload: unknown, response: ServerResponse): void {
  const session = createSessionFromPayload(payload);
  if (!session) {
    writeJsonResponse(response, 400, { ok: false, error: 'invalid_session' });
    return;
  }
  writeJsonResponse(response, 200, { ok: true, session });
}

function handleSessionRemovePost(payload: unknown, response: ServerResponse): void {
  const id = readPayloadString(payload, 'id').trim();
  if (!id) {
    writeJsonResponse(response, 400, { ok: false, error: 'missing_session_id' });
    return;
  }
  removeSessionById(id);
  writeJsonResponse(response, 200, { ok: true });
}

function handleSessionRenamePost(payload: unknown, response: ServerResponse): void {
  const id = readPayloadString(payload, 'id').trim();
  const name = readPayloadString(payload, 'name').trim();
  if (!id || !name) {
    writeJsonResponse(response, 400, { ok: false, error: 'invalid_session_rename' });
    return;
  }
  const session = sessionManager.renameSession(id, name);
  if (!session) {
    writeJsonResponse(response, 404, { ok: false, error: 'session_not_found' });
    return;
  }
  saveSessions(getSessionsStateToSave());
  writeJsonResponse(response, 200, { ok: true, session });
}

function handleSessionTouchPost(payload: unknown, response: ServerResponse): void {
  const id = readPayloadString(payload, 'id').trim();
  if (!id) {
    writeJsonResponse(response, 400, { ok: false, error: 'missing_session_id' });
    return;
  }
  const session = sessionManager.touchSession(id);
  writeJsonResponse(response, 200, { ok: true, session });
}

function handleManualTaskAddPost(payload: unknown, response: ServerResponse): void {
  const task = parseManualTaskAddRequest(payload);
  if (!task) {
    writeJsonResponse(response, 400, { ok: false, error: 'invalid_manual_task' });
    return;
  }

  if (shouldBackendOwnState()) {
    writeJsonResponse(response, 200, { ok: true, task: storeManualTask(task) });
    return;
  }

  broadcastSseEvent('manual-task:add', cloneManualTask(task));
  writeJsonResponse(response, 200, { ok: true, task: cloneManualTask(task) });
}

function handleManualTaskRemovePost(payload: unknown, response: ServerResponse): void {
  const id = readPayloadString(payload, 'id').trim();
  if (!id) {
    writeJsonResponse(response, 400, { ok: false, error: 'missing_task_id' });
    return;
  }
  writeJsonResponse(response, 200, { ok: true, removed: removeManualTask(id) });
}

function handleRecurringTaskAddPost(payload: unknown, response: ServerResponse): void {
  const task = createRecurringTask(
    readPayloadValue(payload, 'text'),
    readPayloadValue(payload, 'time'),
    readPayloadValue(payload, 'schedule') ?? readPayloadValue(payload, 'recurrence') ?? readPayloadValue(payload, 'daysOfWeek')
  );
  if (!task) {
    writeJsonResponse(response, 400, { ok: false, error: 'invalid_recurring_task' });
    return;
  }
  writeJsonResponse(response, 200, { ok: true, task });
}

function handleRecurringTaskRemovePost(payload: unknown, response: ServerResponse): void {
  const id = readPayloadString(payload, 'id').trim();
  if (!id) {
    writeJsonResponse(response, 400, { ok: false, error: 'missing_task_id' });
    return;
  }
  writeJsonResponse(response, 200, { ok: true, removed: removeRecurringTask(id) });
}

function handleSlackClearPost(response: ServerResponse): void {
  slackNotifications.length = 0;
  saveSlackNotifications(slackNotifications);
  broadcastSlackListUpdate();
  writeJsonResponse(response, 200, { ok: true });
}

function handleSlackRemovePost(payload: unknown, response: ServerResponse): void {
  const id = readPayloadString(payload, 'id').trim();
  if (!id) {
    writeJsonResponse(response, 400, { ok: false, error: 'missing_slack_notification_id' });
    return;
  }
  writeJsonResponse(response, 200, { ok: true, removed: removeSlackNotification(id) });
}

function handleVsCodeRegisterLaunchPost(payload: unknown, response: ServerResponse): void {
  const launchId = readPayloadString(payload, 'launchId').trim();
  const sessionId = readPayloadString(payload, 'sessionId').trim();
  if (!launchId || !sessionId) {
    writeJsonResponse(response, 400, { ok: false, error: 'invalid_launch_registration' });
    return;
  }
  pendingLaunchTaskIdByLaunchId.set(launchId, sessionId);
  writeJsonResponse(response, 200, { ok: true });
}

function handleVsCodeQueueCommandPost(payload: unknown, response: ServerResponse): void {
  const windowId = readPayloadString(payload, 'windowId').trim();
  const terminalRef = readPayloadString(payload, 'terminalRef').trim();
  const commandType = readPayloadString(payload, 'type').trim();
  if (!windowId || !terminalRef || (commandType !== 'focus-terminal' && commandType !== 'disconnect-session')) {
    writeJsonResponse(response, 400, { ok: false, error: 'invalid_vscode_command' });
    return;
  }
  enqueueVsCodeCommand(windowId, { id: randomUUID(), type: commandType, terminalRef });
  writeJsonResponse(response, 200, { ok: true });
}

function handleDeepLinkPost(payload: unknown, response: ServerResponse): void {
  const url = readPayloadString(payload, 'url').trim();
  if (!url) {
    writeJsonResponse(response, 400, { ok: false, error: 'missing_url' });
    return;
  }

  const result = processDeepLink(url);
  if (!result.ok) {
    writeJsonResponse(response, 400, result);
    return;
  }
  writeJsonResponse(response, 200, result);
}

function createSessionFromPayload(payload: unknown): Session | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const settings = loadSettings();
  const name = readStringField(record, 'name').trim();
  const cmd = readStringField(record, 'cmd').trim() || readStringField(record, 'command').trim();
  const cwd = readStringField(record, 'cwd').trim();
  const rawShellType = readStringField(record, 'shellType').trim();
  const shellType = isShellType(rawShellType) ? rawShellType : settings.defaultShell;
  const sshCommand = readStringField(record, 'sshCommand').trim();
  if (!name) return null;
  if (shellType === 'ssh') {
    if (!sshCommand) return null;
  } else if (!cwd) {
    return null;
  }

  const session = sessionManager.createSession(name, cmd, cwd, shellType, '', sshCommand);
  forgetRemovedSession(session.id);
  saveSessions(getSessionsStateToSave());
  flushPendingTerminalUpdates(session.id);
  flushPendingTerminalEvents(session.id);
  return session;
}

function removeSessionById(id: string): void {
  const session = sessionManager.getSession(id);
  if (session?.status === 'detached' || session?.status === 'stopped' || session?.status === 'error') {
    markSessionRemoved(id);
    sessionManager.removeSession(id);
  } else {
    if (session) queueDisconnectSessionCommand(session);
    sessionManager.detachSession(id);
  }
  saveSessions(getSessionsStateToSave());
}

function processDeepLink(url: string): { ok: true; action: 'none' | 'open-vscode'; session?: Session } | { ok: false; error: string } {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch (error) {
    return { ok: false, error: `invalid URL: ${getErrorMessage(error)}` };
  }

  if (parsedUrl.protocol !== 'multitasker:') return { ok: true, action: 'none' };
  const createPath = isDeepLinkPath(parsedUrl, '/create', 'create');
  const terminalPath = isDeepLinkPath(parsedUrl, '/terminal', 'terminal');
  if (!createPath && !terminalPath) return { ok: false, error: `unsupported path "${parsedUrl.pathname}"` };

  const payloadParam = parsedUrl.searchParams.get('payload');
  if (!payloadParam) return { ok: false, error: 'missing payload' };

  let parsedPayload: unknown;
  try {
    parsedPayload = parseDeepLinkPayload(payloadParam);
  } catch (error) {
    return { ok: false, error: `invalid payload JSON: ${getErrorMessage(error)}` };
  }

  if (terminalPath) {
    const event = parseTerminalEventRequest(parsedPayload);
    if (event) {
      handleTerminalEvent(event);
      return { ok: true, action: 'none' };
    }

    const update = parseTerminalUpdateRequest(parsedPayload);
    if (!update) return { ok: false, error: 'invalid terminal payload' };
    handleTerminalUpdate(update);
    return { ok: true, action: 'none' };
  }

  const request = parseCreateSessionRequest(parsedPayload);
  if (!request) return { ok: false, error: 'invalid session payload' };

  if (request.id) forgetRemovedSession(request.id);
  if (request.vscodeWindowId) rememberVsCodeWindow({ windowId: request.vscodeWindowId });
  const session = sessionManager.createSession(
    request.name,
    request.cmd,
    request.cwd,
    request.shellType,
    request.id ?? '',
    request.sshCommand ?? '',
    request.vscodeWindowId ?? '',
    request.terminalRef ?? '',
    request.terminalPid
  );
  rememberTaskTerminalBinding(session.id, {
    vscodeWindowId: request.vscodeWindowId,
    terminalRef: request.terminalRef,
    terminalPid: request.terminalPid,
  });
  if (request.launchId) pendingLaunchTaskIdByLaunchId.set(request.launchId, session.id);
  saveSessions(getSessionsStateToSave());
  flushPendingTerminalUpdates(session.id);
  flushPendingTerminalEvents(session.id);
  return request.terminalRef ? { ok: true, action: 'none', session } : { ok: true, action: 'open-vscode', session };
}

function parseDeepLinkPayload(rawPayload: string): unknown {
  let current = rawPayload;
  for (let i = 0; i < 3; i += 1) {
    try {
      return JSON.parse(current);
    } catch {
      let decoded: string;
      try {
        decoded = decodeURIComponent(current);
      } catch {
        break;
      }
      if (decoded === current) break;
      current = decoded;
    }
  }
  throw new Error('Invalid payload JSON');
}

function isDeepLinkPath(parsedUrl: URL, pathName: string, hostName: string): boolean {
  return (
    parsedUrl.pathname === pathName ||
    (parsedUrl.hostname === hostName && (parsedUrl.pathname === '' || parsedUrl.pathname === '/'))
  );
}

function restorePersistedState(): void {
  const settings = loadSettings();
  for (const sessionState of loadSessions()) {
    const shellType = isShellType(String(sessionState.shellType)) ? sessionState.shellType : settings.defaultShell;
    sessionManager.createSession(
      sessionState.name,
      sessionState.cmd,
      sessionState.cwd,
      shellType,
      sessionState.id ?? '',
      sessionState.sshCommand ?? '',
      sessionState.vscodeWindowId ?? '',
      sessionState.terminalRef ?? '',
      sessionState.terminalPid
    );
  }
  for (const session of sessionManager.getSessions()) {
    if (session.terminalRef) taskIdByTerminalRef.set(session.terminalRef, session.id);
  }
  manualTasks.push(...loadManualTasks().slice(0, MAX_MANUAL_TASKS));
  recurringTasks.push(...loadRecurringTasks().slice(0, MAX_RECURRING_TASKS));
  slackNotifications.push(...loadSlackNotifications().slice(0, MAX_SLACK_NOTIFICATIONS));
  flushPendingTerminalUpdates();
  flushPendingTerminalEvents();
}

function getBackendState(): BackendState {
  return {
    sessions: sessionManager.getSessions(),
    manualTasks: manualTasks.map(cloneManualTask),
    recurringTasks: recurringTasks.map(cloneRecurringTask),
    slackNotifications: slackNotifications.map(cloneSlackNotification),
    vscodeWindows: [...vscodeWindowsById.values()].map(cloneVsCodeWindowEntry),
  };
}

function handleSseClient(response: ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  response.write(': connected\n\n');
  sseClients.add(response);
  writeSseEvent(response, 'state', getBackendState());
  response.on('close', () => {
    sseClients.delete(response);
  });
}

function broadcastSseEvent(event: string, payload: unknown): void {
  for (const client of [...sseClients]) {
    if (client.writableEnded) {
      sseClients.delete(client);
      continue;
    }
    writeSseEvent(client, event, payload);
  }
}

function writeSseEvent(response: ServerResponse, event: string, payload: unknown): void {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcastManualTasks(): void {
  broadcastSseEvent('manual-task:list-update', manualTasks.map(cloneManualTask));
  broadcastSseEvent('state', getBackendState());
}

function broadcastRecurringTasks(): void {
  broadcastSseEvent('recurring-task:list-update', recurringTasks.map(cloneRecurringTask));
  broadcastSseEvent('state', getBackendState());
}

function broadcastSlackListUpdate(): void {
  broadcastSseEvent('slack:list-update', slackNotifications.map(cloneSlackNotification));
  broadcastSseEvent('state', getBackendState());
}

function broadcastVsCodeWindowsUpdate(): void {
  broadcastSseEvent('vscode:windows-update', [...vscodeWindowsById.values()].map(cloneVsCodeWindowEntry));
  broadcastSseEvent('state', getBackendState());
}

function createManualTask(textValue: unknown): ManualTaskState | null {
  const text = typeof textValue === 'string' ? textValue.trim() : '';
  if (!text) return null;

  return storeManualTask({
    id: `manual-${randomUUID()}`,
    text: truncateTaskText(text),
    createdAt: Date.now(),
  });
}

function parseManualTaskAddRequest(payload: unknown): ManualTaskState | null {
  const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : undefined;
  const rawText = typeof payload === 'string'
    ? payload
    : readStringField(record, 'text') || readStringField(record, 'title') || readStringField(record, 'task');
  const text = rawText.trim();
  if (!text) return null;

  const id = readStringField(record, 'id').trim() || `manual-${randomUUID()}`;
  const createdAt = record ? readOptionalNumberField(record, 'createdAt') ?? Date.now() : Date.now();
  if (!Number.isFinite(createdAt)) return null;

  return {
    id,
    text: truncateTaskText(text),
    createdAt,
  };
}

function storeManualTask(task: ManualTaskState): ManualTaskState {
  const existingIndex = manualTasks.findIndex(existing => existing.id === task.id);
  if (existingIndex >= 0) manualTasks.splice(existingIndex, 1);
  manualTasks.unshift(cloneManualTask(task));
  while (manualTasks.length > MAX_MANUAL_TASKS) manualTasks.pop();
  saveManualTasks(manualTasks);
  broadcastManualTasks();
  return cloneManualTask(task);
}

function removeManualTask(id: string): boolean {
  const existingIndex = manualTasks.findIndex(task => task.id === id);
  if (existingIndex < 0) return false;

  manualTasks.splice(existingIndex, 1);
  saveManualTasks(manualTasks);
  broadcastManualTasks();
  return true;
}

function createRecurringTask(textValue: unknown, timeValue: unknown, scheduleValue: unknown): RecurringTaskState | null {
  const text = typeof textValue === 'string' ? textValue.trim() : '';
  const time = typeof timeValue === 'string' ? timeValue.trim() : '';
  const schedule = parseRecurringSchedule(scheduleValue);
  if (!text || parseRecurringTimeMinutes(time) === null || !schedule) return null;

  const now = new Date();
  const task: RecurringTaskState = {
    id: `recurring-${randomUUID()}`,
    text: truncateTaskText(text),
    time,
    frequency: schedule.frequency,
    daysOfWeek: schedule.daysOfWeek,
    createdAt: now.getTime(),
    enabled: true,
  };
  if (schedule.intervalDays !== undefined) task.intervalDays = schedule.intervalDays;
  if (schedule.dayOfMonth !== undefined) task.dayOfMonth = schedule.dayOfMonth;
  if (schedule.anchorDate) task.anchorDate = schedule.anchorDate;
  const initialGeneratedDate = getInitialRecurringTaskGeneratedDate(task, now);
  if (initialGeneratedDate) task.lastGeneratedDate = initialGeneratedDate;

  recurringTasks.unshift(task);
  while (recurringTasks.length > MAX_RECURRING_TASKS) recurringTasks.pop();
  saveRecurringTasks(recurringTasks);
  broadcastRecurringTasks();
  return cloneRecurringTask(task);
}

function removeRecurringTask(id: string): boolean {
  const existingIndex = recurringTasks.findIndex(task => task.id === id);
  if (existingIndex < 0) return false;

  recurringTasks.splice(existingIndex, 1);
  saveRecurringTasks(recurringTasks);
  broadcastRecurringTasks();
  return true;
}

function startRecurringTaskScheduler(): void {
  if (recurringTaskTimer) clearInterval(recurringTaskTimer);
  runDueRecurringTasks();
  recurringTaskTimer = setInterval(runDueRecurringTasks, RECURRING_TASK_CHECK_INTERVAL_MS);
}

function stopRecurringTaskScheduler(): void {
  if (!recurringTaskTimer) return;
  clearInterval(recurringTaskTimer);
  recurringTaskTimer = null;
}

function startGitHubReviewScheduler(): void {
  stopGitHubReviewScheduler();
  void pollGitHubReviewRequests();
  githubReviewTimer = setInterval(() => {
    void pollGitHubReviewRequests();
  }, getGitHubReviewPollIntervalMs());
}

function stopGitHubReviewScheduler(): void {
  if (!githubReviewTimer) return;
  clearInterval(githubReviewTimer);
  githubReviewTimer = null;
}

function getGitHubReviewPollIntervalMs(): number {
  const settings = loadSettings().githubReview;
  const pollMinutes = Number.isFinite(settings.pollMinutes)
    ? Math.max(1, Math.min(60, Math.floor(settings.pollMinutes)))
    : DEFAULT_GITHUB_REVIEW_POLL_MINUTES;
  return pollMinutes * 60 * 1000;
}

async function pollGitHubReviewRequests(): Promise<void> {
  if (githubReviewPollInFlight) return;
  const settings = loadSettings().githubReview;
  if (!settings.enabled) return;
  if (!settings.owner.trim() || !settings.repo.trim()) return;

  const token = getServerEnvValue(GITHUB_TOKEN_ENV).trim();
  if (!token) return;

  githubReviewPollInFlight = true;
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
    githubReviewPollInFlight = false;
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

function publishIntegrationManualTask(task: ManualTaskState): void {
  if (shouldBackendOwnState()) {
    storeManualTask(task);
    return;
  }
  broadcastSseEvent('manual-task:add', cloneManualTask(task));
}

function runDueRecurringTasks(now = new Date()): void {
  let changed = false;
  const today = getLocalDateKey(now);
  for (const task of recurringTasks) {
    if (!isRecurringTaskDue(task, now)) continue;
    if (task.lastGeneratedDate === today) continue;

    if (createManualTask(task.text)) {
      task.lastGeneratedDate = today;
      changed = true;
    }
  }

  if (changed) {
    saveRecurringTasks(recurringTasks);
    broadcastRecurringTasks();
  }
}

function isRecurringTaskDue(task: RecurringTaskState, now: Date): boolean {
  if (!task.enabled) return false;
  const taskMinutes = parseRecurringTimeMinutes(task.time);
  if (taskMinutes === null) return false;
  if (getLocalMinutesSinceMidnight(now) < taskMinutes) return false;

  const frequency = task.frequency ?? 'weekly';
  if (frequency === 'daily') return true;
  if (frequency === 'interval') return isRecurringIntervalDue(task, now);
  if (frequency === 'monthly') return isRecurringMonthlyDue(task, now);
  return task.daysOfWeek.includes(now.getDay());
}

function isRecurringIntervalDue(task: RecurringTaskState, now: Date): boolean {
  const intervalDays = task.intervalDays;
  if (intervalDays === undefined || intervalDays < 1) return false;
  const anchorDate = parseLocalDateKey(task.anchorDate || getLocalDateKey(new Date(task.createdAt)));
  if (!anchorDate) return false;
  const daysSinceAnchor = getLocalDateDiffDays(anchorDate, now);
  return daysSinceAnchor >= 0 && daysSinceAnchor % intervalDays === 0;
}

function isRecurringMonthlyDue(task: RecurringTaskState, now: Date): boolean {
  const dayOfMonth = task.dayOfMonth;
  if (dayOfMonth === undefined) return false;
  return now.getDate() === Math.min(dayOfMonth, getDaysInMonth(now));
}

function getInitialRecurringTaskGeneratedDate(task: RecurringTaskState, now: Date): string {
  if (!isRecurringTaskDue(task, now)) return '';
  return getLocalDateKey(now);
}

function normalizeRecurringDays(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const days = value
    .filter((day): day is number => typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6);
  return [...new Set(days)].sort((a, b) => a - b);
}

interface RecurringSchedule {
  frequency: RecurringTaskFrequency;
  daysOfWeek: number[];
  intervalDays?: number;
  dayOfMonth?: number;
  anchorDate?: string;
}

function parseRecurringSchedule(value: unknown): RecurringSchedule | null {
  if (Array.isArray(value)) {
    const daysOfWeek = normalizeRecurringDays(value);
    return daysOfWeek.length > 0 ? { frequency: 'weekly', daysOfWeek } : null;
  }

  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const frequency = normalizeRecurringFrequency(readStringField(record, 'frequency'));
  if (frequency === 'daily') return { frequency, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] };

  if (frequency === 'interval') {
    const intervalDays = normalizeRecurringIntervalDays(record['intervalDays']);
    if (intervalDays === null) return null;
    return { frequency, daysOfWeek: [], intervalDays, anchorDate: getLocalDateKey(new Date()) };
  }

  if (frequency === 'monthly') {
    const dayOfMonth = normalizeRecurringDayOfMonth(record['dayOfMonth']);
    if (dayOfMonth === null) return null;
    return { frequency, daysOfWeek: [], dayOfMonth };
  }

  const daysOfWeek = normalizeRecurringDays(record['daysOfWeek']);
  return daysOfWeek.length > 0 ? { frequency, daysOfWeek } : null;
}

function normalizeRecurringFrequency(value: string): RecurringTaskFrequency {
  return value === 'daily' || value === 'interval' || value === 'monthly' ? value : 'weekly';
}

function normalizeRecurringIntervalDays(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 3650 ? value : null;
}

function normalizeRecurringDayOfMonth(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 31 ? value : null;
}

function parseRecurringTimeMinutes(time: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours * 60 + minutes;
}

function getLocalMinutesSinceMidnight(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

function getLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseLocalDateKey(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

function getLocalDateDiffDays(start: Date, end: Date): number {
  const startUtc = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const endUtc = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.floor((endUtc - startUtc) / 86_400_000);
}

function getDaysInMonth(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

function truncateTaskText(text: string): string {
  if (text.length <= MAX_MANUAL_TASK_TEXT_LENGTH) return text;
  return `${text.slice(0, MAX_MANUAL_TASK_TEXT_LENGTH - 1)}…`;
}

function handleSlackNotification(notification: SlackNotificationState): void {
  const existingIndex = slackNotifications.findIndex(existing => existing.id === notification.id);
  if (existingIndex >= 0) slackNotifications.splice(existingIndex, 1);

  const mergeIndex = existingIndex < 0 ? findSlackNotificationMergeIndex(notification) : -1;
  const nextNotification = mergeIndex >= 0
    ? mergeSlackNotifications(slackNotifications.splice(mergeIndex, 1)[0], notification)
    : notification;

  slackNotifications.unshift(nextNotification);
  while (slackNotifications.length > MAX_SLACK_NOTIFICATIONS) slackNotifications.pop();
  saveSlackNotifications(slackNotifications);
  broadcastSseEvent('slack:notification', cloneSlackNotification(nextNotification));
  broadcastSlackListUpdate();
}

function findSlackNotificationMergeIndex(notification: SlackNotificationState): number {
  const mergeKey = getSlackNotificationMergeKey(notification);
  if (!mergeKey) return -1;
  return slackNotifications.findIndex(existing => getSlackNotificationMergeKey(existing) === mergeKey);
}

function getSlackNotificationMergeKey(notification: SlackNotificationState): string | null {
  const channelId = notification.channelId?.trim();
  if (!channelId) return null;
  const teamId = notification.teamId?.trim() ?? '';
  if (isSlackDirectMessageChannel(channelId, notification.channelType)) return `dm:${teamId}:${channelId}`;
  const threadRootTs = notification.threadTs?.trim() || notification.ts?.trim();
  return threadRootTs ? `thread:${teamId}:${channelId}:${threadRootTs}` : null;
}

function mergeSlackNotifications(
  existing: SlackNotificationState | undefined,
  incoming: SlackNotificationState
): SlackNotificationState {
  if (!existing) return incoming;
  const messageCount = (existing.messageCount ?? 1) + 1;
  const merged: SlackNotificationState = {
    id: existing.id,
    text: truncateSlackText(`${formatSlackNotificationMessageLine(existing)}\n${formatSlackNotificationMessageLine(incoming)}`),
    receivedAt: Math.max(existing.receivedAt, incoming.receivedAt),
    messageCount,
  };
  addOptionalSlackString(merged, 'teamId', existing.teamId || incoming.teamId || '');
  addOptionalSlackString(merged, 'teamName', existing.teamName || incoming.teamName || '');
  addOptionalSlackString(merged, 'channelId', existing.channelId || incoming.channelId || '');
  addOptionalSlackString(merged, 'channelName', existing.channelName || incoming.channelName || '');
  addOptionalSlackString(merged, 'channelType', existing.channelType || incoming.channelType || '');
  addOptionalSlackString(merged, 'userId', incoming.userId || existing.userId || '');
  addOptionalSlackString(merged, 'userName', incoming.userName || existing.userName || '');
  addOptionalSlackString(merged, 'ts', incoming.ts || existing.ts || '');
  addOptionalSlackString(merged, 'threadTs', existing.threadTs || incoming.threadTs || '');
  addOptionalSlackString(merged, 'permalink', incoming.permalink || existing.permalink || '');
  const rank = Math.min(existing.priorityRank ?? 4, incoming.priorityRank ?? 4);
  merged.priorityRank = rank;
  merged.priorityLabel = getSlackPriorityLabelForRank(rank);
  return merged;
}

function formatSlackNotificationMessageLine(notification: SlackNotificationState): string {
  const sender = notification.userName?.trim();
  const text = notification.text.trim() || '(no text)';
  return sender ? `${sender}: ${text}` : text;
}

function handleSlackNotificationDismiss(request: SlackNotificationDismissRequest): number {
  if (!isSlackDirectMessageChannel(request.channelId, request.channelType)) return 0;
  broadcastSseEvent('slack:dismiss', { ...request });
  const existingIndex = findSlackNotificationDismissIndex(request);
  if (existingIndex < 0) return 0;
  slackNotifications.splice(existingIndex, 1);
  saveSlackNotifications(slackNotifications);
  broadcastSlackListUpdate();
  return 1;
}

function findSlackNotificationDismissIndex(request: SlackNotificationDismissRequest): number {
  const targetTs = request.targetTs?.trim();
  if (targetTs) {
    return slackNotifications.findIndex(notification =>
      matchesSlackNotificationConversation(notification, request) &&
      (notification.ts === targetTs || notification.threadTs === targetTs)
    );
  }

  const replyTs = (request.replyTs ?? request.ts)?.trim();
  const replyAt = parseSlackTimestamp(replyTs);
  const receivedAt = request.receivedAt;
  let fallbackIndex = -1;
  let fallbackScore = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < slackNotifications.length; index += 1) {
    const notification = slackNotifications[index];
    if (!notification || !matchesSlackNotificationConversation(notification, request)) continue;

    const notificationTs = parseSlackTimestamp(notification.ts);
    if (replyAt !== null && notificationTs !== null) {
      if (notificationTs >= replyAt) continue;
      if (notificationTs > fallbackScore) {
        fallbackScore = notificationTs;
        fallbackIndex = index;
      }
      continue;
    }
    if (receivedAt !== undefined && notification.receivedAt > receivedAt) continue;
    return index;
  }
  return fallbackIndex;
}

function matchesSlackNotificationConversation(
  notification: SlackNotificationState,
  request: SlackNotificationDismissRequest
): boolean {
  if (notification.channelId !== request.channelId) return false;
  if (request.teamId && notification.teamId && notification.teamId !== request.teamId) return false;
  return true;
}

function removeSlackNotification(id: string): boolean {
  const existingIndex = slackNotifications.findIndex(existing => existing.id === id);
  if (existingIndex < 0) return false;
  slackNotifications.splice(existingIndex, 1);
  saveSlackNotifications(slackNotifications);
  broadcastSlackListUpdate();
  return true;
}

async function handleSlackEventEnvelope(envelope: unknown): Promise<void> {
  refreshSlackApiEnvFromDisk();
  const envelopeRecord = readSlackRecord(envelope);
  if (!envelopeRecord) {
    debugSlackEventDecision('ignored_invalid_envelope', {});
    return;
  }

  const envelopeType = readSlackString(envelopeRecord, 'type');
  if (envelopeType !== 'events_api') {
    debugSlackEventDecision('ignored_non_event', { type: envelopeType });
    return;
  }

  const payload = readSlackRecord(envelopeRecord, 'payload');
  const event = payload ? readSlackRecord(payload, 'event') : undefined;
  const envelopeId = readSlackString(envelopeRecord, 'envelope_id');
  if (!payload || !event) {
    debugSlackEventDecision('ignored_invalid_event', { envelopeId });
    return;
  }

  const channelId = readSlackString(event, 'channel');
  const ts = readSlackString(event, 'ts') || readSlackString(event, 'event_ts');
  const eventText = readSlackString(event, 'text') || readSlackString(event, 'fallback');
  if (readSlackBoolean(event, 'hidden') === true) {
    debugSlackEventDecision('ignored_hidden', { envelopeId, channelId, messageText: getSlackDebugTextPreview(eventText), ts });
    return;
  }

  const subtype = readSlackString(event, 'subtype');
  if (subtype === 'message_deleted' || subtype === 'message_changed') {
    debugSlackEventDecision('ignored_subtype', { envelopeId, channelId, subtype, messageText: getSlackDebugTextPreview(eventText), ts });
    return;
  }

  const notification = await buildSlackNotification(payload, event, subtype);
  if (notification) handleSlackNotification(notification);
}

async function buildSlackNotification(
  payload: Record<string, unknown>,
  event: Record<string, unknown>,
  subtype: string
): Promise<SlackNotificationState | null> {
  const teamId = readSlackString(payload, 'team_id') || readSlackString(readSlackRecord(payload, 'team'), 'id');
  const channelId = readSlackString(event, 'channel');
  const eventUserId = readSlackString(event, 'user');
  const botId = readSlackString(event, 'bot_id');
  const senderId = eventUserId || botId;
  const ts = readSlackString(event, 'ts') || readSlackString(event, 'event_ts');
  const text = readSlackString(event, 'text') || readSlackString(event, 'fallback') || '(no text)';
  if (!channelId && !text.trim()) return null;

  await initializeSlackAuthedUserId();
  rememberSlackAuthedUserThread(event);
  if (eventUserId && slackAuthedUserId && eventUserId === slackAuthedUserId) {
    const channelType = readSlackString(event, 'channel_type') || getSlackFallbackChannelType(channelId);
    if (isSlackDirectMessageChannel(channelId, channelType)) {
      const dismissRequest = buildSlackDismissRequest(payload, event, channelType);
      const removed = handleSlackNotificationDismiss(dismissRequest);
      debugSlackEventDecision('dismissed_self_dm', {
        channelId,
        channelType,
        eventUserId,
        authedUserId: slackAuthedUserId,
        messageText: getSlackDebugTextPreview(text),
        targetTs: dismissRequest.targetTs,
        replyTs: dismissRequest.replyTs,
        removed,
        ts,
      });
      return null;
    }

    debugSlackEventDecision('ignored_self', {
      channelId,
      channelType,
      eventUserId,
      authedUserId: slackAuthedUserId,
      messageText: getSlackDebugTextPreview(text),
      ts,
    });
    return null;
  }

  const channelInfo = channelId ? await getSlackChannelInfo(channelId) : undefined;
  if (channelId && !(await shouldAcceptSlackChannel(channelId, channelInfo))) {
    debugSlackEventDecision('ignored_not_member', {
      channelId,
      channelType: channelInfo?.type || getSlackFallbackChannelType(channelId),
      eventUserId,
      authedUserId: slackAuthedUserId,
      knownUserConversation: Boolean(slackAuthedUserConversationIds?.has(channelId)),
      messageText: getSlackDebugTextPreview(text),
      ts,
    });
    return null;
  }

  const userName = await getSlackMessageSenderName(event, eventUserId, botId);
  const channelName = getSlackNotificationChannelName(channelInfo, channelId, userName);
  const channelType = readSlackString(event, 'channel_type') || channelInfo?.type || '';
  const priority = await getSlackNotificationPriority(channelId, event, channelType, ts);
  const displayText = await resolveSlackMessageMentions(text);
  const permalink = channelId && ts ? await getSlackPermalink(channelId, ts) : '';
  const notification: SlackNotificationState = {
    id: ['slack', teamId, channelId, ts || Date.now().toString()].filter(Boolean).join(':'),
    text: truncateSlackText(displayText),
    receivedAt: Date.now(),
    priorityRank: priority.rank,
    priorityLabel: priority.label,
  };

  addOptionalSlackString(notification, 'teamId', teamId);
  addOptionalSlackString(notification, 'channelId', channelId);
  addOptionalSlackString(notification, 'channelName', channelName);
  addOptionalSlackString(notification, 'channelType', channelType);
  addOptionalSlackString(notification, 'userId', senderId);
  addOptionalSlackString(notification, 'userName', userName);
  addOptionalSlackString(notification, 'ts', ts);
  addOptionalSlackString(notification, 'threadTs', readSlackString(event, 'thread_ts'));
  addOptionalSlackString(notification, 'permalink', permalink);

  debugSlackEventDecision('accepted', {
    channelId,
    channelName,
    channelType: notification.channelType,
    subtype,
    eventUserId,
    userName,
    messageText: getSlackDebugTextPreview(displayText),
    rawMessageText: displayText !== text ? getSlackDebugTextPreview(text) : '',
    priority: priority.label,
    priorityRank: priority.rank,
    priorityReason: priority.reason,
    mentionsAuthedUser: priority.mentionsAuthedUser,
    directMessage: priority.directMessage,
    threadReply: priority.threadReply,
    threadWrittenByAuthedUser: priority.threadWrittenByAuthedUser,
    threadTs: priority.threadTs,
    authedUserId: slackAuthedUserId,
    knownUserConversation: channelId ? Boolean(slackAuthedUserConversationIds?.has(channelId)) : false,
    ts,
  });
  return notification;
}

async function getSlackNotificationPriority(
  channelId: string,
  event: Record<string, unknown>,
  channelType: string,
  ts: string
): Promise<SlackNotificationPriorityDecision> {
  const threadTs = readSlackString(event, 'thread_ts');
  const isThreadReply = Boolean(threadTs && threadTs !== ts);
  const mentionsAuthedUser = slackAuthedUserId ? slackEventMentionsUser(event, slackAuthedUserId) : false;
  const directMessage = isSlackDirectMessageChannel(channelId, channelType);
  const threadWrittenByAuthedUser = isThreadReply
    ? await isSlackThreadWrittenByAuthedUser(channelId, threadTs, event)
    : false;
  const details = {
    mentionsAuthedUser,
    directMessage,
    threadReply: isThreadReply,
    threadWrittenByAuthedUser,
    ...(threadTs ? { threadTs } : {}),
  };

  if (mentionsAuthedUser && !isThreadReply) {
    return { ...SLACK_PRIORITY_MENTION, ...details, reason: 'message mentions authed user' };
  }
  if (directMessage) {
    return { ...SLACK_PRIORITY_DM, ...details, reason: 'direct message channel' };
  }
  if (mentionsAuthedUser && isThreadReply) {
    return { ...SLACK_PRIORITY_THREAD_MENTION, ...details, reason: 'thread reply mentions authed user' };
  }
  if (threadWrittenByAuthedUser) {
    return { ...SLACK_PRIORITY_THREAD_WRITTEN, ...details, reason: 'authed user participated in thread' };
  }
  return { ...SLACK_PRIORITY_OTHER, ...details, reason: 'no priority signal matched' };
}

function getSlackPriorityLabelForRank(rank: number): SlackNotificationPriorityLabel {
  switch (normalizeSlackPriorityRank(rank)) {
    case SLACK_PRIORITY_MENTION.rank:
      return SLACK_PRIORITY_MENTION.label;
    case SLACK_PRIORITY_DM.rank:
      return SLACK_PRIORITY_DM.label;
    case SLACK_PRIORITY_THREAD_MENTION.rank:
      return SLACK_PRIORITY_THREAD_MENTION.label;
    case SLACK_PRIORITY_THREAD_WRITTEN.rank:
      return SLACK_PRIORITY_THREAD_WRITTEN.label;
    default:
      return SLACK_PRIORITY_OTHER.label;
  }
}

function slackEventMentionsUser(event: Record<string, unknown>, userId: string): boolean {
  const mentionToken = `<@${userId}>`;
  return readSlackString(event, 'text').includes(mentionToken) ||
    readSlackString(event, 'fallback').includes(mentionToken) ||
    slackStructuredValueMentionsUser(event['blocks'], userId, mentionToken);
}

function slackStructuredValueMentionsUser(value: unknown, userId: string, mentionToken: string): boolean {
  if (typeof value === 'string') return value.includes(mentionToken);
  if (Array.isArray(value)) return value.some(item => slackStructuredValueMentionsUser(item, userId, mentionToken));

  const record = readSlackRecord(value);
  if (!record) return false;
  const type = readSlackString(record, 'type');
  if (type === 'user' && (readSlackString(record, 'user_id') === userId || readSlackString(record, 'user') === userId)) {
    return true;
  }

  return Object.entries(record).some(([key, nestedValue]) => {
    if (key === 'text' && typeof nestedValue === 'string') return nestedValue.includes(mentionToken);
    if (typeof nestedValue === 'object' && nestedValue !== null) {
      return slackStructuredValueMentionsUser(nestedValue, userId, mentionToken);
    }
    return typeof nestedValue === 'string' && nestedValue.includes(mentionToken);
  });
}

function rememberSlackAuthedUserThread(event: Record<string, unknown>): void {
  const eventUserId = readSlackString(event, 'user');
  if (!slackAuthedUserId || eventUserId !== slackAuthedUserId) return;

  const channelId = readSlackString(event, 'channel');
  const ts = readSlackString(event, 'ts') || readSlackString(event, 'event_ts');
  const threadTs = readSlackString(event, 'thread_ts') || ts;
  if (!channelId || !threadTs) return;

  slackThreadWrittenByAuthedUser.set(getSlackThreadKey(channelId, threadTs), true);
}

async function isSlackThreadWrittenByAuthedUser(
  channelId: string,
  threadTs: string,
  event: Record<string, unknown>
): Promise<boolean> {
  if (!channelId || !threadTs || !slackAuthedUserId) return false;

  const cacheKey = getSlackThreadKey(channelId, threadTs);
  const cached = slackThreadWrittenByAuthedUser.get(cacheKey);
  if (cached !== undefined) return cached;

  if (readSlackString(event, 'parent_user_id') === slackAuthedUserId) {
    slackThreadWrittenByAuthedUser.set(cacheKey, true);
    return true;
  }

  if (!getSlackWebApiToken()) return false;

  try {
    const response = await slackApiWithFallback('conversations.replies', [getSlackUserToken(), getSlackBotToken()], {
      channel: channelId,
      ts: threadTs,
      limit: 200,
    });
    const messages = Array.isArray(response['messages']) ? response['messages'] : [];
    const wroteThread = messages.some(message => {
      const messageRecord = readSlackRecord(message);
      return readSlackString(messageRecord, 'user') === slackAuthedUserId;
    });
    slackThreadWrittenByAuthedUser.set(cacheKey, wroteThread);
    return wroteThread;
  } catch (error) {
    debugSlackLog('Could not inspect Slack thread participation', {
      channelId,
      threadTs,
      error: getErrorMessage(error),
    });
    return false;
  }
}

function getSlackThreadKey(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}

function buildSlackDismissRequest(
  payload: Record<string, unknown>,
  event: Record<string, unknown>,
  channelType: string
): SlackNotificationDismissRequest {
  const ts = readSlackString(event, 'ts') || readSlackString(event, 'event_ts');
  const threadTs = readSlackString(event, 'thread_ts');
  const targetTs = threadTs && threadTs !== ts ? threadTs : '';
  const request: SlackNotificationDismissRequest = {
    channelId: readSlackString(event, 'channel'),
  };

  const teamId = readSlackString(payload, 'team_id') || readSlackString(readSlackRecord(payload, 'team'), 'id');
  if (teamId) request.teamId = teamId;
  if (channelType) request.channelType = channelType;
  if (targetTs) request.targetTs = targetTs;
  if (ts) {
    request.replyTs = ts;
    request.ts = ts;
  }
  request.reason = 'self_dm_reply';
  request.receivedAt = Date.now();
  return request;
}

async function shouldAcceptSlackChannel(channelId: string, channelInfo: SlackChannelInfo | undefined): Promise<boolean> {
  if (!isSlackOnlyUserChannelsEnabled()) return true;

  const channelType = channelInfo?.type || getSlackFallbackChannelType(channelId);
  if (channelType === 'im' || channelType === 'mpim') return true;
  if (channelInfo?.isUserMember === true) return true;
  if (await isSlackAuthedUserConversation(channelId)) return true;
  return false;
}

async function isSlackAuthedUserConversation(channelId: string): Promise<boolean> {
  if (!isSlackOnlyUserChannelsEnabled()) return true;
  const userToken = getSlackUserToken();
  if (!userToken) return false;

  await initializeSlackAuthedUserId();
  if (!slackAuthedUserId) return false;

  const stale = Date.now() - slackAuthedUserConversationsLoadedAt > SLACK_USER_CONVERSATIONS_REFRESH_MS;
  if (!slackAuthedUserConversationIds || stale) {
    try {
      await refreshSlackAuthedUserConversations();
    } catch (error) {
      debugSlackLog('Could not refresh Slack user conversations', { error: getErrorMessage(error) });
      return false;
    }
  }
  return Boolean(slackAuthedUserConversationIds?.has(channelId));
}

async function refreshSlackAuthedUserConversations(): Promise<void> {
  if (!isSlackOnlyUserChannelsEnabled()) return;
  const userToken = getSlackUserToken();
  if (!userToken || !slackAuthedUserId) return;

  const conversationIds = new Set<string>();
  let cursor = '';
  do {
    const payload: Record<string, unknown> = {
      user: slackAuthedUserId,
      types: 'public_channel,private_channel,mpim,im',
      exclude_archived: true,
      limit: 1000,
    };
    if (cursor) payload['cursor'] = cursor;

    const response = await slackApi('users.conversations', userToken, payload);
    const channels = Array.isArray(response['channels']) ? response['channels'] : [];
    for (const channelValue of channels) {
      const channel = readSlackRecord(channelValue);
      const id = channel ? readSlackString(channel, 'id') : '';
      if (id) conversationIds.add(id);
    }

    cursor = readSlackString(readSlackRecord(response, 'response_metadata'), 'next_cursor');
  } while (cursor);

  slackAuthedUserConversationIds = conversationIds;
  slackAuthedUserConversationsLoadedAt = Date.now();
  debugSlackLog('Loaded Slack conversations for authed user membership filtering', {
    count: conversationIds.size,
  });
}

async function initializeSlackAuthedUserId(): Promise<void> {
  if (slackAuthedUserId || !getSlackUserToken()) return;

  try {
    const response = await slackApi('auth.test', getSlackUserToken(), {});
    slackAuthedUserId = readSlackString(response, 'user_id');
    if (slackAuthedUserId) debugSlackLog('Slack authed user resolved', { authedUserId: slackAuthedUserId });
  } catch (error) {
    debugSlackLog('Could not resolve Slack authed user', { error: getErrorMessage(error) });
  }
}

async function getSlackMessageSenderName(
  event: Record<string, unknown>,
  userId: string,
  botId: string
): Promise<string> {
  const botProfile = readSlackRecord(event, 'bot_profile');
  return readSlackString(event, 'username') ||
    readSlackString(botProfile, 'name') ||
    readSlackString(botProfile, 'real_name') ||
    (userId ? await getSlackUserName(userId) : '') ||
    botId;
}

async function getSlackUserName(userId: string): Promise<string> {
  if (!getSlackWebApiToken() || !userId || slackUserNameById.has(userId)) {
    return slackUserNameById.get(userId) || userId;
  }

  try {
    const response = await slackApiWithFallback('users.info', [getSlackUserToken(), getSlackBotToken()], { user: userId });
    const user = readSlackRecord(response, 'user');
    const profile = user ? readSlackRecord(user, 'profile') : undefined;
    const name = readSlackString(profile, 'display_name') ||
      readSlackString(profile, 'real_name') ||
      readSlackString(user, 'name') ||
      userId;
    slackUserNameById.set(userId, name);
    return name;
  } catch (error) {
    debugSlackLog('Could not resolve Slack user', { userId, error: getErrorMessage(error) });
    slackUserNameById.set(userId, userId);
    return userId;
  }
}

async function getSlackBotName(botId: string): Promise<string> {
  if (!getSlackWebApiToken() || !botId || slackBotNameById.has(botId)) {
    return slackBotNameById.get(botId) || botId;
  }

  try {
    const response = await slackApiWithFallback('bots.info', [getSlackBotToken(), getSlackUserToken()], { bot: botId });
    const bot = readSlackRecord(response, 'bot');
    const botUserId = readSlackString(bot, 'user_id');
    const userName = botUserId ? await getSlackUserName(botUserId) : '';
    const name = userName ||
      readSlackString(bot, 'name') ||
      readSlackString(bot, 'real_name') ||
      readSlackString(bot, 'app_name') ||
      botId;
    slackBotNameById.set(botId, name);
    return name;
  } catch (error) {
    debugSlackLog('Could not resolve Slack bot', { botId, error: getErrorMessage(error) });
    slackBotNameById.set(botId, botId);
    return botId;
  }
}

async function resolveSlackMessageMentions(text: string): Promise<string> {
  const mentions = getSlackMentionIds(text);
  if (mentions.length === 0) return text;

  const resolvedNames = new Map<string, string>();
  await Promise.all(mentions.map(async mentionId => {
    resolvedNames.set(mentionId, await getSlackMentionName(mentionId));
  }));

  return text.replace(/<@([A-Z0-9]+)(?:\|([^>]+))?>/g, (_match, mentionId: string, fallbackName: string | undefined) => {
    const resolvedName = resolvedNames.get(mentionId);
    const fallback = fallbackName?.trim().replace(/^@/, '') || '';
    const displayName = resolvedName && resolvedName !== mentionId ? resolvedName : (fallback || resolvedName || mentionId);
    return `@${displayName}`;
  });
}

function getSlackMentionIds(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]+)?>/g)) {
    const id = match[1]?.trim();
    if (id) ids.add(id);
  }
  return [...ids];
}

async function getSlackMentionName(mentionId: string): Promise<string> {
  return mentionId.startsWith('B')
    ? getSlackBotName(mentionId)
    : getSlackUserName(mentionId);
}

function getSlackNotificationChannelName(
  channelInfo: SlackChannelInfo | undefined,
  channelId: string,
  senderName: string
): string {
  if (channelInfo?.type === 'im') {
    if (channelInfo.name && !isRawSlackId(channelInfo.name)) return channelInfo.name;
    if (senderName && !isRawSlackId(senderName)) return senderName;
    return channelId;
  }

  return channelInfo?.name || channelId;
}

async function getSlackChannelInfo(channelId: string): Promise<SlackChannelInfo | undefined> {
  if (!channelId) return undefined;
  const cachedInfo = slackChannelInfoById.get(channelId);
  if (cachedInfo) return cachedInfo;

  const webApiToken = getSlackWebApiToken();
  if (!webApiToken) {
    const info = { name: channelId, isUserMember: true, type: getSlackFallbackChannelType(channelId) };
    slackChannelInfoById.set(channelId, info);
    return info;
  }

  try {
    const response = await slackApi('conversations.info', getSlackUserToken() || webApiToken, { channel: channelId });
    const channel = readSlackRecord(response, 'channel');
    const type = getSlackChannelType(channel, channelId);
    const channelUserId = readSlackString(channel, 'user');
    const channelUserName = channelUserId ? await getSlackUserName(channelUserId) : '';
    const name = type === 'im'
      ? (channelUserName || channelUserId || channelId)
      : (readSlackString(channel, 'name') || channelUserName || channelUserId || channelId);
    const info = {
      name,
      isUserMember: getSlackUserChannelMembership(channel),
      type,
    };
    slackChannelInfoById.set(channelId, info);
    return info;
  } catch (error) {
    debugSlackLog('Could not resolve Slack channel', { channelId, error: getErrorMessage(error) });
    const canVerifyMembership = isSlackOnlyUserChannelsEnabled() && Boolean(getSlackUserToken());
    const knownUserConversation = Boolean(slackAuthedUserConversationIds?.has(channelId));
    const info = {
      name: channelId,
      isUserMember: !canVerifyMembership || knownUserConversation,
      type: getSlackFallbackChannelType(channelId),
    };
    slackChannelInfoById.set(channelId, info);
    return info;
  }
}

function getSlackChannelType(channel: Record<string, unknown> | undefined, channelId: string): string {
  if (readSlackBoolean(channel, 'is_im')) return 'im';
  if (readSlackBoolean(channel, 'is_mpim')) return 'mpim';
  if (readSlackBoolean(channel, 'is_private')) return 'private_channel';
  return getSlackFallbackChannelType(channelId);
}

function getSlackFallbackChannelType(channelId: string): string {
  if (channelId.startsWith('D')) return 'im';
  if (channelId.startsWith('G')) return 'private_channel';
  return 'channel';
}

function getSlackUserChannelMembership(channel: Record<string, unknown> | undefined): boolean {
  if (!isSlackOnlyUserChannelsEnabled() || !getSlackUserToken()) return true;

  const isMember = readSlackBoolean(channel, 'is_member');
  if (typeof isMember === 'boolean') return isMember;
  if (readSlackBoolean(channel, 'is_im') || readSlackBoolean(channel, 'is_mpim')) return true;
  return false;
}

async function getSlackPermalink(channelId: string, messageTs: string): Promise<string> {
  if (!getSlackWebApiToken()) return '';

  try {
    const response = await slackApiWithFallback('chat.getPermalink', [getSlackUserToken(), getSlackBotToken()], {
      channel: channelId,
      message_ts: messageTs,
    });
    return readSlackString(response, 'permalink');
  } catch (error) {
    debugSlackLog('Could not resolve Slack permalink', { channelId, messageTs, error: getErrorMessage(error) });
    return '';
  }
}

async function slackApi(
  method: string,
  token: string,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const trimmedToken = token.trim();
  if (!trimmedToken) throw new Error(`${method} failed: missing Slack token`);

  try {
    const response: unknown = await getSlackClient(trimmedToken).apiCall(method, payload);
    const responseRecord = readSlackRecord(response);
    if (!responseRecord) throw new Error('Slack returned an invalid response');
    return responseRecord;
  } catch (error) {
    throw new Error(formatSlackApiError(method, error));
  }
}

function getSlackClient(token: string): WebClient {
  const cachedClient = slackClientByToken.get(token);
  if (cachedClient) return cachedClient;

  const client = new WebClient(token);
  slackClientByToken.set(token, client);
  return client;
}

function formatSlackApiError(method: string, error: unknown): string {
  const errorRecord = readSlackRecord(error);
  const data = errorRecord ? readSlackRecord(errorRecord, 'data') : undefined;
  if (data) {
    const details = [
      readSlackString(data, 'error'),
      readSlackString(data, 'needed') ? `needed=${readSlackString(data, 'needed')}` : '',
      readSlackString(data, 'provided') ? `provided=${readSlackString(data, 'provided')}` : '',
    ].filter(Boolean);

    details.push(...readSlackStringArray(readSlackRecord(data, 'response_metadata'), 'messages'));
    if (details.length > 0) return `${method} failed: ${details.join('; ')}`;
  }

  return `${method} failed: ${getErrorMessage(error)}`;
}

async function slackApiWithFallback(
  method: string,
  tokens: string[],
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const usableTokens = tokens.filter(token => token.trim());
  let lastError: unknown;
  for (const token of usableTokens) {
    try {
      return await slackApi(method, token, payload);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error(`${method} failed: missing Slack token`);
}

function refreshSlackApiEnvFromDisk(): void {
  const nextEnv = readSlackEnvFromDisk();
  const fingerprint = JSON.stringify(nextEnv);
  if (fingerprint === slackApiEnvFingerprint) return;
  slackApiEnvFingerprint = fingerprint;
  resetSlackApiState(nextEnv);
}

function readSlackEnvFromDisk(): Record<string, string> {
  const candidates = [
    path.join(process.cwd(), SLACK_ENV_RELATIVE_PATH),
    path.join(__dirname, '..', SLACK_ENV_RELATIVE_PATH),
  ];
  const envPath = candidates.find(candidate => fs.existsSync(candidate));
  return envPath ? readEnvFile(envPath) : {};
}

function loadSeenGitHubReviewRequests(): void {
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
  const baseDirectory = storageDirectory || path.join(process.cwd(), '.multitasker-data');
  return path.join(baseDirectory, 'github-review-seen.json');
}

function getGoogleCalendarOAuthConfig(): GoogleCalendarOAuthConfig {
  return {
    clientId: getServerEnvValue(GOOGLE_CALENDAR_CLIENT_ID_ENV),
    clientSecret: getServerEnvValue(GOOGLE_CALENDAR_CLIENT_SECRET_ENV),
  };
}

function getServerEnvValue(key: string): string {
  const processValue = process.env[key];
  if (typeof processValue === 'string' && processValue.trim()) return processValue.trim();
  const fileValue = readServerEnvFromDisk()[key];
  return typeof fileValue === 'string' ? fileValue.trim() : '';
}

function readServerEnvFromDisk(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const fileName of SERVER_ENV_FILE_NAMES) {
    const candidates = [
      path.join(process.cwd(), fileName),
      path.join(__dirname, '..', fileName),
    ];
    const envPath = candidates.find(candidate => fs.existsSync(candidate));
    if (envPath) Object.assign(env, readEnvFile(envPath));
  }
  return env;
}

function readEnvFile(envPath: string): Record<string, string> {
  return parseEnvContent(fs.readFileSync(envPath, 'utf8'));
}

function parseEnvContent(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('#')) continue;

    const equalsIndex = trimmedLine.indexOf('=');
    if (equalsIndex <= 0) continue;

    const key = trimmedLine.slice(0, equalsIndex).trim();
    const value = unquoteEnvValue(trimmedLine.slice(equalsIndex + 1).trim());
    if (key) env[key] = value;
  }
  return env;
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function resetSlackApiState(nextSlackEnv: Record<string, string>): void {
  slackApiEnv = nextSlackEnv;
  slackUserNameById.clear();
  slackBotNameById.clear();
  slackChannelInfoById.clear();
  slackClientByToken.clear();
  slackThreadWrittenByAuthedUser.clear();
  slackAuthedUserId = getSlackApiEnvValue('SLACK_USER_ID');
  slackAuthedUserConversationIds = undefined;
  slackAuthedUserConversationsLoadedAt = 0;
}

function getSlackApiEnvValue(key: string): string {
  const processValue = process.env[key];
  if (typeof processValue === 'string' && processValue.trim()) return processValue.trim();

  const envValue = slackApiEnv[key];
  return typeof envValue === 'string' ? envValue.trim() : '';
}

function getSlackUserToken(): string {
  return getSlackApiEnvValue('SLACK_USER_TOKEN');
}

function getSlackBotToken(): string {
  return getSlackApiEnvValue('SLACK_BOT_TOKEN');
}

function getSlackWebApiToken(): string {
  return getSlackUserToken() || getSlackBotToken();
}

function isSlackOnlyUserChannelsEnabled(): boolean {
  return getSlackApiEnvValue('SLACK_ONLY_USER_CHANNELS') !== '0';
}

function debugSlackEventDecision(decision: string, details: Record<string, unknown>): void {
  debugSlackLog(`Slack event ${decision}`, details);
}

function debugSlackLog(message: string, details: Record<string, unknown> = {}): void {
  appendSlackDebugLog(message, details);
}

function readSlackRecord(value: unknown, key?: string): Record<string, unknown> | undefined {
  const candidate = key && typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : value;
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : undefined;
}

function readSlackString(record: Record<string, unknown> | undefined, key: string): string {
  if (!record) return '';
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readSlackStringArray(record: Record<string, unknown> | undefined, key: string): string[] {
  if (!record) return [];
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map(item => item.trim());
}

function readSlackBoolean(record: Record<string, unknown> | undefined, key: string): boolean | undefined {
  if (!record) return undefined;
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function isRawSlackId(value: string): boolean {
  return /^[A-Z][A-Z0-9]{8,}$/.test(value);
}

function getSlackDebugTextPreview(text: string): string {
  const preview = text.replace(/\s+/g, ' ').trim();
  if (preview.length <= MAX_SLACK_DEBUG_TEXT_LENGTH) return preview;
  return `${preview.slice(0, MAX_SLACK_DEBUG_TEXT_LENGTH - 1)}…`;
}

function parseSlackNotificationRequest(payload: unknown): SlackNotificationState | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const id = readStringField(record, 'id').trim();
  const receivedAt = readOptionalNumberField(record, 'receivedAt') ?? Date.now();
  if (!id || !Number.isFinite(receivedAt)) return null;

  const notification: SlackNotificationState = {
    id,
    text: truncateSlackText(readStringField(record, 'text').trim() || '(no text)'),
    receivedAt,
  };
  addOptionalSlackString(notification, 'teamId', readStringField(record, 'teamId'));
  addOptionalSlackString(notification, 'teamName', readStringField(record, 'teamName'));
  addOptionalSlackString(notification, 'channelId', readStringField(record, 'channelId'));
  addOptionalSlackString(notification, 'channelName', readStringField(record, 'channelName'));
  addOptionalSlackString(notification, 'channelType', readStringField(record, 'channelType'));
  addOptionalSlackString(notification, 'userId', readStringField(record, 'userId'));
  addOptionalSlackString(notification, 'userName', readStringField(record, 'userName'));
  addOptionalSlackString(notification, 'ts', readStringField(record, 'ts'));
  addOptionalSlackString(notification, 'threadTs', readStringField(record, 'threadTs'));
  addOptionalSlackString(notification, 'permalink', readStringField(record, 'permalink'));
  const messageCount = readOptionalNumberField(record, 'messageCount');
  if (messageCount !== undefined && messageCount > 1) notification.messageCount = Math.floor(messageCount);
  const priorityRank = readOptionalNumberField(record, 'priorityRank');
  if (priorityRank !== undefined) notification.priorityRank = normalizeSlackPriorityRank(priorityRank);
  const priorityLabel = readStringField(record, 'priorityLabel').trim();
  if (isSlackNotificationPriorityLabel(priorityLabel)) notification.priorityLabel = priorityLabel;
  return notification;
}

function parseSlackNotificationDismissRequest(payload: unknown): SlackNotificationDismissRequest | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const channelId = readStringField(record, 'channelId').trim();
  if (!channelId) return null;

  const request: SlackNotificationDismissRequest = { channelId };
  const teamId = readStringField(record, 'teamId').trim();
  if (teamId) request.teamId = teamId;
  const channelType = readStringField(record, 'channelType').trim();
  if (channelType) request.channelType = channelType;
  const reason = readStringField(record, 'reason').trim();
  if (reason) request.reason = reason;
  const targetTs = readStringField(record, 'targetTs').trim();
  if (targetTs) request.targetTs = targetTs;
  const replyTs = readStringField(record, 'replyTs').trim();
  if (replyTs) request.replyTs = replyTs;
  const ts = readStringField(record, 'ts').trim();
  if (ts) request.ts = ts;
  const receivedAt = readOptionalNumberField(record, 'receivedAt');
  if (receivedAt !== undefined) request.receivedAt = receivedAt;
  return request;
}

function addOptionalSlackString(
  notification: SlackNotificationState,
  key: Exclude<keyof SlackNotificationState, 'id' | 'text' | 'receivedAt' | 'messageCount' | 'priorityRank' | 'priorityLabel'>,
  value: string
): void {
  const trimmedValue = value.trim();
  if (trimmedValue) notification[key] = trimmedValue;
}

function truncateSlackText(text: string): string {
  if (text.length <= MAX_SLACK_TEXT_LENGTH) return text;
  return `${text.slice(0, MAX_SLACK_TEXT_LENGTH - 1)}…`;
}

function normalizeSlackPriorityRank(value: number): number {
  if (!Number.isFinite(value)) return 4;
  return Math.max(0, Math.min(4, Math.floor(value)));
}

function isSlackNotificationPriorityLabel(value: string): value is NonNullable<SlackNotificationState['priorityLabel']> {
  return value === 'mention' ||
    value === 'dm' ||
    value === 'thread_mention' ||
    value === 'thread_written' ||
    value === 'other';
}

function isSlackDirectMessageChannel(channelId: string, channelType?: string): boolean {
  return channelType === 'im' || channelType === 'mpim' || channelId.startsWith('D');
}

function parseSlackTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseVsCodeWindowRegistration(payload: unknown): VsCodeWindowRegistration | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const windowId = readStringField(record, 'windowId').trim();
  if (!windowId) return null;

  const registration: VsCodeWindowRegistration = { windowId };
  const workspaceFolder = readStringField(record, 'workspaceFolder').trim();
  if (workspaceFolder) registration.workspaceFolder = workspaceFolder;
  const workspaceName = readStringField(record, 'workspaceName').trim();
  if (workspaceName) registration.workspaceName = workspaceName;
  const pid = readOptionalNumberField(record, 'pid');
  if (pid !== undefined) registration.pid = pid;
  if (Array.isArray(record['terminals'])) {
    registration.terminals = record['terminals']
      .map(parseVsCodeTerminalRegistration)
      .filter((terminal): terminal is VsCodeTerminalRegistration => terminal !== null);
  }
  if (Array.isArray(record['sessionIds'])) registration.sessionIds = readStringArrayField(record, 'sessionIds');
  return registration;
}

function parseVsCodeTerminalRegistration(payload: unknown): VsCodeTerminalRegistration | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const terminalRef = readStringField(record, 'terminalRef').trim();
  if (!terminalRef) return null;

  const terminal: VsCodeTerminalRegistration = { terminalRef };
  const terminalName = readStringField(record, 'terminalName').trim();
  if (terminalName) terminal.terminalName = terminalName;
  const terminalCwd = readStringField(record, 'terminalCwd').trim();
  if (terminalCwd) terminal.terminalCwd = terminalCwd;
  const rawShellType = readStringField(record, 'shellType').trim();
  if (isShellType(rawShellType)) terminal.shellType = rawShellType;
  const terminalPid = readOptionalNumberField(record, 'terminalPid');
  if (terminalPid !== undefined) terminal.terminalPid = terminalPid;
  const isActive = readOptionalBooleanField(record, 'isActive');
  if (isActive !== undefined) terminal.isActive = isActive;
  const rawCaptureState = readStringField(record, 'captureState').trim();
  if (isTerminalCaptureState(rawCaptureState)) terminal.captureState = rawCaptureState;
  const captureReason = readStringField(record, 'captureReason').trim();
  if (captureReason) terminal.captureReason = captureReason;
  return terminal;
}

function rememberVsCodeWindow(registration: VsCodeWindowRegistration): void {
  const existingEntry = vscodeWindowsById.get(registration.windowId);
  const entry: VsCodeWindowEntry = {
    windowId: registration.windowId,
    lastSeenAt: Date.now(),
  };
  const workspaceFolder = registration.workspaceFolder ?? existingEntry?.workspaceFolder;
  if (workspaceFolder) entry.workspaceFolder = workspaceFolder;
  const workspaceName = registration.workspaceName ?? existingEntry?.workspaceName;
  if (workspaceName) entry.workspaceName = workspaceName;
  const pid = registration.pid ?? existingEntry?.pid;
  if (pid !== undefined) entry.pid = pid;
  if (registration.terminals !== undefined) {
    entry.terminals = registration.terminals;
  } else if (existingEntry?.terminals !== undefined) {
    entry.terminals = existingEntry.terminals;
  }
  if (registration.sessionIds !== undefined) {
    entry.sessionIds = registration.sessionIds;
  } else if (existingEntry?.sessionIds !== undefined) {
    entry.sessionIds = existingEntry.sessionIds;
  }

  vscodeWindowsById.set(registration.windowId, entry);
  bindSessionsToVsCodeTerminals(entry);
  bindSessionsToVsCodeWindow(registration);
  broadcastVsCodeWindowsUpdate();
}

function bindSessionsToVsCodeTerminals(registration: VsCodeWindowEntry): void {
  const terminals = registration.terminals ?? [];
  if (terminals.length === 0) return;

  let didBindSession = false;
  const boundSessionIds = new Set<string>();
  const bindTerminal = (session: Session, terminal: VsCodeTerminalRegistration, matchReason: string): void => {
    if (boundSessionIds.has(session.id)) return;
    const previousTerminalRef = session.terminalRef;
    const reboundSession = sessionManager.bindSessionToTerminal(session.id, buildTerminalBinding({
      vscodeWindowId: registration.windowId,
      terminalRef: terminal.terminalRef,
      terminalPid: terminal.terminalPid,
      terminalCaptureState: terminal.captureState,
      terminalCaptureReason: terminal.captureReason,
    }));
    if (!reboundSession) return;
    if (previousTerminalRef && previousTerminalRef !== terminal.terminalRef) taskIdByTerminalRef.delete(previousTerminalRef);
    taskIdByTerminalRef.set(terminal.terminalRef, reboundSession.id);
    boundSessionIds.add(reboundSession.id);
    if (previousTerminalRef !== terminal.terminalRef || session.status === 'detached') {
      didBindSession = true;
      debugTerminalUpdate('session rebound to vscode terminal', {
        id: reboundSession.id,
        sessionName: reboundSession.name,
        vscodeWindowId: registration.windowId,
        terminalRef: terminal.terminalRef,
        terminalPid: terminal.terminalPid,
        terminalName: terminal.terminalName,
        terminalCwd: terminal.terminalCwd,
        matchReason,
      });
    }
  };

  for (const terminal of terminals) {
    const session = findKnownSessionForTerminalRef(terminal.terminalRef);
    if (session) bindTerminal(session, terminal, 'known terminalRef');
  }
  for (const terminal of terminals) {
    if (taskIdByTerminalRef.has(terminal.terminalRef)) continue;
    const match = findSessionForTerminalRegistration(registration, terminal, boundSessionIds);
    if (match) bindTerminal(match.session, terminal, match.reason);
  }
  if (didBindSession) saveSessions(getSessionsStateToSave());
}

function findKnownSessionForTerminalRef(terminalRef: string): Session | null {
  const mappedTaskId = taskIdByTerminalRef.get(terminalRef);
  if (mappedTaskId) return sessionManager.getSession(mappedTaskId);
  return sessionManager.getSessions().find(session => session.terminalRef === terminalRef) ?? null;
}

function findSessionForTerminalRegistration(
  registration: VsCodeWindowEntry,
  terminal: VsCodeTerminalRegistration,
  excludedSessionIds: ReadonlySet<string>
): VsCodeSessionTerminalMatch | null {
  const sessions = sessionManager.getSessions().filter(session => !excludedSessionIds.has(session.id));
  const exactRef = sessions.find(session => session.terminalRef === terminal.terminalRef);
  if (exactRef) return { session: exactRef, reason: 'exact terminalRef' };
  if (terminal.terminalPid !== undefined) {
    const exactPid = sessions.find(session =>
      (session.terminalPid ?? getLegacyAttachedTerminalPid(session.id)) === terminal.terminalPid
    );
    if (exactPid) return { session: exactPid, reason: 'exact terminalPid' };
  }

  const terminalPath = normalizePathForCompare(terminal.terminalCwd ?? '');
  if (!terminalPath) return null;
  const matchingTerminals = (registration.terminals ?? [])
    .filter(candidate => normalizePathForCompare(candidate.terminalCwd ?? '') === terminalPath);
  if (matchingTerminals.length > 1) return null;

  const matchingSessions = sessions.filter(session =>
    !session.terminalRef?.trim() &&
    (!session.vscodeWindowId || session.vscodeWindowId === registration.windowId) &&
    normalizePathForCompare(session.cwd) === terminalPath
  );
  if (matchingSessions.length > 1) return null;
  const matchingSession = matchingSessions[0];
  return matchingSession ? { session: matchingSession, reason: 'unique cwd fallback' } : null;
}

function bindSessionsToVsCodeWindow(registration: VsCodeWindowRegistration): void {
  if (!registration.sessionIds || registration.sessionIds.length === 0) return;
  let didBindSession = false;
  for (const sessionId of registration.sessionIds) {
    const previousSession = sessionManager.getSession(sessionId);
    const reboundSession = sessionManager.bindSessionToVsCodeWindow(sessionId, registration.windowId);
    if (!previousSession || !reboundSession || previousSession.vscodeWindowId === reboundSession.vscodeWindowId) continue;
    didBindSession = true;
  }
  if (didBindSession) saveSessions(getSessionsStateToSave());
}

function handleVsCodeCommandPoll(requestUrl: URL, response: ServerResponse): void {
  const windowId = requestUrl.searchParams.get('windowId')?.trim();
  if (!windowId) {
    writeJsonResponse(response, 400, { ok: false, error: 'missing_window_id' });
    return;
  }

  rememberVsCodeWindow(readVsCodeWindowRegistrationFromUrl(requestUrl, windowId));
  const commands = pendingVsCodeCommandsByWindowId.get(windowId) ?? [];
  if (commands.length > 0) {
    pendingVsCodeCommandsByWindowId.delete(windowId);
    writeVsCodeCommandPollResponse(response, commands);
    return;
  }

  completePendingVsCodeCommandPoll(windowId, []);
  const timeout = setTimeout(() => {
    const pendingPoll = pendingVsCodeCommandPollsByWindowId.get(windowId);
    if (!pendingPoll || pendingPoll.response !== response) return;
    pendingVsCodeCommandPollsByWindowId.delete(windowId);
    writeVsCodeCommandPollResponse(response, []);
  }, VSCODE_COMMAND_LONG_POLL_TIMEOUT_MS);
  pendingVsCodeCommandPollsByWindowId.set(windowId, { response, timeout });
  response.on('close', () => {
    const pendingPoll = pendingVsCodeCommandPollsByWindowId.get(windowId);
    if (!pendingPoll || pendingPoll.response !== response) return;
    clearTimeout(pendingPoll.timeout);
    pendingVsCodeCommandPollsByWindowId.delete(windowId);
  });
}

function enqueueVsCodeCommand(windowId: string, command: VsCodeCommand): void {
  const queue = pendingVsCodeCommandsByWindowId.get(windowId) ?? [];
  queue.push(command);
  while (queue.length > MAX_PENDING_VSCODE_COMMANDS_PER_WINDOW) queue.shift();
  pendingVsCodeCommandsByWindowId.set(windowId, queue);
  flushPendingVsCodeCommandPoll(windowId);
}

function queueDisconnectSessionCommand(session: Pick<Session, 'id' | 'vscodeWindowId' | 'terminalRef'>): boolean {
  const windowId = session.vscodeWindowId?.trim();
  const currentSession = sessionManager.getSession(session.id) ?? session;
  const terminalRef = currentSession.terminalRef?.trim();
  if (!windowId || !terminalRef) return false;
  enqueueVsCodeCommand(windowId, { id: randomUUID(), type: 'disconnect-session', terminalRef });
  return true;
}

function flushPendingVsCodeCommandPoll(windowId: string): void {
  if (!pendingVsCodeCommandPollsByWindowId.has(windowId)) return;
  const commands = pendingVsCodeCommandsByWindowId.get(windowId) ?? [];
  pendingVsCodeCommandsByWindowId.delete(windowId);
  completePendingVsCodeCommandPoll(windowId, commands);
}

function completePendingVsCodeCommandPoll(windowId: string, commands: VsCodeCommand[]): void {
  const pendingPoll = pendingVsCodeCommandPollsByWindowId.get(windowId);
  if (!pendingPoll) return;
  clearTimeout(pendingPoll.timeout);
  pendingVsCodeCommandPollsByWindowId.delete(windowId);
  if (!pendingPoll.response.writableEnded) writeVsCodeCommandPollResponse(pendingPoll.response, commands);
}

function closePendingVsCodeCommandPolls(): void {
  for (const windowId of [...pendingVsCodeCommandPollsByWindowId.keys()]) {
    completePendingVsCodeCommandPoll(windowId, []);
  }
}

function writeVsCodeCommandPollResponse(response: ServerResponse, commands: VsCodeCommand[]): void {
  writeJsonResponse(response, 200, { ok: true, longPoll: true, commands });
}

function readVsCodeWindowRegistrationFromUrl(requestUrl: URL, windowId: string): VsCodeWindowRegistration {
  const registration: VsCodeWindowRegistration = { windowId };
  const workspaceFolder = requestUrl.searchParams.get('workspaceFolder')?.trim();
  if (workspaceFolder) registration.workspaceFolder = workspaceFolder;
  const workspaceName = requestUrl.searchParams.get('workspaceName')?.trim();
  if (workspaceName) registration.workspaceName = workspaceName;
  const rawPid = requestUrl.searchParams.get('pid');
  const pid = rawPid ? Number(rawPid) : NaN;
  if (Number.isFinite(pid)) registration.pid = pid;
  if (requestUrl.searchParams.get('sessionIdsKnown') === '1') {
    registration.sessionIds = requestUrl.searchParams.getAll('sessionId')
      .map(sessionId => sessionId.trim())
      .filter(sessionId => sessionId.length > 0);
  }
  return registration;
}

function parseCreateSessionRequest(payload: unknown): MultitaskerCreateSessionRequest | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const rawId = readStringField(record, 'id').trim() || readStringField(record, 'taskId').trim();
  const cwd = readStringField(record, 'cwd').trim();
  const rawShellType = readStringField(record, 'shellType').trim();
  const shellType = isShellType(rawShellType) ? rawShellType : 'powershell';
  const sshCommand = (readStringField(record, 'sshCommand') || readStringField(record, 'sshHost')).trim();
  const cmd = (readStringField(record, 'command') || readStringField(record, 'cmd')).trim();
  const name = readStringField(record, 'name').trim() || path.basename(cwd) || sshCommand || 'Session';
  const vscodeWindowId = readStringField(record, 'windowId').trim();
  const terminalRef = readStringField(record, 'terminalRef').trim();
  const terminalName = readStringField(record, 'terminalName').trim();
  const launchId = readStringField(record, 'launchId').trim();
  const terminalPid = readOptionalNumberField(record, 'terminalPid');
  const id = rawId ||
    (launchId ? pendingLaunchTaskIdByLaunchId.get(launchId) ?? '' : '') ||
    (terminalRef ? taskIdByTerminalRef.get(terminalRef) ?? '' : '');

  if (shellType === 'ssh') {
    if (!sshCommand) return null;
  } else if (!cwd) {
    return null;
  }

  const request: MultitaskerCreateSessionRequest = { name, cmd, cwd, shellType };
  if (id) request.id = id;
  if (sshCommand) request.sshCommand = sshCommand;
  if (vscodeWindowId) request.vscodeWindowId = vscodeWindowId;
  if (terminalRef) request.terminalRef = terminalRef;
  if (terminalPid !== undefined) request.terminalPid = terminalPid;
  if (terminalName) request.terminalName = terminalName;
  if (launchId) request.launchId = launchId;
  return request;
}

function parseTerminalUpdateRequest(payload: unknown): TerminalUpdate | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const id = readStringField(record, 'id').trim();
  const rawStatus = readStringField(record, 'status').trim();
  const occurredAt = readOptionalNumberField(record, 'occurredAt') ?? Date.now();
  if (!id || !isSessionStatus(rawStatus)) return null;

  const update: TerminalUpdate = { id, status: rawStatus, occurredAt };
  const exitCode = readOptionalNumberField(record, 'exitCode');
  if (exitCode !== undefined) update.exitCode = exitCode;
  const exitReason = readStringField(record, 'exitReason').trim();
  if (exitReason) update.exitReason = exitReason;
  const debugReason = readStringField(record, 'debugReason').trim();
  if (debugReason) update.debugReason = debugReason.slice(0, 500);
  return update;
}

function parseTerminalEventRequest(payload: unknown): TerminalEvent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const explicitTaskId = readStringField(record, 'taskId').trim() || readStringField(record, 'id').trim();
  const rawType = readStringField(record, 'type').trim();
  const occurredAt = readOptionalNumberField(record, 'occurredAt') ?? Date.now();
  if (!isTerminalEventType(rawType)) return null;

  const terminalRef = readStringField(record, 'terminalRef').trim();
  const launchId = readStringField(record, 'launchId').trim();
  const windowId = readStringField(record, 'windowId').trim();
  const terminalPid = readOptionalNumberField(record, 'terminalPid');
  const terminalName = readStringField(record, 'terminalName').trim();
  const terminalCwd = readStringField(record, 'terminalCwd').trim();
  const rawShellType = readStringField(record, 'shellType').trim();
  const shellType = isShellType(rawShellType) ? rawShellType : undefined;
  const id = resolveTerminalEventTaskId({
    explicitTaskId,
    terminalRef,
    launchId,
    windowId,
    terminalPid,
    terminalName,
    terminalCwd,
  });
  if (!id) return null;

  const event: TerminalEvent = { id, type: rawType, occurredAt };
  if (terminalRef) event.terminalRef = terminalRef;
  if (launchId) event.launchId = launchId;
  if (windowId) event.windowId = windowId;
  if (terminalPid !== undefined) event.terminalPid = terminalPid;
  if (terminalName) event.terminalName = terminalName;
  if (terminalCwd) event.terminalCwd = terminalCwd;
  if (shellType) event.shellType = shellType;
  const commandLine = readStringField(record, 'commandLine');
  if (commandLine) event.commandLine = commandLine;
  const executionId = readStringField(record, 'executionId').trim();
  if (executionId) event.executionId = executionId;
  const output = readStringField(record, 'output');
  if (output) event.output = output;
  const exitCode = readOptionalNumberField(record, 'exitCode');
  if (exitCode !== undefined) event.exitCode = exitCode;
  const exitReason = readStringField(record, 'exitReason').trim();
  if (exitReason) event.exitReason = exitReason;
  const hasLaunchCommand = readOptionalBooleanField(record, 'hasLaunchCommand');
  if (hasLaunchCommand !== undefined) event.hasLaunchCommand = hasLaunchCommand;
  const primary = readOptionalBooleanField(record, 'primary');
  if (primary !== undefined) event.primary = primary;
  const rawCaptureState = readStringField(record, 'captureState').trim();
  if (rawCaptureState && isTerminalCaptureState(rawCaptureState)) event.captureState = rawCaptureState;
  const captureReason = readStringField(record, 'captureReason').trim();
  if (captureReason) event.captureReason = captureReason.slice(0, 500);
  rememberTaskTerminalBinding(id, {
    vscodeWindowId: windowId,
    terminalRef,
    terminalPid,
    captureState: event.captureState,
    captureReason: event.captureReason,
  });
  return event;
}

function isTerminalEventRelayPayload(payload: unknown): payload is Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null) return false;
  const rawType = readStringField(payload as Record<string, unknown>, 'type').trim();
  return isTerminalEventType(rawType);
}

function resolveTerminalEventTaskId(identity: TerminalEventIdentity): string {
  if (identity.launchId) {
    const launchTaskId = pendingLaunchTaskIdByLaunchId.get(identity.launchId);
    if (launchTaskId) return launchTaskId;
  }
  if (identity.terminalRef) {
    const terminalTaskId = taskIdByTerminalRef.get(identity.terminalRef);
    if (terminalTaskId) return terminalTaskId;
  }
  if (identity.explicitTaskId) return identity.explicitTaskId;
  return findSessionForTerminalIdentity(identity)?.id ?? '';
}

function findSessionForTerminalIdentity(identity: TerminalEventIdentity): Session | null {
  const sessions = sessionManager.getSessions();
  const exactRef = identity.terminalRef
    ? sessions.find(session => session.terminalRef === identity.terminalRef)
    : undefined;
  if (exactRef) return exactRef;
  const exactPid = identity.terminalPid !== undefined
    ? sessions.find(session => (session.terminalPid ?? getLegacyAttachedTerminalPid(session.id)) === identity.terminalPid)
    : undefined;
  if (exactPid) return exactPid;
  const normalizedTerminalPath = normalizePathForCompare(identity.terminalCwd);
  if (!normalizedTerminalPath) return null;
  return sessions.find(session =>
    !session.terminalRef?.trim() &&
    (!identity.windowId || !session.vscodeWindowId || session.vscodeWindowId === identity.windowId) &&
    normalizePathForCompare(session.cwd) === normalizedTerminalPath
  ) ?? null;
}

function handleTerminalUpdate(update: TerminalUpdate): void {
  if (removedSessionIds.has(update.id)) {
    debugTerminalUpdate('terminal update ignored for removed session', terminalUpdateDebugDetails(update));
    return;
  }
  if (applyTerminalUpdate(update)) return;
  debugTerminalUpdate('terminal update queued for missing session', terminalUpdateDebugDetails(update));
  pendingTerminalUpdates.set(update.id, update);
}

function handleTerminalEvent(event: TerminalEvent): void {
  if (removedSessionIds.has(event.id)) {
    debugTerminalUpdate('terminal event ignored for removed session', terminalEventDebugDetails(event, event.terminalName));
    return;
  }
  if (event.windowId) rememberVsCodeWindow({ windowId: event.windowId });
  debugTerminalUpdate('terminal event received', terminalEventDebugDetails(event, getTerminalEventSessionName(event)));
  if (applyTerminalEvent(event)) return;
  debugTerminalUpdate('terminal event queued for missing session', terminalEventDebugDetails(event, getTerminalEventSessionName(event)));
  queuePendingTerminalEvent(event);
}

function applyTerminalUpdate(update: TerminalUpdate): boolean {
  const previousSession = sessionManager.getSession(update.id);
  const session = sessionManager.updateTerminalState(update);
  if (!session) {
    debugTerminalUpdate('terminal update could not be applied', terminalUpdateDebugDetails(update));
    return false;
  }
  debugTerminalUpdate('terminal update applied', {
    ...terminalUpdateDebugDetails(update),
    previousStatus: previousSession?.status,
    nextStatus: session.status,
  });
  saveSessionsAfterTerminalStatusChange(previousSession?.status, session.status);
  return true;
}

function applyTerminalEvent(event: TerminalEvent): boolean {
  const previousSession = sessionManager.getSession(event.id);
  const sessionName = previousSession?.name ?? event.terminalName;
  const result = sessionManager.updateTerminalEventWithDetails(event);
  if (!result) {
    debugTerminalUpdate('terminal event could not be applied', terminalEventDebugDetails(event, sessionName));
    return false;
  }
  const { session, statusUpdate } = result;
  debugTerminalUpdate('terminal event applied', {
    ...terminalEventDebugDetails(event, session.name),
    ...terminalEventStatusDebugDetails(statusUpdate),
    previousStatus: previousSession?.status,
    nextStatus: session.status,
  });
  saveSessionsAfterTerminalStatusChange(previousSession?.status, session.status);
  return true;
}

function saveSessionsAfterTerminalStatusChange(previousStatus: SessionStatus | undefined, nextStatus: SessionStatus): void {
  if (
    nextStatus === 'error' ||
    nextStatus === 'stopped' ||
    nextStatus === 'detached' ||
    previousStatus === 'error' ||
    previousStatus === 'stopped' ||
    previousStatus === 'detached'
  ) {
    saveSessions(getSessionsStateToSave());
  }
}

function queuePendingTerminalEvent(event: TerminalEvent): void {
  const events = pendingTerminalEvents.get(event.id) ?? [];
  events.push(event);
  if (events.length > MAX_PENDING_TERMINAL_EVENTS_PER_SESSION) events.shift();
  pendingTerminalEvents.set(event.id, events);
}

function flushPendingTerminalUpdates(id?: string): void {
  if (id) {
    const update = pendingTerminalUpdates.get(id);
    if (!update || !applyTerminalUpdate(update)) return;
    pendingTerminalUpdates.delete(id);
    return;
  }
  for (const sessionId of [...pendingTerminalUpdates.keys()]) flushPendingTerminalUpdates(sessionId);
}

function flushPendingTerminalEvents(id?: string): void {
  if (id) {
    const events = pendingTerminalEvents.get(id);
    if (!events) return;
    const remainingEvents: TerminalEvent[] = [];
    for (const event of events) {
      if (!applyTerminalEvent(event)) remainingEvents.push(event);
    }
    if (remainingEvents.length === 0) {
      pendingTerminalEvents.delete(id);
    } else {
      pendingTerminalEvents.set(id, remainingEvents);
    }
    return;
  }
  for (const sessionId of [...pendingTerminalEvents.keys()]) flushPendingTerminalEvents(sessionId);
}

function markSessionRemoved(id: string): void {
  removedSessionIds.add(id);
  pendingTerminalUpdates.delete(id);
  pendingTerminalEvents.delete(id);
}

function forgetRemovedSession(id: string): void {
  removedSessionIds.delete(id);
}

function rememberTaskTerminalBinding(
  taskId: string,
  binding: {
    vscodeWindowId?: string | undefined;
    terminalRef?: string | undefined;
    terminalPid?: number | undefined;
    captureState?: TerminalCaptureState | undefined;
    captureReason?: string | undefined;
  }
): void {
  const previousTerminalRef = sessionManager.getSession(taskId)?.terminalRef?.trim();
  const terminalRef = binding.terminalRef?.trim();
  if (previousTerminalRef && terminalRef && previousTerminalRef !== terminalRef) taskIdByTerminalRef.delete(previousTerminalRef);
  if (terminalRef) taskIdByTerminalRef.set(terminalRef, taskId);
  sessionManager.bindSessionToTerminal(taskId, buildTerminalBinding({
    vscodeWindowId: binding.vscodeWindowId,
    terminalRef,
    terminalPid: binding.terminalPid,
    terminalCaptureState: binding.captureState,
    terminalCaptureReason: binding.captureReason,
  }));
}

function buildTerminalBinding(binding: {
  vscodeWindowId?: string | undefined;
  terminalRef?: string | undefined;
  terminalPid?: number | undefined;
  terminalCaptureState?: TerminalCaptureState | undefined;
  terminalCaptureReason?: string | undefined;
}): TerminalBinding {
  const terminalBinding: TerminalBinding = {};
  const vscodeWindowId = binding.vscodeWindowId?.trim();
  if (vscodeWindowId) terminalBinding.vscodeWindowId = vscodeWindowId;
  const terminalRef = binding.terminalRef?.trim();
  if (terminalRef) terminalBinding.terminalRef = terminalRef;
  if (binding.terminalPid !== undefined) terminalBinding.terminalPid = binding.terminalPid;
  if (binding.terminalCaptureState) terminalBinding.terminalCaptureState = binding.terminalCaptureState;
  const terminalCaptureReason = binding.terminalCaptureReason?.trim();
  if (terminalCaptureReason) terminalBinding.terminalCaptureReason = terminalCaptureReason;
  return terminalBinding;
}

function getSessionsStateToSave(): SessionState[] {
  return sessionManager.getSessions()
    .filter(session => session.status !== 'error' && session.status !== 'stopped' && session.status !== 'detached')
    .map(session => ({
      id: session.id,
      name: session.name,
      cmd: session.cmd,
      cwd: session.cwd,
      shellType: session.shellType,
      ...(session.sshCommand ? { sshCommand: session.sshCommand } : {}),
      ...(session.vscodeWindowId ? { vscodeWindowId: session.vscodeWindowId } : {}),
      ...(session.terminalRef ? { terminalRef: session.terminalRef } : {}),
      ...(session.terminalPid !== undefined ? { terminalPid: session.terminalPid } : {}),
    }));
}

function normalizePathForCompare(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return path.normalize(trimmed).replace(/[\\/]+$/g, '').toLowerCase();
}

function getLegacyAttachedTerminalPid(sessionId: string): number | undefined {
  const match = /^attached:(\d+):/.exec(sessionId);
  if (!match?.[1]) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isLocalShellType(value: unknown): value is LocalShellType {
  return value === 'powershell' || value === 'bash';
}

function isShellType(value: unknown): value is ShellType {
  return isLocalShellType(value) || value === 'ssh';
}

function isSessionStatus(value: string): value is SessionStatus {
  return (
    value === 'waiting' ||
    value === 'starting' ||
    value === 'running' ||
    value === 'needs_attention' ||
    value === 'error' ||
    value === 'stopped' ||
    value === 'detached'
  );
}

function isTerminalEventType(value: string): value is TerminalEventType {
  return (
    value === 'terminal_opened' ||
    value === 'terminal_attached' ||
    value === 'terminal_capture_state' ||
    value === 'shell_execution_started' ||
    value === 'terminal_output' ||
    value === 'shell_execution_ended' ||
    value === 'terminal_closed' ||
    value === 'terminal_disconnected' ||
    value === 'terminal_visible' ||
    value === 'terminal_interacted'
  );
}

function isTerminalCaptureState(value: string): value is TerminalCaptureState {
  return value === 'waiting_for_execution' || value === 'capturing' || value === 'unavailable';
}

function readPayloadValue(payload: unknown, key: string): unknown {
  if (typeof payload !== 'object' || payload === null) return undefined;
  return (payload as Record<string, unknown>)[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readPayloadString(payload: unknown, key: string): string {
  const value = readPayloadValue(payload, key);
  return typeof value === 'string' ? value : '';
}

function readStringField(record: Record<string, unknown> | undefined, key: string): string {
  if (!record) return '';
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function readOptionalNumberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readOptionalBooleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readStringArrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(item => item.length > 0);
}

function cloneManualTask(task: ManualTaskState): ManualTaskState {
  return { ...task };
}

function cloneRecurringTask(task: RecurringTaskState): RecurringTaskState {
  return {
    ...task,
    frequency: task.frequency ?? 'weekly',
    daysOfWeek: [...task.daysOfWeek],
  };
}

function cloneSlackNotification(notification: SlackNotificationState): SlackNotificationState {
  return { ...notification };
}

function cloneVsCodeWindowEntry(entry: VsCodeWindowEntry): VsCodeWindowEntry {
  const clone: VsCodeWindowEntry = {
    windowId: entry.windowId,
    lastSeenAt: entry.lastSeenAt,
  };
  if (entry.workspaceFolder) clone.workspaceFolder = entry.workspaceFolder;
  if (entry.workspaceName) clone.workspaceName = entry.workspaceName;
  if (entry.pid !== undefined) clone.pid = entry.pid;
  if (entry.terminals !== undefined) clone.terminals = entry.terminals.map(terminal => ({ ...terminal }));
  if (entry.sessionIds !== undefined) clone.sessionIds = [...entry.sessionIds];
  return clone;
}

class HttpBodyTooLargeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'HttpBodyTooLargeError';
  }
}

function readHttpBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let bodyBytes = 0;
    let rejected = false;
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      if (rejected) return;
      bodyBytes += Buffer.byteLength(chunk, 'utf8');
      if (bodyBytes > MAX_HTTP_BODY_BYTES) {
        rejected = true;
        reject(new HttpBodyTooLargeError('request payload is too large'));
        return;
      }
      body += chunk;
    });
    request.on('end', () => {
      if (!rejected) resolve(body);
    });
    request.on('error', error => {
      if (!rejected) reject(error);
    });
  });
}

function writeJsonResponse(response: ServerResponse, statusCode: number, body: unknown): void {
  const encodedBody = JSON.stringify(body);
  response.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(encodedBody),
  });
  response.end(encodedBody);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readBackendPort(): number {
  const value = Number(process.env['MULTITASKER_BACKEND_PORT']);
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : DEFAULT_PORT;
}

function isVsCodeCommandPath(requestPath: string): boolean {
  return requestPath === VSCODE_COMMAND_PATH || requestPath === EXTENSION_VSCODE_COMMAND_PATH;
}

function shouldBackendOwnState(): boolean {
  return process.env[BACKEND_OWNS_STATE_ENV] === '1';
}

function isTerminalUpdateDebugEnabled(): boolean {
  const value = process.env[TERMINAL_UPDATE_DEBUG_ENV]?.toLowerCase();
  return value === '1' || value === 'true';
}

function debugTerminalUpdate(message: string, details: Record<string, unknown> = {}): void {
  const serializedDetails = Object.entries(details)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatDebugValue(value)}`)
    .join(' ');
  const line = `[multitasker backend terminal ${new Date().toISOString()}] ${message}${
    serializedDetails ? ` ${serializedDetails}` : ''
  }`;
  appendTerminalDebugLog(line, details);
  if (isTerminalUpdateDebugEnabled()) console.info(line);
}

function appendTerminalDebugLog(line: string, details: Record<string, unknown>): void {
  const sessionId = getDebugLogSessionId(details);
  if (!sessionId) return;
  const filePath = getTerminalDebugLogFilePath(sessionId, details);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${line}\n`, 'utf8');
  } catch (error) {
    reportDebugLogWriteFailure(`Could not write backend terminal debug log "${filePath}": ${getErrorMessage(error)}`);
  }
}

function appendSlackDebugLog(message: string, details: Record<string, unknown> = {}): void {
  const serializedDetails = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${formatDebugValue(value)}`)
    .join(' ');
  const filePath = path.join(process.cwd(), DEBUG_LOG_DIRECTORY, SLACK_SOCKET_DEBUG_LOG_FILE);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `[multitasker backend slack ${new Date().toISOString()}] ${message}${serializedDetails ? ` ${serializedDetails}` : ''}\n`, 'utf8');
  } catch (error) {
    reportDebugLogWriteFailure(`Could not write backend Slack debug log "${filePath}": ${getErrorMessage(error)}`);
  }
}

function getTerminalDebugLogFilePath(sessionId: string, details: Record<string, unknown>): string {
  const existingFilePath = terminalDebugLogFileBySessionId.get(sessionId);
  if (existingFilePath) return existingFilePath;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const sessionName = getDebugLogSessionName(sessionId, details);
  const fileName = [
    timestamp,
    sanitizeDebugLogFilePart(sessionName, 'unknown-session', 80),
    sanitizeDebugLogFilePart(sessionId, 'unknown-id', 140),
  ].join('-');
  const filePath = path.join(process.cwd(), DEBUG_LOG_DIRECTORY, `${fileName}${DEBUG_LOG_FILE_EXTENSION}`);
  terminalDebugLogFileBySessionId.set(sessionId, filePath);
  return filePath;
}

function getDebugLogSessionId(details: Record<string, unknown>): string | undefined {
  const value = details['id'];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getDebugLogSessionName(sessionId: string, details: Record<string, unknown>): string {
  const detailSessionName = details['sessionName'];
  if (typeof detailSessionName === 'string' && detailSessionName.trim()) return detailSessionName.trim();
  const session = sessionManager.getSession(sessionId);
  if (session?.name.trim()) return session.name.trim();
  const terminalName = details['terminalName'];
  if (typeof terminalName === 'string' && terminalName.trim()) return terminalName.trim();
  return 'unknown-session';
}

function sanitizeDebugLogFilePart(value: string, fallback: string, maxLength: number): string {
  const sanitized = value
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const safeValue = sanitized || fallback;
  if (safeValue.length <= maxLength) return safeValue;
  const hash = createHash('sha256').update(safeValue).digest('hex').slice(0, 8);
  return `${safeValue.slice(0, maxLength - hash.length - 1)}-${hash}`;
}

function reportDebugLogWriteFailure(message: string): void {
  if (reportedDebugLogWriteFailures.has(message)) return;
  reportedDebugLogWriteFailures.add(message);
  console.warn(message);
}

function formatDebugValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function terminalUpdateDebugDetails(update: TerminalUpdate): Record<string, unknown> {
  return {
    id: update.id,
    status: update.status,
    occurredAt: update.occurredAt,
    exitCode: update.exitCode,
    exitReason: update.exitReason,
    reason: update.debugReason,
    matchedText: update.debugMatchedText,
  };
}

function terminalEventStatusDebugDetails(update: TerminalUpdate | undefined): Record<string, unknown> {
  if (!update) {
    return {
      statusUpdate: false,
      statusReason: 'terminal event did not produce a status update',
    };
  }
  return {
    statusUpdate: true,
    computedStatus: update.status,
    statusReason: update.debugReason,
    statusExitCode: update.exitCode,
    statusExitReason: update.exitReason,
  };
}

function terminalEventDebugDetails(event: TerminalEvent, sessionName?: string): Record<string, unknown> {
  return {
    id: event.id,
    sessionName,
    type: event.type,
    occurredAt: event.occurredAt,
    terminalRef: event.terminalRef,
    launchId: event.launchId,
    commandLine: event.commandLine,
    executionId: event.executionId,
    exitCode: event.exitCode,
    exitReason: event.exitReason,
    terminalName: event.terminalName,
    terminalCwd: event.terminalCwd,
    terminalPid: event.terminalPid,
    shellType: event.shellType,
    hasLaunchCommand: event.hasLaunchCommand,
    primary: event.primary,
    windowId: event.windowId,
    captureState: event.captureState,
    captureReason: event.captureReason,
    output: event.output === undefined ? undefined : terminalOutputDebugValue(event.output),
  };
}

function getTerminalEventSessionName(event: TerminalEvent): string | undefined {
  return sessionManager.getSession(event.id)?.name ?? event.terminalName;
}

function terminalOutputDebugValue(output: string): string {
  return output
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

appendSlackDebugLog('backend process started', { port: PORT, storageDirectory });
