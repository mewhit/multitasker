import path from 'node:path';

export const HOST = '127.0.0.1';
export const DEFAULT_PORT = 39017;
export const TERMINAL_UPDATE_PATH = '/terminal-update';
export const TERMINAL_EVENT_PATH = '/terminal-event';
export const SLACK_EVENT_PATH = '/slack/';
export const SLACK_NOTIFICATION_PATH = '/slack-notification';
export const SLACK_NOTIFICATION_DISMISS_PATH = '/slack-notification-dismiss';
export const EXTENSION_SLACK_EVENT_PATH = '/extensions/slack/events';
export const EXTENSION_SLACK_NOTIFICATION_PATH = '/extensions/slack/notifications';
export const EXTENSION_SLACK_NOTIFICATION_DISMISS_PATH = '/extensions/slack/notification-dismiss';
export const MAX_HTTP_BODY_BYTES = 512 * 1024;
export const MAX_MANUAL_TASKS = 200;
export const MAX_MANUAL_TASK_TEXT_LENGTH = 4000;
export const MAX_RECURRING_TASKS = 100;
export const RECURRING_TASK_CHECK_INTERVAL_MS = 30 * 1000;
export const MAX_SLACK_NOTIFICATIONS = 100;
export const MAX_SLACK_TEXT_LENGTH = 4000;
export const MAX_GOOGLE_CALENDAR_EVENTS = 100;
export const MAX_SLACK_DEBUG_TEXT_LENGTH = 700;
export const MAX_PENDING_TERMINAL_EVENTS_PER_SESSION = 200;
export const SLACK_USER_CONVERSATIONS_REFRESH_MS = 5 * 60 * 1000;
export const DEBUG_LOG_DIRECTORY = path.join('.tmp', 'http-server');
export const DEBUG_LOG_FILE_EXTENSION = '.log';
export const TERMINAL_UPDATE_DEBUG_ENV = 'MULTITASKER_DEBUG_TERMINAL';
export const SLACK_SOCKET_DEBUG_LOG_FILE = 'slack-connector.log';
export const SLACK_ENV_RELATIVE_PATH = path.join('extension', 'slack', '.env');
export const GOOGLE_CALENDAR_CLIENT_ID_ENV = 'MULTITASKER_GOOGLE_CALENDAR_CLIENT_ID';
export const GOOGLE_CALENDAR_CLIENT_SECRET_ENV = 'MULTITASKER_GOOGLE_CALENDAR_CLIENT_SECRET';
export const GITHUB_TOKEN_ENV = 'MULTITASKER_GITHUB_TOKEN';
export const GOOGLE_CALENDAR_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GITHUB_API_BASE_URL = 'https://api.github.com';
export const DEFAULT_GITHUB_REVIEW_POLL_MINUTES = 5;
export const SERVER_ENV_FILE_NAMES = ['.env', '.env.local'];

export function readBackendPort(): number {
  const value = Number(process.env['MULTITASKER_BACKEND_PORT']);
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : DEFAULT_PORT;
}

export const PORT = readBackendPort();

export function shouldBackendOwnState(): boolean {
  return true;
}

export function isTerminalUpdateDebugEnabled(): boolean {
  const value = process.env[TERMINAL_UPDATE_DEBUG_ENV]?.toLowerCase();
  return value === '1' || value === 'true';
}
