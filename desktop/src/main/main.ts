import { app, BrowserWindow, ipcMain, dialog, shell, screen, type BrowserWindowConstructorOptions, type Rectangle } from "electron";
import path from "node:path";
import fs from "node:fs";
import { exec, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, request, type ClientRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { SessionManager, type Session, type SessionStatus, type TerminalBinding, type TerminalUpdate } from "../sessionManager";
import { createShellPty as spawnShellPty, createShellSsh as spawnShellSsh, killShellSession } from "../shellServerClient";
import {
  loadSettings,
  saveSettings,
  setStorageDirectory,
  AppSettings,
  loadSessions,
  saveSessions,
  loadManualTasks,
  saveManualTasks,
  loadRecurringTasks,
  saveRecurringTasks,
  clearGoogleCalendarAuth,
  loadGoogleCalendarConnections,
  saveGoogleCalendarConnections,
  clearGoogleCalendarConnections,
  loadGoogleCalendarEvents,
  saveGoogleCalendarEvents,
  clearGoogleCalendarEvents,
  ManualTaskState,
  RecurringTaskState,
  RecurringTaskFrequency,
  GoogleCalendarAuthState,
  GoogleCalendarConnectionState,
  GoogleCalendarEventState,
  GoogleCalendarSettings,
  SessionState,
  ShellType,
  LocalShellType,
  loadWindowState,
  saveWindowState,
  type WindowState,
} from "../settings";
import type { TerminalCaptureState, TerminalEvent, TerminalEventType } from "../terminalEvents";

const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 800;
const WINDOW_MIN_WIDTH = 280;
const WINDOW_MIN_HEIGHT = 600;
const WINDOW_STATE_SAVE_DEBOUNCE_MS = 500;
const MIN_VISIBLE_WINDOW_AREA = 100;
const TERMINAL_UPDATE_HOST = "127.0.0.1";
const DEFAULT_TERMINAL_UPDATE_PORT = 39017;
const TERMINAL_UPDATE_PORT = readBackendPort();
const TERMINAL_UPDATE_PATH = "/terminal-update";
const TERMINAL_EVENT_PATH = "/terminal-event";
const BACKEND_HEALTH_PATH = "/api/health";
const BACKEND_STARTUP_WAIT_MS = 5000;
const BACKEND_PROBE_INTERVAL_MS = 100;
const BACKEND_PROBE_TIMEOUT_MS = 300;
const BACKEND_EVENTS_PATH = "/api/events";
const BACKEND_EVENTS_RECONNECT_MS = 1000;
const MAX_TERMINAL_EVENT_BODY_BYTES = 512 * 1024;
const MAX_MANUAL_TASKS = 200;
const MAX_MANUAL_TASK_TEXT_LENGTH = 4000;
const MAX_RECURRING_TASKS = 100;
const RECURRING_TASK_CHECK_INTERVAL_MS = 30 * 1000;
const MAX_PENDING_TERMINAL_EVENTS_PER_SESSION = 200;
const DEBUG_LOG_DIRECTORY = path.join(".tmp", "desktop");
const DEBUG_LOG_FILE_EXTENSION = ".log";
const TERMINAL_UPDATE_DEBUG_ENV = "MULTITASKER_DEBUG_TERMINAL";
const DISABLE_LEGACY_TERMINAL_SERVER_ENV = "MULTITASKER_DISABLE_LEGACY_TERMINAL_SERVER";
const GOOGLE_CALENDAR_SCOPE = "openid email profile https://www.googleapis.com/auth/calendar.readonly";
const GOOGLE_CALENDAR_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const GOOGLE_CALENDAR_API_BASE_URL = "https://www.googleapis.com/calendar/v3";
const GOOGLE_CALENDAR_OAUTH_HOST = "127.0.0.1";
const GOOGLE_CALENDAR_OAUTH_CALLBACK_PATH = "/oauth/google-calendar/callback";
const GOOGLE_CALENDAR_AUTH_TIMEOUT_MS = 2 * 60 * 1000;
const GOOGLE_CALENDAR_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const GOOGLE_CALENDAR_TOKEN_REFRESH_BUFFER_MS = 60 * 1000;
const MAX_GOOGLE_CALENDAR_EVENTS = 100;

interface GoogleCalendarStatus {
  connected: boolean;
  configured: boolean;
  enabled: boolean;
  calendarId: string;
  lookAheadDays: number;
  ownedCalendarsOnly: boolean;
  accountCount: number;
  eventCount: number;
  lastSyncedAt?: number;
  message: string;
  connections: GoogleCalendarConnectionStatus[];
}

interface GoogleCalendarOAuthConfig {
  clientId: string;
  hasClientSecret: boolean;
}

interface GoogleCalendarConnectionStatus {
  id: string;
  accountEmail?: string;
  accountName?: string;
  calendarId: string;
  lookAheadDays: number;
  enabled: boolean;
  connectedAt: number;
  lastSyncedAt?: number;
  authError?: string;
}

interface GoogleCalendarAuthResult {
  ok: boolean;
  message: string;
  status: GoogleCalendarStatus;
}

interface GoogleTokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType?: string;
  scope?: string;
}

interface GoogleCalendarRawEventDate {
  date?: string;
  dateTime?: string;
}

interface GoogleCalendarRawEvent {
  id?: string;
  status?: string;
  summary?: string;
  htmlLink?: string;
  location?: string;
  updated?: string;
  start?: GoogleCalendarRawEventDate;
  end?: GoogleCalendarRawEventDate;
}

interface GoogleCalendarEventsResponse {
  items?: GoogleCalendarRawEvent[];
}

interface GoogleCalendarListEntry {
  id: string;
  summary?: string;
  accessRole?: string;
  primary?: boolean;
}

interface GoogleUserInfo {
  id: string;
  email?: string;
  name?: string;
}

let mainWindow: BrowserWindow | null = null;
let sessionManager: SessionManager | null = null;
let terminalUpdateServer: Server | null = null;
let standaloneBackendSessions: Session[] | null = null;
let backendEventsRequest: ClientRequest | null = null;
let backendEventsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backendEventsSyncEnabled = false;
let backendEventsBuffer = "";
let backendEventsCurrentEvent = "message";
let backendEventsDataLines: string[] = [];
let windowStateSaveTimer: ReturnType<typeof setTimeout> | null = null;
const pendingTerminalUpdates = new Map<string, TerminalUpdate>();
const pendingTerminalEvents = new Map<string, TerminalEvent[]>();
const taskIdByTerminalRef = new Map<string, string>();
const terminalDebugLogFileBySessionId = new Map<string, string>();
const reportedDebugLogWriteFailures = new Set<string>();
const manualTasks: ManualTaskState[] = [];
const recurringTasks: RecurringTaskState[] = [];
const googleCalendarEvents: GoogleCalendarEventState[] = [];
let recurringTaskTimer: ReturnType<typeof setInterval> | null = null;
let googleCalendarRefreshTimer: ReturnType<typeof setInterval> | null = null;
let googleCalendarAuthServer: Server | null = null;
let googleCalendarLastSyncedAt = 0;
let googleCalendarOAuthConfigCache: GoogleCalendarOAuthConfig = { clientId: "", hasClientSecret: false };

function isLocalShellType(value: string): value is LocalShellType {
  return value === "powershell" || value === "bash";
}

function isShellType(value: string): value is ShellType {
  return isLocalShellType(value) || value === "ssh";
}

function isSessionStatus(value: string): value is SessionStatus {
  return (
    value === "waiting" ||
    value === "starting" ||
    value === "running" ||
    value === "needs_attention" ||
    value === "paused" ||
    value === "error" ||
    value === "stopped" ||
    value === "detached"
  );
}

function isTerminalEventType(value: string): value is TerminalEventType {
  return (
    value === "terminal_opened" ||
    value === "terminal_attached" ||
    value === "terminal_capture_state" ||
    value === "shell_execution_started" ||
    value === "terminal_output" ||
    value === "shell_execution_ended" ||
    value === "terminal_closed" ||
    value === "terminal_disconnected" ||
    value === "terminal_visible" ||
    value === "terminal_interacted"
  );
}

function isTerminalCaptureState(value: string): value is TerminalCaptureState {
  return value === "waiting_for_execution" || value === "capturing" || value === "unavailable";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function readOptionalNumberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readOptionalBooleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

class HttpBodyTooLargeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "HttpBodyTooLargeError";
  }
}

function normalizePathForCompare(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return path
    .normalize(trimmed)
    .replace(/[\\/]+$/g, "")
    .toLowerCase();
}

function getLegacyAttachedTerminalPid(sessionId: string): number | undefined {
  const match = /^attached:(\d+):/.exec(sessionId);
  if (!match?.[1]) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function rememberTaskTerminalBinding(
  taskId: string,
  binding: {
    terminalRef?: string | undefined;
    terminalPid?: number | undefined;
    captureState?: TerminalCaptureState | undefined;
    captureReason?: string | undefined;
  },
): void {
  const previousTerminalRef = sessionManager?.getSession(taskId)?.terminalRef?.trim();
  const terminalRef = binding.terminalRef?.trim();
  if (previousTerminalRef && terminalRef && previousTerminalRef !== terminalRef) {
    taskIdByTerminalRef.delete(previousTerminalRef);
  }
  if (terminalRef) taskIdByTerminalRef.set(terminalRef, taskId);
  sessionManager?.bindSessionToTerminal(
    taskId,
    buildTerminalBinding({
      terminalRef,
      terminalPid: binding.terminalPid,
      terminalCaptureState: binding.captureState,
      terminalCaptureReason: binding.captureReason,
    }),
  );
}

function buildTerminalBinding(binding: {
  terminalRef?: string | undefined;
  terminalPid?: number | undefined;
  terminalCaptureState?: TerminalCaptureState | undefined;
  terminalCaptureReason?: string | undefined;
}): TerminalBinding {
  const terminalBinding: TerminalBinding = {};

  const terminalRef = binding.terminalRef?.trim();
  if (terminalRef) terminalBinding.terminalRef = terminalRef;

  if (binding.terminalPid !== undefined) terminalBinding.terminalPid = binding.terminalPid;
  if (binding.terminalCaptureState) terminalBinding.terminalCaptureState = binding.terminalCaptureState;

  const terminalCaptureReason = binding.terminalCaptureReason?.trim();
  if (terminalCaptureReason) terminalBinding.terminalCaptureReason = terminalCaptureReason;
  return terminalBinding;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readBackendPort(): number {
  const value = Number(process.env["MULTITASKER_BACKEND_PORT"]);
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : DEFAULT_TERMINAL_UPDATE_PORT;
}

function isEnvFlagEnabled(name: string): boolean {
  const value = process.env[name]?.toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function isAddressInUseError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EADDRINUSE";
}

function backendUrl(pathname: string): string {
  return `http://${TERMINAL_UPDATE_HOST}:${TERMINAL_UPDATE_PORT}${pathname}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForStandaloneBackend(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await isStandaloneBackendHealthy()) return true;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    await delay(Math.min(BACKEND_PROBE_INTERVAL_MS, remainingMs));
  } while (Date.now() <= deadline);
  return false;
}

async function isStandaloneBackendHealthy(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, BACKEND_PROBE_TIMEOUT_MS);

  try {
    const response = await fetch(backendUrl(BACKEND_HEALTH_PATH), { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function getCurrentSessions(): Session[] {
  if (standaloneBackendSessions) return standaloneBackendSessions.map(cloneSession);
  return sessionManager?.getSessions() ?? [];
}

function cloneSession(session: Session): Session {
  return {
    ...session,
    ...(session.sshOptions ? { sshOptions: { ...session.sshOptions } } : {}),
    ...(session.clientMetadata ? { clientMetadata: { ...session.clientMetadata } } : {}),
  };
}

function startStandaloneBackendSync(): void {
  backendEventsSyncEnabled = true;
  if (backendEventsRequest || backendEventsReconnectTimer) return;
  connectStandaloneBackendEvents();
}

function stopStandaloneBackendSync(): void {
  backendEventsSyncEnabled = false;
  if (backendEventsReconnectTimer) {
    clearTimeout(backendEventsReconnectTimer);
    backendEventsReconnectTimer = null;
  }
  if (backendEventsRequest) {
    backendEventsRequest.destroy();
    backendEventsRequest = null;
  }
  backendEventsBuffer = "";
  backendEventsCurrentEvent = "message";
  backendEventsDataLines = [];
}

function connectStandaloneBackendEvents(): void {
  if (!backendEventsSyncEnabled || backendEventsRequest) return;

  const eventsUrl = new URL(backendUrl(BACKEND_EVENTS_PATH));
  const req = request(
    {
      hostname: eventsUrl.hostname,
      port: eventsUrl.port,
      path: `${eventsUrl.pathname}${eventsUrl.search}`,
      method: "GET",
      headers: { accept: "text/event-stream" },
    },
    (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        if (backendEventsRequest === req) backendEventsRequest = null;
        scheduleStandaloneBackendReconnect();
        return;
      }

      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        handleStandaloneBackendEventsChunk(chunk);
      });
      response.on("end", () => {
        if (backendEventsRequest === req) backendEventsRequest = null;
        scheduleStandaloneBackendReconnect();
      });
      response.on("error", () => {
        if (backendEventsRequest === req) backendEventsRequest = null;
        scheduleStandaloneBackendReconnect();
      });
    },
  );

  backendEventsRequest = req;
  req.on("error", () => {
    if (backendEventsRequest === req) backendEventsRequest = null;
    scheduleStandaloneBackendReconnect();
  });
  req.end();
}

function scheduleStandaloneBackendReconnect(): void {
  if (!backendEventsSyncEnabled || backendEventsReconnectTimer) return;
  backendEventsReconnectTimer = setTimeout(() => {
    backendEventsReconnectTimer = null;
    connectStandaloneBackendEvents();
  }, BACKEND_EVENTS_RECONNECT_MS);
}

function handleStandaloneBackendEventsChunk(chunk: string): void {
  backendEventsBuffer += chunk;
  let newlineIndex = backendEventsBuffer.indexOf("\n");
  while (newlineIndex >= 0) {
    let line = backendEventsBuffer.slice(0, newlineIndex);
    backendEventsBuffer = backendEventsBuffer.slice(newlineIndex + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    handleStandaloneBackendEventLine(line);
    newlineIndex = backendEventsBuffer.indexOf("\n");
  }
}

function handleStandaloneBackendEventLine(line: string): void {
  if (!line) {
    dispatchStandaloneBackendEvent();
    return;
  }
  if (line.startsWith(":")) return;

  const separatorIndex = line.indexOf(":");
  const field = separatorIndex >= 0 ? line.slice(0, separatorIndex) : line;
  let value = separatorIndex >= 0 ? line.slice(separatorIndex + 1) : "";
  if (value.startsWith(" ")) value = value.slice(1);

  if (field === "event") {
    backendEventsCurrentEvent = value || "message";
  } else if (field === "data") {
    backendEventsDataLines.push(value);
  }
}

function dispatchStandaloneBackendEvent(): void {
  const eventName = backendEventsCurrentEvent || "message";
  const data = backendEventsDataLines.join("\n");
  backendEventsCurrentEvent = "message";
  backendEventsDataLines = [];
  if (!data) return;

  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch (error) {
    console.warn(`Ignored invalid backend event payload: ${getErrorMessage(error)}`);
    return;
  }

  applyStandaloneBackendEvent(eventName, payload);
}

function applyStandaloneBackendEvent(eventName: string, payload: unknown): void {
  if (eventName === "state") {
    applyStandaloneBackendState(payload);
  } else if (eventName === "session:list-update") {
    applyStandaloneBackendSessions(payload);
  } else if (eventName === "manual-task:list-update") {
    applyStandaloneBackendManualTasks(payload);
  } else if (eventName === "recurring-task:list-update") {
    applyStandaloneBackendRecurringTasks(payload);
  }
}

function applyStandaloneBackendState(payload: unknown): void {
  if (!isRecord(payload)) return;
  applyStandaloneBackendSessions(payload["sessions"]);
  applyStandaloneBackendManualTasks(payload["manualTasks"]);
  applyStandaloneBackendRecurringTasks(payload["recurringTasks"]);
}

function applyStandaloneBackendSessions(payload: unknown): void {
  const sessions = normalizeBackendSessions(payload);
  if (!sessions) return;

  standaloneBackendSessions = sessions.map(cloneSession);
  syncBackendTerminalRefs(standaloneBackendSessions);
  mainWindow?.webContents.send("session:list-update", standaloneBackendSessions.map(cloneSession));
}

function applyStandaloneBackendManualTasks(payload: unknown): void {
  const tasks = normalizeBackendManualTasks(payload);
  if (!tasks) return;

  manualTasks.splice(0, manualTasks.length, ...tasks.map((task) => ({ ...task })));
  broadcastManualTasks();
}

function applyStandaloneBackendRecurringTasks(payload: unknown): void {
  const tasks = normalizeBackendRecurringTasks(payload);
  if (!tasks) return;

  recurringTasks.splice(0, recurringTasks.length, ...tasks.map(cloneRecurringTask));
  broadcastRecurringTasks();
}

function syncBackendTerminalRefs(sessions: Session[]): void {
  taskIdByTerminalRef.clear();
  for (const session of sessions) {
    if (session.terminalRef) taskIdByTerminalRef.set(session.terminalRef, session.id);
  }
}

function normalizeBackendSessions(payload: unknown): Session[] | null {
  if (!Array.isArray(payload)) return null;
  const sessions: Session[] = [];
  for (const value of payload) {
    const session = normalizeBackendSession(value);
    if (session) sessions.push(session);
  }
  return sessions;
}

function normalizeBackendSession(value: unknown): Session | null {
  if (!isRecord(value)) return null;
  const id = readStringField(value, "id").trim();
  const name = readStringField(value, "name").trim();
  const cmd = readStringField(value, "cmd");
  const cwd = readStringField(value, "cwd");
  const shellTypeValue = readStringField(value, "shellType").trim();
  const statusValue = readStringField(value, "status").trim();
  const lastActivity = readOptionalNumberField(value, "lastActivity");
  if (!id || !name || !isShellType(shellTypeValue) || !isSessionStatus(statusValue) || lastActivity === undefined) return null;

  const session: Session = {
    id,
    name,
    cmd,
    cwd,
    shellType: shellTypeValue,
    status: statusValue,
    lastActivity,
    gitChanges: readOptionalBooleanField(value, "gitChanges") ?? false,
  };

  const sshCommand = readStringField(value, "sshCommand").trim();
  if (sshCommand) session.sshCommand = sshCommand;

  const sshOptions = normalizeBackendSshOptions(value["sshOptions"]);
  if (sshOptions) session.sshOptions = sshOptions;

  const terminalRef = readStringField(value, "terminalRef").trim();
  if (terminalRef) session.terminalRef = terminalRef;

  const terminalPid = readOptionalNumberField(value, "terminalPid");
  if (terminalPid !== undefined) session.terminalPid = terminalPid;

  const terminalExitCode = readOptionalNumberField(value, "terminalExitCode");
  if (terminalExitCode !== undefined) session.terminalExitCode = terminalExitCode;

  const terminalExitReason = readStringField(value, "terminalExitReason").trim();
  if (terminalExitReason) session.terminalExitReason = terminalExitReason;

  const terminalCaptureState = readStringField(value, "terminalCaptureState").trim();
  if (terminalCaptureState && isTerminalCaptureState(terminalCaptureState)) session.terminalCaptureState = terminalCaptureState;

  const terminalCaptureReason = readStringField(value, "terminalCaptureReason").trim();
  if (terminalCaptureReason) session.terminalCaptureReason = terminalCaptureReason;

  const clientMetadata = normalizeBackendClientMetadata(value["clientMetadata"]);
  if (clientMetadata) session.clientMetadata = clientMetadata;

  return session;
}

function normalizeBackendSshOptions(value: unknown): Session["sshOptions"] | undefined {
  if (!isRecord(value)) return undefined;
  const host = readStringField(value, "host").trim();
  const username = readStringField(value, "username").trim();
  if (!host || !username) return undefined;

  const options: NonNullable<Session["sshOptions"]> = { host, username };
  const port = readOptionalNumberField(value, "port");
  if (port !== undefined && port > 0) options.port = port;
  const privateKeyPath = readStringField(value, "privateKeyPath").trim();
  if (privateKeyPath) options.privateKeyPath = privateKeyPath;
  const agent = readStringField(value, "agent").trim();
  if (agent) options.agent = agent;
  const initCommand = readStringField(value, "initCommand").trim();
  if (initCommand) options.initCommand = initCommand;
  return options;
}

function normalizeBackendClientMetadata(value: unknown): Session["clientMetadata"] | undefined {
  if (!isRecord(value)) return undefined;
  if (readStringField(value, "kind").trim() !== "vscode") return undefined;

  const metadata: NonNullable<Session["clientMetadata"]> = { kind: "vscode" };
  const workspace = readStringField(value, "workspace").trim();
  if (workspace) metadata.workspace = workspace;
  const ipcHook = readStringField(value, "ipcHook").trim();
  if (ipcHook) metadata.ipcHook = ipcHook;
  const pid = readOptionalNumberField(value, "pid");
  if (pid !== undefined && pid > 0) metadata.pid = pid;
  const version = readStringField(value, "version").trim();
  if (version) metadata.version = version;
  const termProgram = readStringField(value, "termProgram").trim();
  if (termProgram) metadata.termProgram = termProgram;
  return metadata;
}

function normalizeBackendManualTasks(payload: unknown): ManualTaskState[] | null {
  if (!Array.isArray(payload)) return null;
  const tasks: ManualTaskState[] = [];
  for (const value of payload) {
    if (!isRecord(value)) continue;
    const id = readStringField(value, "id").trim();
    const text = readStringField(value, "text").trim();
    const createdAt = readOptionalNumberField(value, "createdAt");
    if (!id || !text || createdAt === undefined) continue;
    tasks.push({ id, text, createdAt });
  }
  return tasks;
}

function normalizeBackendRecurringTasks(payload: unknown): RecurringTaskState[] | null {
  if (!Array.isArray(payload)) return null;
  const tasks: RecurringTaskState[] = [];
  for (const value of payload) {
    const task = normalizeBackendRecurringTask(value);
    if (task) tasks.push(task);
  }
  return tasks;
}

function normalizeBackendRecurringTask(value: unknown): RecurringTaskState | null {
  if (!isRecord(value)) return null;
  const id = readStringField(value, "id").trim();
  const text = readStringField(value, "text").trim();
  const time = readStringField(value, "time").trim();
  const createdAt = readOptionalNumberField(value, "createdAt");
  if (!id || !text || parseRecurringTimeMinutes(time) === null || createdAt === undefined) return null;

  const frequency = normalizeRecurringFrequency(readStringField(value, "frequency").trim());
  const daysOfWeek = normalizeRecurringDays(value["daysOfWeek"]);
  if (frequency === "weekly" && daysOfWeek.length === 0) return null;

  const task: RecurringTaskState = {
    id,
    text,
    time,
    frequency,
    daysOfWeek: frequency === "daily" && daysOfWeek.length === 0 ? [0, 1, 2, 3, 4, 5, 6] : daysOfWeek,
    createdAt,
    enabled: readOptionalBooleanField(value, "enabled") ?? true,
  };

  const intervalDays = normalizeRecurringIntervalDays(value["intervalDays"]);
  if (frequency === "interval") {
    if (intervalDays === null) return null;
    task.intervalDays = intervalDays;
    const anchorDate = readStringField(value, "anchorDate").trim();
    if (anchorDate) task.anchorDate = anchorDate;
  }

  const dayOfMonth = normalizeRecurringDayOfMonth(value["dayOfMonth"]);
  if (frequency === "monthly") {
    if (dayOfMonth === null) return null;
    task.dayOfMonth = dayOfMonth;
  }

  const lastGeneratedDate = readStringField(value, "lastGeneratedDate").trim();
  if (lastGeneratedDate) task.lastGeneratedDate = lastGeneratedDate;
  return task;
}

async function postStandaloneBackend(pathname: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(backendUrl(pathname), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await readStandaloneBackendJsonResponse(response);
  if (!response.ok || payload["ok"] !== true) {
    const error = readStringField(payload, "error").trim() || `HTTP ${response.status}`;
    throw new Error(error);
  }
  return payload;
}

async function readStandaloneBackendJsonResponse(response: Response): Promise<Record<string, unknown>> {
  try {
    const payload: unknown = await response.json();
    return isRecord(payload) ? payload : {};
  } catch {
    return {};
  }
}

function removeStandaloneBackendSession(id: string): void {
  if (!standaloneBackendSessions) return;
  standaloneBackendSessions = standaloneBackendSessions.filter((session) => session.id !== id);
  syncBackendTerminalRefs(standaloneBackendSessions);
  mainWindow?.webContents.send("session:list-update", standaloneBackendSessions.map(cloneSession));
}

function removeStandaloneBackendManualTask(id: string): void {
  const existingIndex = manualTasks.findIndex((task) => task.id === id);
  if (existingIndex < 0) return;
  manualTasks.splice(existingIndex, 1);
  broadcastManualTasks();
}

function removeStandaloneBackendRecurringTask(id: string): void {
  const existingIndex = recurringTasks.findIndex((task) => task.id === id);
  if (existingIndex < 0) return;
  recurringTasks.splice(existingIndex, 1);
  broadcastRecurringTasks();
}

function isTerminalUpdateDebugEnabled(): boolean {
  const value = process.env[TERMINAL_UPDATE_DEBUG_ENV]?.toLowerCase();
  return value === "1" || value === "true";
}

function debugTerminalUpdate(message: string, details: Record<string, unknown> = {}): void {
  if (!isTerminalUpdateDebugEnabled()) return;
  const serializedDetails = Object.entries(details)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatDebugValue(value)}`)
    .join(" ");
  const line = `[multitasker terminal ${new Date().toISOString()}] ${message}${serializedDetails ? ` ${serializedDetails}` : ""}`;
  appendTerminalDebugLog(line, details);
  console.info(line);
}

function appendTerminalDebugLog(line: string, details: Record<string, unknown>): void {
  const sessionId = getDebugLogSessionId(details);
  if (!sessionId) return;

  const filePath = getTerminalDebugLogFilePath(sessionId, details);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${line}\n`, "utf8");
  } catch (error) {
    reportDebugLogWriteFailure(`Could not write Electron terminal debug log "${filePath}": ${getErrorMessage(error)}`);
  }
}

function getTerminalDebugLogFilePath(sessionId: string, details: Record<string, unknown>): string {
  const existingFilePath = terminalDebugLogFileBySessionId.get(sessionId);
  if (existingFilePath) return existingFilePath;

  const timestamp = formatDebugLogFileTimestamp(new Date());
  const sessionName = getDebugLogSessionName(sessionId, details);
  const fileName = [
    timestamp,
    sanitizeDebugLogFilePart(sessionName, "unknown-session", 80),
    sanitizeDebugLogFilePart(sessionId, "unknown-id", 140),
  ].join("-");
  const filePath = path.join(process.cwd(), DEBUG_LOG_DIRECTORY, `${fileName}${DEBUG_LOG_FILE_EXTENSION}`);
  terminalDebugLogFileBySessionId.set(sessionId, filePath);
  return filePath;
}

function getDebugLogSessionId(details: Record<string, unknown>): string | undefined {
  const value = details["id"];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getDebugLogSessionName(sessionId: string, details: Record<string, unknown>): string {
  const detailSessionName = details["sessionName"];
  if (typeof detailSessionName === "string" && detailSessionName.trim()) return detailSessionName.trim();

  const session = sessionManager?.getSession(sessionId);
  if (session?.name.trim()) return session.name.trim();

  const terminalName = details["terminalName"];
  if (typeof terminalName === "string" && terminalName.trim()) return terminalName.trim();
  return "unknown-session";
}

function formatDebugLogFileTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function sanitizeDebugLogFilePart(value: string, fallback: string, maxLength: number): string {
  const sanitized = value
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const safeValue = sanitized || fallback;
  if (safeValue.length <= maxLength) return safeValue;

  const hash = createHash("sha256").update(safeValue).digest("hex").slice(0, 8);
  return `${safeValue.slice(0, maxLength - hash.length - 1)}-${hash}`;
}

function reportDebugLogWriteFailure(message: string): void {
  if (reportedDebugLogWriteFailures.has(message)) return;
  reportedDebugLogWriteFailures.add(message);
  console.warn(message);
}

function formatDebugValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
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
      statusReason: "terminal event did not produce a status update",
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
    captureState: event.captureState,
    captureReason: event.captureReason,
    output: event.output === undefined ? undefined : terminalOutputDebugValue(event.output),
  };
}

function getTerminalEventSessionName(event: TerminalEvent): string | undefined {
  const session = sessionManager?.getSession(event.id);
  return session?.name ?? event.terminalName;
}

function terminalOutputDebugValue(output: string): string {
  return stripTerminalControlSequences(output).replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}

function stripTerminalControlSequences(value: string): string {
  return value
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "\n");
}

function parseTerminalUpdateRequest(payload: unknown): TerminalUpdate | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;

  const id = readStringField(record, "id").trim();
  const rawStatus = readStringField(record, "status").trim();
  const occurredAt = readOptionalNumberField(record, "occurredAt") ?? Date.now();
  if (!id || !isSessionStatus(rawStatus)) return null;

  const update: TerminalUpdate = {
    id,
    status: rawStatus,
    occurredAt,
  };

  const exitCode = readOptionalNumberField(record, "exitCode");
  if (exitCode !== undefined) update.exitCode = exitCode;

  const exitReason = readStringField(record, "exitReason").trim();
  if (exitReason) update.exitReason = exitReason;

  const debugReason = readStringField(record, "debugReason").trim();
  if (debugReason) update.debugReason = debugReason.slice(0, 500);

  return update;
}

function parseTerminalEventRequest(payload: unknown): TerminalEvent | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;

  const explicitTaskId = readStringField(record, "taskId").trim() || readStringField(record, "id").trim();
  const rawType = readStringField(record, "type").trim();
  const occurredAt = readOptionalNumberField(record, "occurredAt") ?? Date.now();
  if (!isTerminalEventType(rawType)) return null;

  const terminalRef = readStringField(record, "terminalRef").trim();
  const launchId = readStringField(record, "launchId").trim();
  const terminalPid = readOptionalNumberField(record, "terminalPid");
  const terminalName = readStringField(record, "terminalName").trim();
  const terminalCwd = readStringField(record, "terminalCwd").trim();
  const rawShellType = readStringField(record, "shellType").trim();
  const shellType = isShellType(rawShellType) ? rawShellType : undefined;
  const id = resolveTerminalEventTaskId({
    explicitTaskId,
    terminalRef,
    terminalPid,
    terminalName,
    terminalCwd,
  });
  if (!id) return null;

  const event: TerminalEvent = {
    id,
    type: rawType,
    occurredAt,
  };
  if (terminalRef) event.terminalRef = terminalRef;
  if (launchId) event.launchId = launchId;
  if (terminalPid !== undefined) event.terminalPid = terminalPid;
  if (terminalName) event.terminalName = terminalName;
  if (terminalCwd) event.terminalCwd = terminalCwd;
  if (shellType) event.shellType = shellType;

  const commandLine = readStringField(record, "commandLine");
  if (commandLine) event.commandLine = commandLine;

  const executionId = readStringField(record, "executionId").trim();
  if (executionId) event.executionId = executionId;

  const output = readStringField(record, "output");
  if (output) event.output = output;

  const exitCode = readOptionalNumberField(record, "exitCode");
  if (exitCode !== undefined) event.exitCode = exitCode;

  const exitReason = readStringField(record, "exitReason").trim();
  if (exitReason) event.exitReason = exitReason;

  const hasLaunchCommand = readOptionalBooleanField(record, "hasLaunchCommand");
  if (hasLaunchCommand !== undefined) event.hasLaunchCommand = hasLaunchCommand;

  const primary = readOptionalBooleanField(record, "primary");
  if (primary !== undefined) event.primary = primary;

  const rawCaptureState = readStringField(record, "captureState").trim();
  if (rawCaptureState && isTerminalCaptureState(rawCaptureState)) event.captureState = rawCaptureState;

  const captureReason = readStringField(record, "captureReason").trim();
  if (captureReason) event.captureReason = captureReason.slice(0, 500);

  rememberTaskTerminalBinding(id, {
    terminalRef,
    terminalPid,
    captureState: event.captureState,
    captureReason: event.captureReason,
  });
  return event;
}

interface TerminalEventIdentity {
  explicitTaskId: string;
  terminalRef: string;
  terminalPid: number | undefined;
  terminalName: string;
  terminalCwd: string;
}

function resolveTerminalEventTaskId(identity: TerminalEventIdentity): string {
  if (identity.terminalRef) {
    const terminalTaskId = taskIdByTerminalRef.get(identity.terminalRef);
    if (terminalTaskId) return terminalTaskId;
  }

  if (identity.explicitTaskId) return identity.explicitTaskId;

  const matchingSession = findSessionForTerminalIdentity(identity);
  return matchingSession?.id ?? "";
}

function findSessionForTerminalIdentity(identity: TerminalEventIdentity): Session | null {
  const sessions = sessionManager?.getSessions() ?? [];
  const exactRef = identity.terminalRef ? sessions.find((session) => session.terminalRef === identity.terminalRef) : undefined;
  if (exactRef) return exactRef;

  const exactPid =
    identity.terminalPid !== undefined
      ? sessions.find((session) => (session.terminalPid ?? getLegacyAttachedTerminalPid(session.id)) === identity.terminalPid)
      : undefined;
  if (exactPid) return exactPid;

  const normalizedTerminalPath = normalizePathForCompare(identity.terminalCwd);
  if (!normalizedTerminalPath) return null;
  return (
    sessions.find((session) => !session.terminalRef?.trim() && normalizePathForCompare(session.cwd) === normalizedTerminalPath) ?? null
  );
}

function createManualTask(textValue: unknown, createdAtValue?: unknown): ManualTaskState | null {
  const text = typeof textValue === "string" ? textValue.trim() : "";
  if (!text) {
    console.error("Failed to add manual task: task text is required");
    return null;
  }

  const createdAt = typeof createdAtValue === "number" && Number.isFinite(createdAtValue) ? createdAtValue : Date.now();

  return addManualTask({
    id: `manual-${randomUUID()}`,
    text: truncateManualTaskText(text),
    createdAt,
  });
}

function readManualTaskText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (typeof payload !== "object" || payload === null) return "";
  const record = payload as Record<string, unknown>;
  return readStringField(record, "text") || readStringField(record, "title") || readStringField(record, "task");
}

function addManualTask(task: ManualTaskState): ManualTaskState {
  const existingIndex = manualTasks.findIndex((existing) => existing.id === task.id);
  if (existingIndex >= 0) manualTasks.splice(existingIndex, 1);
  manualTasks.unshift({ ...task });
  while (manualTasks.length > MAX_MANUAL_TASKS) manualTasks.pop();
  saveManualTasks(manualTasks);
  broadcastManualTasks();
  return { ...task };
}

function removeManualTask(id: string): boolean {
  const existingIndex = manualTasks.findIndex((task) => task.id === id);
  if (existingIndex < 0) {
    console.error(`Failed to remove manual task: task "${id}" was not found`);
    return false;
  }

  manualTasks.splice(existingIndex, 1);
  saveManualTasks(manualTasks);
  broadcastManualTasks();
  return true;
}

function broadcastManualTasks(): void {
  mainWindow?.webContents.send(
    "manual-task:list-update",
    manualTasks.map((task) => ({ ...task })),
  );
}

function truncateManualTaskText(text: string): string {
  if (text.length <= MAX_MANUAL_TASK_TEXT_LENGTH) return text;
  return `${text.slice(0, MAX_MANUAL_TASK_TEXT_LENGTH - 1)}â€¦`;
}

function createRecurringTask(textValue: unknown, timeValue: unknown, scheduleValue: unknown): RecurringTaskState | null {
  const text = typeof textValue === "string" ? textValue.trim() : "";
  const time = typeof timeValue === "string" ? timeValue.trim() : "";
  const schedule = parseRecurringSchedule(scheduleValue);
  if (!text) {
    console.error("Failed to add recurring task: task text is required");
    return null;
  }
  if (parseRecurringTimeMinutes(time) === null) {
    console.error("Failed to add recurring task: invalid time");
    return null;
  }
  if (!schedule) {
    console.error("Failed to add recurring task: invalid recurrence schedule");
    return null;
  }

  const now = new Date();
  const task: RecurringTaskState = {
    id: `recurring-${randomUUID()}`,
    text: truncateManualTaskText(text),
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
  return { ...task, daysOfWeek: [...task.daysOfWeek] };
}

function removeRecurringTask(id: string): boolean {
  const existingIndex = recurringTasks.findIndex((task) => task.id === id);
  if (existingIndex < 0) {
    console.error(`Failed to remove recurring task: task "${id}" was not found`);
    return false;
  }

  recurringTasks.splice(existingIndex, 1);
  saveRecurringTasks(recurringTasks);
  broadcastRecurringTasks();
  return true;
}

function broadcastRecurringTasks(): void {
  mainWindow?.webContents.send("recurring-task:list-update", recurringTasks.map(cloneRecurringTask));
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
    return daysOfWeek.length > 0 ? { frequency: "weekly", daysOfWeek } : null;
  }

  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const frequency = normalizeRecurringFrequency(readStringField(record, "frequency"));
  if (frequency === "daily") {
    return { frequency, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] };
  }

  if (frequency === "interval") {
    const intervalDays = normalizeRecurringIntervalDays(record["intervalDays"]);
    if (intervalDays === null) return null;
    return { frequency, daysOfWeek: [], intervalDays, anchorDate: getLocalDateKey(new Date()) };
  }

  if (frequency === "monthly") {
    const dayOfMonth = normalizeRecurringDayOfMonth(record["dayOfMonth"]);
    if (dayOfMonth === null) return null;
    return { frequency, daysOfWeek: [], dayOfMonth };
  }

  const daysOfWeek = normalizeRecurringDays(record["daysOfWeek"]);
  return daysOfWeek.length > 0 ? { frequency, daysOfWeek } : null;
}

function normalizeRecurringFrequency(value: string): RecurringTaskFrequency {
  return value === "daily" || value === "interval" || value === "monthly" ? value : "weekly";
}

function normalizeRecurringDays(value: unknown): number[] {
  if (!Array.isArray(value)) return [];

  const days = value.filter((day): day is number => typeof day === "number" && Number.isInteger(day) && day >= 0 && day <= 6);
  return [...new Set(days)].sort((a, b) => a - b);
}

function normalizeRecurringIntervalDays(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 3650 ? value : null;
}

function normalizeRecurringDayOfMonth(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 31 ? value : null;
}

function cloneRecurringTask(task: RecurringTaskState): RecurringTaskState {
  const clone: RecurringTaskState = {
    ...task,
    frequency: task.frequency ?? "weekly",
    daysOfWeek: [...task.daysOfWeek],
  };
  return clone;
}

function getInitialRecurringTaskGeneratedDate(task: RecurringTaskState, now: Date): string {
  if (!isRecurringTaskDue(task, now)) return "";
  return getLocalDateKey(now);
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

  const frequency = task.frequency ?? "weekly";
  if (frequency === "daily") return true;
  if (frequency === "interval") return isRecurringIntervalDue(task, now);
  if (frequency === "monthly") return isRecurringMonthlyDue(task, now);
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

function parseRecurringTimeMinutes(time: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function getLocalMinutesSinceMidnight(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

function getLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
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

function restorePersistedGoogleCalendarEvents(): void {
  googleCalendarEvents.length = 0;
  googleCalendarEvents.push(...filterActiveGoogleCalendarEvents(loadGoogleCalendarEvents()));
}

function cloneGoogleCalendarEvent(event: GoogleCalendarEventState): GoogleCalendarEventState {
  return { ...event };
}

function broadcastGoogleCalendarEvents(): void {
  mainWindow?.webContents.send("google-calendar:list-update", googleCalendarEvents.map(cloneGoogleCalendarEvent));
}

function broadcastGoogleCalendarStatus(message = ""): GoogleCalendarStatus {
  const status = getGoogleCalendarStatus(message);
  mainWindow?.webContents.send("google-calendar:status-update", status);
  return status;
}

async function getFreshGoogleCalendarStatus(message = ""): Promise<GoogleCalendarStatus> {
  await loadGoogleCalendarOAuthConfig();
  return getGoogleCalendarStatus(message);
}

function getGoogleCalendarStatus(message = "", oauthConfig = googleCalendarOAuthConfigCache): GoogleCalendarStatus {
  const settings = loadSettings().googleCalendar;
  const connections = loadGoogleCalendarConnections();
  const lastSyncedAt = Math.max(0, ...connections.map((connection) => connection.lastSyncedAt ?? 0));
  const connected = connections.length > 0;
  const configured = Boolean(oauthConfig.clientId.trim());
  const status: GoogleCalendarStatus = {
    connected,
    configured,
    enabled: settings.enabled,
    calendarId: settings.calendarId,
    lookAheadDays: settings.lookAheadDays,
    ownedCalendarsOnly: settings.ownedCalendarsOnly,
    accountCount: connections.length,
    eventCount: googleCalendarEvents.length,
    message: message || getDefaultGoogleCalendarStatusMessage(settings, configured, connected, connections.length),
    connections: connections.map(getGoogleCalendarConnectionStatus),
  };
  if (lastSyncedAt || googleCalendarLastSyncedAt) status.lastSyncedAt = Math.max(lastSyncedAt, googleCalendarLastSyncedAt);
  return status;
}

function getGoogleCalendarConnectionStatus(connection: GoogleCalendarConnectionState): GoogleCalendarConnectionStatus {
  const status: GoogleCalendarConnectionStatus = {
    id: connection.id,
    calendarId: connection.calendarId,
    lookAheadDays: connection.lookAheadDays,
    enabled: connection.enabled,
    connectedAt: connection.connectedAt,
  };
  if (connection.accountEmail) status.accountEmail = connection.accountEmail;
  if (connection.accountName) status.accountName = connection.accountName;
  if (connection.lastSyncedAt) status.lastSyncedAt = connection.lastSyncedAt;
  if (connection.authError) status.authError = connection.authError;
  return status;
}

function getDefaultGoogleCalendarStatusMessage(
  settings: GoogleCalendarSettings,
  configured: boolean,
  connected: boolean,
  accountCount: number,
): string {
  if (!configured) return "Google Calendar OAuth env vars are not configured in the backend.";
  if (!connected) return "Google Calendar is not connected.";
  if (!settings.enabled) return "Google Calendar is connected but disabled.";
  return googleCalendarLastSyncedAt
    ? `Synced ${googleCalendarEvents.length} upcoming event(s) from ${accountCount} account(s).`
    : `Google Calendar is connected to ${accountCount} account(s).`;
}

function startGoogleCalendarScheduler(): void {
  if (googleCalendarRefreshTimer) clearInterval(googleCalendarRefreshTimer);
  if (loadSettings().googleCalendar.enabled && loadGoogleCalendarConnections().length > 0) {
    void refreshGoogleCalendarEvents();
  }
  googleCalendarRefreshTimer = setInterval(() => {
    if (loadSettings().googleCalendar.enabled && loadGoogleCalendarConnections().length > 0) {
      void refreshGoogleCalendarEvents();
    }
  }, GOOGLE_CALENDAR_REFRESH_INTERVAL_MS);
}

function stopGoogleCalendarScheduler(): void {
  if (googleCalendarRefreshTimer) {
    clearInterval(googleCalendarRefreshTimer);
    googleCalendarRefreshTimer = null;
  }
  stopGoogleCalendarAuthFlow();
}

function handleGoogleCalendarSettingsChanged(): void {
  const settings = loadSettings().googleCalendar;
  if (!settings.enabled) {
    googleCalendarEvents.length = 0;
    saveGoogleCalendarEvents(googleCalendarEvents);
    broadcastGoogleCalendarEvents();
    broadcastGoogleCalendarStatus();
    return;
  }

  startGoogleCalendarScheduler();
}

async function loadGoogleCalendarOAuthConfig(): Promise<GoogleCalendarOAuthConfig> {
  googleCalendarOAuthConfigCache = { clientId: "", hasClientSecret: false };
  return googleCalendarOAuthConfigCache;
}

async function startGoogleCalendarAuthFlow(): Promise<GoogleCalendarAuthResult> {
  const settings = loadSettings().googleCalendar;
  const oauthConfig = await loadGoogleCalendarOAuthConfig();
  if (!oauthConfig.clientId.trim()) {
    const message = "Google Calendar OAuth env vars are required in the backend.";
    return { ok: false, message, status: getGoogleCalendarStatus(message, oauthConfig) };
  }

  stopGoogleCalendarAuthFlow();

  const state = randomUUID();
  const codeVerifier = base64UrlEncode(randomBytes(64));
  const codeChallenge = base64UrlEncode(createHash("sha256").update(codeVerifier).digest());
  let redirectUri = "";

  const result = new Promise<GoogleCalendarAuthResult>((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const finish = (ok: boolean, message: string): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      stopGoogleCalendarAuthFlow();
      const status = broadcastGoogleCalendarStatus(message);
      resolve({ ok, message, status });
    };

    googleCalendarAuthServer = createServer((request, response) => {
      void handleGoogleCalendarOAuthCallback(request, response, {
        state,
        codeVerifier,
        redirectUri,
        settings,
        finish,
      });
    });

    googleCalendarAuthServer.once("error", (error) => {
      finish(false, `Google Calendar authorization server failed: ${getErrorMessage(error)}`);
    });

    googleCalendarAuthServer.listen(0, GOOGLE_CALENDAR_OAUTH_HOST, () => {
      const address = googleCalendarAuthServer?.address();
      if (!address || typeof address === "string") {
        finish(false, "Google Calendar authorization server did not return a local port.");
        return;
      }

      redirectUri = `http://${GOOGLE_CALENDAR_OAUTH_HOST}:${(address as AddressInfo).port}${GOOGLE_CALENDAR_OAUTH_CALLBACK_PATH}`;
      timeout = setTimeout(() => {
        finish(false, "Google Calendar authorization timed out.");
      }, GOOGLE_CALENDAR_AUTH_TIMEOUT_MS);

      const authUrl = buildGoogleCalendarAuthUrl(oauthConfig, redirectUri, state, codeChallenge);
      void shell.openExternal(authUrl).catch((error) => {
        finish(false, `Could not open Google authorization page: ${getErrorMessage(error)}`);
      });
    });
  });

  broadcastGoogleCalendarStatus("Waiting for Google authorization...");
  return result;
}

interface GoogleCalendarOAuthCallbackContext {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  settings: GoogleCalendarSettings;
  finish: (ok: boolean, message: string) => void;
}

async function handleGoogleCalendarOAuthCallback(
  request: IncomingMessage,
  response: ServerResponse,
  context: GoogleCalendarOAuthCallbackContext,
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", `http://${GOOGLE_CALENDAR_OAUTH_HOST}`);
  if (requestUrl.pathname !== GOOGLE_CALENDAR_OAUTH_CALLBACK_PATH) {
    writeGoogleCalendarOAuthResponse(response, false, "Unsupported Google Calendar authorization callback.");
    return;
  }

  const callbackState = requestUrl.searchParams.get("state") ?? "";
  if (callbackState !== context.state) {
    writeGoogleCalendarOAuthResponse(response, false, "Google Calendar authorization state did not match.");
    context.finish(false, "Google Calendar authorization state did not match.");
    return;
  }

  const callbackError = requestUrl.searchParams.get("error") ?? "";
  if (callbackError) {
    const message = `Google Calendar authorization failed: ${callbackError}`;
    writeGoogleCalendarOAuthResponse(response, false, message);
    context.finish(false, message);
    return;
  }

  const code = requestUrl.searchParams.get("code") ?? "";
  if (!code) {
    writeGoogleCalendarOAuthResponse(response, false, "Google Calendar authorization did not return a code.");
    context.finish(false, "Google Calendar authorization did not return a code.");
    return;
  }

  try {
    const token = await requestGoogleToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: context.redirectUri,
      code_verifier: context.codeVerifier,
    });
    const userInfo = await fetchGoogleUserInfo(token.accessToken);
    const connections = loadGoogleCalendarConnections();
    const connectionId = getGoogleCalendarConnectionId(userInfo);
    const existingConnection = connections.find((connection) => connection.id === connectionId);
    const refreshToken = token.refreshToken ?? existingConnection?.auth.refreshToken ?? "";
    if (!refreshToken) {
      throw new Error("Google did not return a refresh token. Revoke Multitasker access in your Google account and connect again.");
    }

    const auth: GoogleCalendarAuthState = {
      accessToken: token.accessToken,
      refreshToken,
      expiresAt: Date.now() + (token.expiresIn ?? 3600) * 1000,
    };
    if (token.tokenType) auth.tokenType = token.tokenType;
    if (token.scope) auth.scope = token.scope;
    const connection: GoogleCalendarConnectionState = {
      id: connectionId,
      calendarId: context.settings.calendarId,
      lookAheadDays: context.settings.lookAheadDays,
      enabled: true,
      connectedAt: existingConnection?.connectedAt ?? Date.now(),
      auth,
    };
    if (userInfo.email) connection.accountEmail = userInfo.email;
    if (userInfo.name) connection.accountName = userInfo.name;
    if (existingConnection?.lastSyncedAt) connection.lastSyncedAt = existingConnection.lastSyncedAt;
    saveGoogleCalendarConnections([connection, ...connections.filter((candidate) => candidate.id !== connection.id)]);
    clearGoogleCalendarAuth();

    const currentSettings = loadSettings();
    saveSettings({
      ...currentSettings,
      googleCalendar: {
        ...currentSettings.googleCalendar,
        enabled: true,
      },
    });

    await refreshGoogleCalendarEvents();
    const accountLabel = getGoogleCalendarConnectionLabel(connection);
    writeGoogleCalendarOAuthResponse(response, true, `Google Calendar connected for ${accountLabel}. You can close this tab.`);
    context.finish(true, `Google Calendar connected for ${accountLabel}.`);
  } catch (error) {
    const message = `Google Calendar authorization failed: ${getErrorMessage(error)}`;
    writeGoogleCalendarOAuthResponse(response, false, message);
    context.finish(false, message);
  }
}

function writeGoogleCalendarOAuthResponse(response: ServerResponse, ok: boolean, message: string): void {
  const body = `<!doctype html><html><body style="font-family:system-ui,sans-serif;background:#0d1117;color:#c9d1d9;padding:24px"><h1>${ok ? "Connected" : "Authorization failed"}</h1><p>${escapeHtml(message)}</p></body></html>`;
  response.writeHead(ok ? 200 : 400, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function buildGoogleCalendarAuthUrl(
  oauthConfig: GoogleCalendarOAuthConfig,
  redirectUri: string,
  state: string,
  codeChallenge: string,
): string {
  const url = new URL(GOOGLE_CALENDAR_AUTH_URL);
  url.searchParams.set("client_id", oauthConfig.clientId.trim());
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_CALENDAR_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "select_account consent");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

function stopGoogleCalendarAuthFlow(): void {
  const server = googleCalendarAuthServer;
  googleCalendarAuthServer = null;
  if (!server) return;
  try {
    server.close();
  } catch {
    // Server may not have started listening yet.
  }
}

function getGoogleCalendarReauthTaskId(connectionId: string): string {
  return `google-calendar-reauth-${connectionId}`;
}

function clearGoogleCalendarReauthTask(connectionId: string): void {
  const taskId = getGoogleCalendarReauthTaskId(connectionId);
  if (manualTasks.some((task) => task.id === taskId)) removeManualTask(taskId);
}

async function refreshGoogleCalendarEvents(): Promise<GoogleCalendarStatus> {
  const settings = loadSettings().googleCalendar;
  if (!settings.enabled) return broadcastGoogleCalendarStatus("Google Calendar is disabled.");
  const oauthConfig = await loadGoogleCalendarOAuthConfig();
  if (!oauthConfig.clientId.trim()) return broadcastGoogleCalendarStatus("Google Calendar OAuth env vars are required in the backend.");
  const connections = loadGoogleCalendarConnections();
  if (connections.length === 0) return broadcastGoogleCalendarStatus("Google Calendar is not connected.");

  const events: GoogleCalendarEventState[] = [];
  const failures: string[] = [];
  const reauthRequired: string[] = [];
  try {
    for (const connection of connections) {
      if (!connection.enabled) continue;
      try {
        const accessToken = await getValidGoogleCalendarAccessToken(connection);
        const connectionEvents = await fetchGoogleCalendarEvents(settings, connection, accessToken);
        connection.lastSyncedAt = Date.now();
        if (connection.authError) {
          delete connection.authError;
          clearGoogleCalendarReauthTask(connection.id);
        }
        events.push(...connectionEvents);
      } catch (error) {
        const accountLabel = getGoogleCalendarConnectionLabel(connection);
        const message = getErrorMessage(error);
        failures.push(accountLabel);
        if (
          /invalid_grant|invalid_token|unauthorized_client|insufficient[_ ]?(authentication[_ ]?)?scopes?|ACCESS_TOKEN_SCOPE_INSUFFICIENT|\b401\b/i.test(
            message,
          )
        ) {
          connection.authError = "reauth_required";
          reauthRequired.push(accountLabel);
          addManualTask({
            id: getGoogleCalendarReauthTaskId(connection.id),
            text: truncateManualTaskText(`Reconnect Google Calendar for ${accountLabel}`),
            createdAt: Date.now(),
          });
        }
        console.error(`Google Calendar sync failed for ${accountLabel}: ${message}`);
      }
    }
    googleCalendarLastSyncedAt = Date.now();
    saveGoogleCalendarConnections(connections);
    googleCalendarEvents.length = 0;
    googleCalendarEvents.push(...filterActiveGoogleCalendarEvents(events).sort((a, b) => a.startMs - b.startMs));
    saveGoogleCalendarEvents(googleCalendarEvents);
    broadcastGoogleCalendarEvents();
    if (reauthRequired.length > 0) {
      return broadcastGoogleCalendarStatus(
        `Reconnect required for ${reauthRequired.join(", ")}. Sign in again to resume Google Calendar sync.`,
      );
    }
    if (failures.length > 0) {
      return broadcastGoogleCalendarStatus(`Synced ${googleCalendarEvents.length} event(s); ${failures.length} account(s) failed.`);
    }
    return broadcastGoogleCalendarStatus(
      `Synced ${googleCalendarEvents.length} upcoming Google Calendar event(s) from ${connections.length} account(s).`,
    );
  } catch (error) {
    const message = `Google Calendar sync failed: ${getErrorMessage(error)}`;
    console.error(message);
    return broadcastGoogleCalendarStatus(message);
  }
}

async function getValidGoogleCalendarAccessToken(connection: GoogleCalendarConnectionState): Promise<string> {
  if (connection.auth.expiresAt > Date.now() + GOOGLE_CALENDAR_TOKEN_REFRESH_BUFFER_MS) {
    return connection.auth.accessToken;
  }
  connection.auth = await refreshGoogleCalendarAccessToken(connection.auth);
  return connection.auth.accessToken;
}

async function refreshGoogleCalendarAccessToken(auth: GoogleCalendarAuthState): Promise<GoogleCalendarAuthState> {
  const token = await requestGoogleToken({
    grant_type: "refresh_token",
    refresh_token: auth.refreshToken,
  });

  const refreshedAuth: GoogleCalendarAuthState = {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken ?? auth.refreshToken,
    expiresAt: Date.now() + (token.expiresIn ?? 3600) * 1000,
  };
  const tokenType = token.tokenType ?? auth.tokenType;
  if (tokenType) refreshedAuth.tokenType = tokenType;
  const scope = token.scope ?? auth.scope;
  if (scope) refreshedAuth.scope = scope;
  return refreshedAuth;
}

async function requestGoogleToken(_params?: Record<string, string>): Promise<GoogleTokenResponse> {
  throw new Error("Google Calendar OAuth is not configured without the backend service.");
}

async function fetchGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const response = await fetch(GOOGLE_USERINFO_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const rawBody = await response.text();
  const payload = parseJsonResponseBody(rawBody);
  if (!response.ok) {
    throw new Error(`Google user info request failed (${response.status}): ${getGoogleApiErrorMessage(payload, rawBody)}`);
  }
  return parseGoogleUserInfo(payload);
}

function parseGoogleUserInfo(payload: unknown): GoogleUserInfo {
  if (!isRecord(payload)) throw new Error("Google user info response was not an object.");
  const id = readStringField(payload, "id").trim();
  const email = readStringField(payload, "email").trim();
  const name = readStringField(payload, "name").trim();
  const accountId = id || email;
  if (!accountId) throw new Error("Google user info response did not include an account id or email.");
  return {
    id: accountId,
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
  };
}

function getGoogleCalendarConnectionId(userInfo: GoogleUserInfo): string {
  return `google:${createHash("sha256").update(userInfo.id).digest("hex").slice(0, 16)}`;
}

function getGoogleCalendarConnectionLabel(connection: Pick<GoogleCalendarConnectionState, "accountEmail" | "accountName" | "id">): string {
  return connection.accountEmail || connection.accountName || connection.id;
}

async function fetchGoogleCalendarEvents(
  settings: GoogleCalendarSettings,
  connection: GoogleCalendarConnectionState,
  accessToken: string,
): Promise<GoogleCalendarEventState[]> {
  const calendarId = connection.calendarId.trim() || "primary";
  if (settings.ownedCalendarsOnly && !(await isOwnedGoogleCalendar(calendarId, accessToken))) {
    console.info(`Skipping shared Google Calendar "${calendarId}" for ${getGoogleCalendarConnectionLabel(connection)}.`);
    return [];
  }
  const now = new Date();
  const timeMin = startOfLocalDay(now).toISOString();
  const timeMax = new Date(now.getTime() + connection.lookAheadDays * 86_400_000).toISOString();
  const url = new URL(`${GOOGLE_CALENDAR_API_BASE_URL}/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("timeMin", timeMin);
  url.searchParams.set("timeMax", timeMax);
  url.searchParams.set("maxResults", String(MAX_GOOGLE_CALENDAR_EVENTS));

  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const rawBody = await response.text();
  const payload = parseJsonResponseBody(rawBody);
  if (!response.ok) {
    throw new Error(`Google Calendar request failed (${response.status}): ${getGoogleApiErrorMessage(payload, rawBody)}`);
  }
  const eventsResponse = parseGoogleCalendarEventsResponse(payload);
  return filterActiveGoogleCalendarEvents(
    (eventsResponse.items ?? [])
      .map((event) => parseGoogleCalendarEvent(connection, calendarId, event))
      .filter((event): event is GoogleCalendarEventState => event !== null),
    now,
  ).sort((a, b) => a.startMs - b.startMs);
}

async function isOwnedGoogleCalendar(calendarId: string, accessToken: string): Promise<boolean> {
  const normalizedCalendarId = calendarId.trim() || "primary";
  const entry =
    normalizedCalendarId.toLowerCase() === "primary"
      ? await fetchPrimaryGoogleCalendarListEntry(accessToken)
      : await fetchGoogleCalendarListEntry(normalizedCalendarId, accessToken);
  return entry?.accessRole === "owner";
}

async function fetchPrimaryGoogleCalendarListEntry(accessToken: string): Promise<GoogleCalendarListEntry | null> {
  const entries = await fetchGoogleCalendarListEntries(accessToken);
  return entries.find((entry) => entry.primary === true) ?? null;
}

async function fetchGoogleCalendarListEntry(calendarId: string, accessToken: string): Promise<GoogleCalendarListEntry | null> {
  const url = new URL(`${GOOGLE_CALENDAR_API_BASE_URL}/users/me/calendarList/${encodeURIComponent(calendarId)}`);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const rawBody = await response.text();
  const payload = parseJsonResponseBody(rawBody);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Google Calendar list request failed (${response.status}): ${getGoogleApiErrorMessage(payload, rawBody)}`);
  }
  return parseGoogleCalendarListEntry(payload);
}

async function fetchGoogleCalendarListEntries(accessToken: string): Promise<GoogleCalendarListEntry[]> {
  const entries: GoogleCalendarListEntry[] = [];
  let pageToken = "";
  do {
    const url = new URL(`${GOOGLE_CALENDAR_API_BASE_URL}/users/me/calendarList`);
    url.searchParams.set("maxResults", "250");
    url.searchParams.set("showHidden", "true");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const rawBody = await response.text();
    const payload = parseJsonResponseBody(rawBody);
    if (!response.ok) {
      throw new Error(`Google Calendar list request failed (${response.status}): ${getGoogleApiErrorMessage(payload, rawBody)}`);
    }
    const page = parseGoogleCalendarListResponse(payload);
    entries.push(...page.items);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return entries;
}

function parseGoogleCalendarListResponse(payload: unknown): { items: GoogleCalendarListEntry[]; nextPageToken: string } {
  if (!isRecord(payload)) throw new Error("Google Calendar list response was not an object.");
  const items = payload["items"];
  const nextPageToken = readStringField(payload, "nextPageToken").trim();
  return {
    items: Array.isArray(items)
      ? items.map(parseGoogleCalendarListEntry).filter((entry): entry is GoogleCalendarListEntry => entry !== null)
      : [],
    nextPageToken,
  };
}

function parseGoogleCalendarListEntry(payload: unknown): GoogleCalendarListEntry | null {
  if (!isRecord(payload)) return null;
  const id = readStringField(payload, "id").trim();
  if (!id) return null;
  const entry: GoogleCalendarListEntry = { id };
  const summary = readStringField(payload, "summary").trim();
  const accessRole = readStringField(payload, "accessRole").trim();
  const primary = readOptionalBooleanField(payload, "primary");
  if (summary) entry.summary = summary;
  if (accessRole) entry.accessRole = accessRole;
  if (primary !== undefined) entry.primary = primary;
  return entry;
}

function parseGoogleCalendarEventsResponse(payload: unknown): GoogleCalendarEventsResponse {
  if (!isRecord(payload)) throw new Error("Google Calendar response was not an object.");
  const items = payload["items"];
  if (!Array.isArray(items)) return { items: [] };
  return {
    items: items.filter(isRecord).map(parseGoogleCalendarRawEvent),
  };
}

function parseGoogleCalendarRawEvent(item: Record<string, unknown>): GoogleCalendarRawEvent {
  const event: GoogleCalendarRawEvent = {};
  const id = readStringField(item, "id").trim();
  if (id) event.id = id;
  const status = readStringField(item, "status").trim();
  if (status) event.status = status;
  const summary = readStringField(item, "summary").trim();
  if (summary) event.summary = summary;
  const htmlLink = readStringField(item, "htmlLink").trim();
  if (htmlLink) event.htmlLink = htmlLink;
  const location = readStringField(item, "location").trim();
  if (location) event.location = location;
  const updated = readStringField(item, "updated").trim();
  if (updated) event.updated = updated;
  const start = parseGoogleCalendarRawEventDate(item["start"]);
  if (start) event.start = start;
  const end = parseGoogleCalendarRawEventDate(item["end"]);
  if (end) event.end = end;
  return event;
}

function parseGoogleCalendarRawEventDate(value: unknown): GoogleCalendarRawEventDate | undefined {
  if (!isRecord(value)) return undefined;
  const date = readStringField(value, "date").trim();
  const dateTime = readStringField(value, "dateTime").trim();
  if (!date && !dateTime) return undefined;
  return {
    ...(date ? { date } : {}),
    ...(dateTime ? { dateTime } : {}),
  };
}

function parseGoogleCalendarEvent(
  connection: GoogleCalendarConnectionState,
  calendarId: string,
  rawEvent: GoogleCalendarRawEvent,
): GoogleCalendarEventState | null {
  if (!rawEvent.id || rawEvent.status === "cancelled" || !rawEvent.start || !rawEvent.end) return null;
  const start = parseGoogleCalendarEventDate(rawEvent.start);
  const end = parseGoogleCalendarEventDate(rawEvent.end);
  if (!start || !end) return null;

  const event: GoogleCalendarEventState = {
    id: `${connection.id}:${calendarId}:${rawEvent.id}`,
    connectionId: connection.id,
    calendarId,
    summary: rawEvent.summary?.trim() || "(no title)",
    start: start.value,
    end: end.value,
    startMs: start.ms,
    endMs: end.ms,
    allDay: start.allDay,
  };
  if (connection.accountEmail) event.accountEmail = connection.accountEmail;
  if (connection.accountName) event.accountName = connection.accountName;
  if (rawEvent.htmlLink) event.htmlLink = rawEvent.htmlLink;
  if (rawEvent.location) event.location = rawEvent.location;
  if (rawEvent.updated) event.updated = rawEvent.updated;
  return event;
}

function parseGoogleCalendarEventDate(value: GoogleCalendarRawEventDate): { value: string; ms: number; allDay: boolean } | null {
  if (value.dateTime) {
    const ms = Date.parse(value.dateTime);
    return Number.isFinite(ms) ? { value: value.dateTime, ms, allDay: false } : null;
  }

  if (!value.date) return null;
  const date = parseLocalDateKey(value.date);
  return date ? { value: value.date, ms: date.getTime(), allDay: true } : null;
}

function filterActiveGoogleCalendarEvents(events: GoogleCalendarEventState[], now = new Date()): GoogleCalendarEventState[] {
  const nowMs = now.getTime();
  return events.filter((event) => event.endMs >= nowMs).slice(0, MAX_GOOGLE_CALENDAR_EVENTS);
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function parseJsonResponseBody(rawBody: string): unknown {
  if (!rawBody.trim()) return {};
  try {
    return JSON.parse(rawBody);
  } catch {
    return {};
  }
}

function getGoogleApiErrorMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback.slice(0, 500);
  const errorDescription = readStringField(payload, "error_description").trim();
  if (errorDescription) return errorDescription;
  const rawError = payload["error"];
  if (typeof rawError === "string" && rawError.trim()) return rawError.trim();
  if (isRecord(rawError)) {
    const message = readStringField(rawError, "message").trim();
    if (message) return message;
  }
  return fallback.slice(0, 500);
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function disconnectGoogleCalendar(connectionId?: unknown): GoogleCalendarStatus {
  if (typeof connectionId === "string" && connectionId.trim()) {
    const normalizedConnectionId = connectionId.trim();
    const connections = loadGoogleCalendarConnections().filter((connection) => connection.id !== normalizedConnectionId);
    saveGoogleCalendarConnections(connections);
    googleCalendarEvents.splice(
      0,
      googleCalendarEvents.length,
      ...googleCalendarEvents.filter((event) => event.connectionId !== normalizedConnectionId),
    );
    saveGoogleCalendarEvents(googleCalendarEvents);
    broadcastGoogleCalendarEvents();
    clearGoogleCalendarReauthTask(normalizedConnectionId);
    return broadcastGoogleCalendarStatus("Google Calendar account disconnected.");
  }

  const allConnectionIds = loadGoogleCalendarConnections().map((connection) => connection.id);
  clearGoogleCalendarAuth();
  clearGoogleCalendarConnections();
  clearGoogleCalendarEvents();
  googleCalendarEvents.length = 0;
  googleCalendarLastSyncedAt = 0;
  for (const id of allConnectionIds) clearGoogleCalendarReauthTask(id);
  const settings = loadSettings();
  saveSettings({
    ...settings,
    googleCalendar: {
      ...settings.googleCalendar,
      enabled: false,
    },
  });
  broadcastGoogleCalendarEvents();
  return broadcastGoogleCalendarStatus("Google Calendar disconnected.");
}

async function openGoogleCalendarEvent(id: unknown): Promise<boolean> {
  if (typeof id !== "string" || !id.trim()) return false;
  const event = googleCalendarEvents.find((candidate) => candidate.id === id.trim());
  if (!event?.htmlLink) return false;
  await shell.openExternal(event.htmlLink);
  return true;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function restorePersistedManualTasks(): void {
  manualTasks.length = 0;
  manualTasks.push(...loadManualTasks().slice(0, MAX_MANUAL_TASKS));
}

function restorePersistedRecurringTasks(): void {
  recurringTasks.length = 0;
  recurringTasks.push(...loadRecurringTasks().slice(0, MAX_RECURRING_TASKS));
}

function applyTerminalUpdate(update: TerminalUpdate): boolean {
  const previousSession = sessionManager?.getSession(update.id);
  const session = sessionManager?.updateTerminalState(update);
  if (!session) return false;

  debugTerminalUpdate("terminal update applied", {
    ...terminalUpdateDebugDetails(update),
    previousStatus: previousSession?.status,
    nextStatus: session.status,
  });
  saveSessionsAfterTerminalStatusChange(previousSession?.status, session.status);
  return true;
}

function applyTerminalEvent(event: TerminalEvent): boolean {
  const previousSession = sessionManager?.getSession(event.id);
  const result = sessionManager?.updateTerminalEventWithDetails(event);
  if (!result) return false;

  debugTerminalUpdate("terminal event applied", {
    ...terminalEventDebugDetails(event, getTerminalEventSessionName(event)),
    ...terminalEventStatusDebugDetails(result.statusUpdate),
    previousStatus: previousSession?.status,
    nextStatus: result.session.status,
  });
  saveSessionsAfterTerminalStatusChange(previousSession?.status, result.session.status);
  return true;
}

function saveSessionsAfterTerminalStatusChange(previousStatus: SessionStatus | undefined, nextStatus: SessionStatus): void {
  if (
    nextStatus === "error" ||
    nextStatus === "stopped" ||
    nextStatus === "detached" ||
    previousStatus === "error" ||
    previousStatus === "stopped" ||
    previousStatus === "detached"
  ) {
    saveSessions(getSessionsStateToSave());
  }
}

function handleTerminalUpdate(update: TerminalUpdate): void {
  if (applyTerminalUpdate(update)) return;
  debugTerminalUpdate("terminal update queued for missing session", terminalUpdateDebugDetails(update));
  pendingTerminalUpdates.set(update.id, update);
}

function handleTerminalEvent(event: TerminalEvent): void {
  debugTerminalUpdate("terminal event received", terminalEventDebugDetails(event, getTerminalEventSessionName(event)));
  if (applyTerminalEvent(event)) return;
  debugTerminalUpdate("terminal event queued for missing session", terminalEventDebugDetails(event, getTerminalEventSessionName(event)));
  queuePendingTerminalEvent(event);
}

function flushPendingTerminalUpdates(id?: string): void {
  if (id) {
    const update = pendingTerminalUpdates.get(id);
    if (!update || !applyTerminalUpdate(update)) return;
    debugTerminalUpdate("pending terminal update flushed", terminalUpdateDebugDetails(update));
    pendingTerminalUpdates.delete(id);
    return;
  }

  [...pendingTerminalUpdates.keys()].forEach((sessionId) => {
    flushPendingTerminalUpdates(sessionId);
  });
}

function queuePendingTerminalEvent(event: TerminalEvent): void {
  const events = pendingTerminalEvents.get(event.id) ?? [];
  events.push(event);
  if (events.length > MAX_PENDING_TERMINAL_EVENTS_PER_SESSION) {
    events.shift();
    debugTerminalUpdate("oldest pending terminal event dropped", {
      id: event.id,
      maxPendingEvents: MAX_PENDING_TERMINAL_EVENTS_PER_SESSION,
    });
  }
  pendingTerminalEvents.set(event.id, events);
}

function flushPendingTerminalEvents(id?: string): void {
  if (id) {
    const events = pendingTerminalEvents.get(id);
    if (!events) return;

    const remainingEvents: TerminalEvent[] = [];
    for (const event of events) {
      if (applyTerminalEvent(event)) {
        debugTerminalUpdate("pending terminal event flushed", terminalEventDebugDetails(event, getTerminalEventSessionName(event)));
      } else {
        remainingEvents.push(event);
      }
    }

    if (remainingEvents.length === 0) {
      pendingTerminalEvents.delete(id);
    } else {
      pendingTerminalEvents.set(id, remainingEvents);
    }
    return;
  }

  [...pendingTerminalEvents.keys()].forEach((sessionId) => {
    flushPendingTerminalEvents(sessionId);
  });
}

async function startTerminalUpdateServer(): Promise<void> {
  if (isEnvFlagEnabled(DISABLE_LEGACY_TERMINAL_SERVER_ENV)) {
    debugTerminalUpdate("legacy terminal update server disabled by environment", {
      env: DISABLE_LEGACY_TERMINAL_SERVER_ENV,
      backendUrl: backendUrl(BACKEND_HEALTH_PATH),
    });
    startStandaloneBackendSync();
    return;
  }

  if (process.env["NODE_ENV"] === "development" && await waitForStandaloneBackend(BACKEND_STARTUP_WAIT_MS)) {
    debugTerminalUpdate("legacy terminal update server skipped; standalone backend available", {
      backendUrl: backendUrl(BACKEND_HEALTH_PATH),
    });
    startStandaloneBackendSync();
    return;
  }

  startLegacyTerminalUpdateServer();
}

function startLegacyTerminalUpdateServer(): void {
  if (terminalUpdateServer) return;

  const server = createServer((request, response) => {
    void handleTerminalUpdateHttpRequest(request, response);
  });
  server.on("error", (error) => {
    terminalUpdateServer = null;
    if (isAddressInUseError(error)) {
      void handleTerminalUpdateServerAddressInUse(error);
      return;
    }
    console.error(`Failed to start terminal update server: ${getErrorMessage(error)}`);
  });
  server.listen(TERMINAL_UPDATE_PORT, TERMINAL_UPDATE_HOST, () => {
    debugTerminalUpdate("terminal update server started", {
      host: TERMINAL_UPDATE_HOST,
      port: TERMINAL_UPDATE_PORT,
      updatePath: TERMINAL_UPDATE_PATH,
      eventPath: TERMINAL_EVENT_PATH,
    });
  });
  terminalUpdateServer = server;
}

async function handleTerminalUpdateServerAddressInUse(error: unknown): Promise<void> {
  if (await waitForStandaloneBackend(BACKEND_STARTUP_WAIT_MS)) {
    debugTerminalUpdate("legacy terminal update server skipped; port is owned by standalone backend", {
      backendUrl: backendUrl(BACKEND_HEALTH_PATH),
    });
    startStandaloneBackendSync();
    return;
  }
  console.error(`Failed to start terminal update server: ${getErrorMessage(error)}`);
}

function stopTerminalUpdateServer(): void {
  if (!terminalUpdateServer) return;
  terminalUpdateServer.close();
  terminalUpdateServer = null;
}

async function handleTerminalUpdateHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "content-type");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const requestUrl = new URL(request.url ?? "/", `http://${TERMINAL_UPDATE_HOST}`);
  const requestPath = requestUrl.pathname;
  const isTerminalUpdatePath = requestPath === TERMINAL_UPDATE_PATH;
  const isTerminalEventPath = requestPath === TERMINAL_EVENT_PATH;
  const isTaskApiPath = requestPath === "/api/tasks" || requestPath === "/api/task/add" || requestPath === "/api/manual-task/add";
  if (request.method !== "POST" || (!isTerminalUpdatePath && !isTerminalEventPath && !isTaskApiPath)) {
    writeJsonResponse(response, 404, { ok: false, error: "not_found" });
    return;
  }

  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(await readHttpBody(request));
  } catch (error) {
    const statusCode = error instanceof HttpBodyTooLargeError ? 413 : 400;
    writeJsonResponse(response, statusCode, { ok: false, error: getErrorMessage(error) });
    return;
  }

  if (isTaskApiPath) {
    const task = createManualTask(readManualTaskText(parsedPayload));
    if (!task) {
      writeJsonResponse(response, 400, { ok: false, error: "invalid_manual_task" });
      return;
    }
    writeJsonResponse(response, 200, { ok: true, task });
    return;
  } else if (isTerminalEventPath) {
    const event = parseTerminalEventRequest(parsedPayload);
    if (!event) {
      writeJsonResponse(response, 400, { ok: false, error: "invalid_terminal_event" });
      return;
    }
    handleTerminalEvent(event);
  } else {
    const update = parseTerminalUpdateRequest(parsedPayload);
    if (!update) {
      writeJsonResponse(response, 400, { ok: false, error: "invalid_terminal_update" });
      return;
    }
    handleTerminalUpdate(update);
  }
  writeJsonResponse(response, 200, { ok: true });
}

function readHttpBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let bodyBytes = 0;
    let rejected = false;
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      if (rejected) return;
      bodyBytes += Buffer.byteLength(chunk, "utf8");
      if (bodyBytes > MAX_TERMINAL_EVENT_BODY_BYTES) {
        rejected = true;
        reject(new HttpBodyTooLargeError("request payload is too large"));
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      if (!rejected) resolve(body);
    });
    request.on("error", (error) => {
      if (!rejected) reject(error);
    });
  });
}

function writeJsonResponse(response: ServerResponse, statusCode: number, body: unknown): void {
  const encodedBody = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(encodedBody),
  });
  response.end(encodedBody);
}

function setupLegacyIpc(): void {
  ipcMain.handle("session:create", (_e, name: string, cmd: string, cwd: string, shellType: string, sshCommand = "") => {
    const settings = loadSettings();
    const normalizedShellType = isShellType(shellType) ? shellType : settings.defaultShell;
    const session = sessionManager?.createSession(name, cmd, cwd, normalizedShellType, "", sshCommand) ?? null;
    if (session) {
      debugTerminalUpdate("session created from app", {
        id: session.id,
        status: session.status,
        shellType: session.shellType,
        hasCommand: Boolean(session.cmd),
      });
      saveSessions(getSessionsStateToSave());
    }
    return session;
  });

  ipcMain.handle("session:remove", async (_e, id: unknown) => {
    const sessionId = typeof id === "string" ? id.trim() : "";
    if (!sessionId) {
      console.error("Failed to remove session: missing session id");
      return;
    }

    try {
      await killShellSessionForRemovedSession(sessionId);

      if (backendEventsSyncEnabled) {
        await postStandaloneBackend("/api/session/remove", { id: sessionId });
        removeStandaloneBackendSession(sessionId);
        return;
      }

      sessionManager?.removeSession(sessionId);
      saveSessions(getSessionsStateToSave());
    } catch (error) {
      console.error(`Failed to remove session: ${getErrorMessage(error)}`);
    }
  });

  ipcMain.handle("session:rename", (_e, id: unknown, name: unknown) => {
    const sessionId = typeof id === "string" ? id.trim() : "";
    const nextName = typeof name === "string" ? name.trim() : "";
    if (!sessionId || !nextName) {
      console.error("Failed to rename session: missing session id or name");
      return null;
    }

    const session = sessionManager?.renameSession(sessionId, nextName) ?? null;
    if (!session) {
      console.error(`Failed to rename session: session "${sessionId}" was not found`);
      return null;
    }

    debugTerminalUpdate("session renamed", {
      id: session.id,
      sessionName: session.name,
    });
    saveSessions(getSessionsStateToSave());
    return session;
  });

  ipcMain.handle("session:pause", (_e, id: unknown) => {
    const sessionId = typeof id === "string" ? id.trim() : "";
    if (!sessionId) {
      console.error("Failed to pause session: missing session id");
      return null;
    }
    const session = sessionManager?.pauseSession(sessionId) ?? null;
    if (!session) {
      console.error(`Failed to pause session: session "${sessionId}" was not found`);
      return null;
    }
    debugTerminalUpdate("session paused", { id: session.id, status: session.status });
    return session;
  });

  ipcMain.handle("session:list", () => {
    if (!standaloneBackendSessions) sessionManager?.refreshGitChanges();
    return getCurrentSessions();
  });

  ipcMain.handle("session:open-review", (_e, cwd: string) => {
    const settings = loadSettings();
    const cmd = settings.reviewTool.replace("{path}", `"${cwd}"`);
    exec(cmd, (err) => {
      if (err) console.error("Failed to open review tool:", err.message);
    });
  });

  ipcMain.handle("session:pick-dir", async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle("settings:get", () => loadSettings());

  ipcMain.handle("settings:set", (_e, settings: AppSettings) => {
    saveSettings(settings);
    handleGoogleCalendarSettingsChanged();
  });

  ipcMain.handle("manual-task:list", () => manualTasks.map((task) => ({ ...task })));

  ipcMain.handle("manual-task:add", (_event, text: unknown, createdAt?: unknown) => createManualTask(text, createdAt));

  ipcMain.handle("manual-task:remove", async (_event, id: unknown) => {
    if (typeof id !== "string" || !id.trim()) {
      console.error("Failed to remove manual task: missing task id");
      return false;
    }
    const taskId = id.trim();
    try {
      if (backendEventsSyncEnabled) {
        const response = await postStandaloneBackend("/api/manual-task/remove", { id: taskId });
        removeStandaloneBackendManualTask(taskId);
        return response["removed"] === true;
      }
      return removeManualTask(taskId);
    } catch (error) {
      console.error(`Failed to remove manual task: ${getErrorMessage(error)}`);
      return false;
    }
  });

  ipcMain.handle("recurring-task:list", () => recurringTasks.map(cloneRecurringTask));

  ipcMain.handle("recurring-task:add", (_event, text: unknown, time: unknown, schedule: unknown) =>
    createRecurringTask(text, time, schedule),
  );

  ipcMain.handle("recurring-task:remove", async (_event, id: unknown) => {
    if (typeof id !== "string" || !id.trim()) {
      console.error("Failed to remove recurring task: missing task id");
      return false;
    }
    const taskId = id.trim();
    try {
      if (backendEventsSyncEnabled) {
        const response = await postStandaloneBackend("/api/recurring-task/remove", { id: taskId });
        removeStandaloneBackendRecurringTask(taskId);
        return response["removed"] === true;
      }
      return removeRecurringTask(taskId);
    } catch (error) {
      console.error(`Failed to remove recurring task: ${getErrorMessage(error)}`);
      return false;
    }
  });
}

function setupIpc(): void {
  setupLegacyIpc();
  setupSharedIpc();
  setupGoogleCalendarIpc();
}

function setupSharedIpc(): void {
  ipcMain.handle("shell:get-config", () => ({
    url: process.env["MULTITASKER_SHELL_SERVER_URL"]?.trim() || "ws://127.0.0.1:4321",
    token: process.env["SHELL_AUTH_TOKEN"] || "",
  }));

  ipcMain.handle("shell:create-pty", async (_e, cwdArg?: unknown, nameArg?: unknown) => {
    const cwd =
      typeof cwdArg === "string" && cwdArg.trim() ? cwdArg.trim() : process.env["USERPROFILE"] || process.env["HOME"] || process.cwd();
    const settings = loadSettings();
    const localShell = settings.defaultShell === "bash" ? "bash" : "powershell";
    try {
      const pty = await spawnShellPty({ cwd, track: false });
      const shortId = pty.sessionId.slice(0, 8);
      const name = typeof nameArg === "string" && nameArg.trim() ? nameArg.trim() : `shell ${shortId}`;
      const session = sessionManager?.createSession(name, "", pty.cwd, localShell, pty.sessionId) ?? null;
      if (session) {
        debugTerminalUpdate("shell pty created from app", {
          id: session.id,
          pid: pty.pid,
          shell: pty.shell,
        });
        saveSessions(getSessionsStateToSave());
      }
      return session;
    } catch (error) {
      console.error(`Failed to create shell PTY: ${getErrorMessage(error)}`);
      return null;
    }
  });

  ipcMain.handle("shell:create-ssh", async (_e, optsArg?: unknown) => {
    const opts =
      optsArg && typeof optsArg === "object"
        ? (optsArg as {
            host?: unknown;
            username?: unknown;
            port?: unknown;
            privateKeyPath?: unknown;
            passphrase?: unknown;
            agent?: unknown;
            initCommand?: unknown;
            name?: unknown;
          })
        : {};
    const host = typeof opts.host === "string" ? opts.host.trim() : "";
    const username = typeof opts.username === "string" ? opts.username.trim() : "";
    if (!host || !username) {
      console.error("shell:create-ssh missing host/username");
      return null;
    }
    const port = typeof opts.port === "number" && opts.port > 0 ? opts.port : 22;
    const sshOpts: {
      host: string;
      username: string;
      port: number;
      privateKeyPath?: string;
      passphrase?: string;
      agent?: string;
      initCommand?: string;
    } = { host, username, port };
    if (typeof opts.privateKeyPath === "string" && opts.privateKeyPath.trim()) sshOpts.privateKeyPath = opts.privateKeyPath.trim();
    if (typeof opts.passphrase === "string") sshOpts.passphrase = opts.passphrase;
    if (typeof opts.agent === "string" && opts.agent.trim()) sshOpts.agent = opts.agent.trim();
    if (typeof opts.initCommand === "string" && opts.initCommand.trim()) sshOpts.initCommand = opts.initCommand.trim();
    try {
      const ssh = await spawnShellSsh(sshOpts);
      const shortId = ssh.sessionId.slice(0, 8);
      const baseName =
        typeof opts.name === "string" && opts.name.trim()
          ? opts.name.trim()
          : `ssh ${username}@${host}${port !== 22 ? ":" + port : ""} ${shortId}`;
      const sessionSshOptions: {
        host: string;
        username: string;
        port?: number;
        privateKeyPath?: string;
        agent?: string;
        initCommand?: string;
      } = { host, username };
      if (port !== 22) sessionSshOptions.port = port;
      if (sshOpts.privateKeyPath) sessionSshOptions.privateKeyPath = sshOpts.privateKeyPath;
      if (sshOpts.agent) sessionSshOptions.agent = sshOpts.agent;
      if (sshOpts.initCommand) sessionSshOptions.initCommand = sshOpts.initCommand;
      const session =
        sessionManager?.createSession(
          baseName,
          "",
          ssh.cwd || "",
          "ssh",
          ssh.sessionId,
          `${username}@${host}${port !== 22 ? ":" + port : ""}`,
          "",
          undefined,
          sessionSshOptions,
        ) ?? null;
      if (session) {
        debugTerminalUpdate("shell ssh created from app", {
          id: session.id,
          host,
          username,
        });
        saveSessions(getSessionsStateToSave());
      }
      return session;
    } catch (error) {
      console.error(`Failed to create SSH session: ${getErrorMessage(error)}`);
      return null;
    }
  });

  ipcMain.handle("shell:reconnect-ssh", async (_e, idArg?: unknown) => {
    const sessionId = typeof idArg === "string" ? idArg.trim() : "";
    if (!sessionId) {
      return { ok: false, error: "missing_session_id" } as const;
    }
    return reconnectShellSshSession(sessionId);
  });

  ipcMain.handle("shell:focus-vscode", async (_e, idArg?: unknown) => {
    const sessionId = typeof idArg === "string" ? idArg.trim() : "";
    if (!sessionId) return { ok: false, error: "missing_session_id" } as const;
    return focusVscodeForSession(sessionId);
  });
}

// In-flight reconnect promises keyed by session id. Used so concurrent
// renderer requests for the same session collapse into one supervisor call â€”
// otherwise the supervisor would reject the second spawn with
// "session already exists" even though the reconnect actually succeeded.
const sshReconnectInFlight = new Map<string, Promise<SshReconnectResult>>();

type SshReconnectResult = { ok: true; sessionId: string } | { ok: false; error: string };

async function reconnectShellSshSession(sessionId: string): Promise<SshReconnectResult> {
  const existing = sshReconnectInFlight.get(sessionId);
  if (existing) return existing;
  const promise = (async (): Promise<SshReconnectResult> => {
    try {
      const session = await lookupSessionForReconnect(sessionId);
      if (!session) return { ok: false, error: "session_not_found" };
      if (session.shellType !== "ssh") return { ok: false, error: "not_ssh_session" };
      const status = session.status;
      if (status === "error" || status === "stopped" || status === "detached") {
        return { ok: false, error: `session_not_reconnectable:${status}` };
      }
      if (typeof session.terminalExitCode === "number") {
        return { ok: false, error: "session_already_exited" };
      }

      const sshOpts = buildSshConnectOptions(session);
      if (!sshOpts) return { ok: false, error: "ssh_options_missing" };

      try {
        await spawnShellSsh({ ...sshOpts, sessionId });
      } catch (error) {
        const message = getErrorMessage(error);
        // Supervisor may have a stale session from a previous reconnect
        // race â€” treat that as success and let the renderer attach.
        if (/already\s*exists/i.test(message)) {
          debugTerminalUpdate("shell ssh reconnect idempotent", { id: sessionId });
          return { ok: true, sessionId };
        }
        debugTerminalUpdate("shell ssh reconnect failed", { id: sessionId, error: message });
        return { ok: false, error: message };
      }

      debugTerminalUpdate("shell ssh reconnect ok", {
        id: sessionId,
        host: sshOpts.host,
        username: sshOpts.username,
      });
      if (sessionManager) {
        sessionManager.touchSession(sessionId);
        saveSessions(getSessionsStateToSave());
      }
      return { ok: true, sessionId };
    } catch (error) {
      return { ok: false, error: getErrorMessage(error) };
    }
  })();
  sshReconnectInFlight.set(sessionId, promise);
  try {
    return await promise;
  } finally {
    sshReconnectInFlight.delete(sessionId);
  }
}

async function lookupSessionForReconnect(sessionId: string): Promise<Session | null> {
  const backendSession = standaloneBackendSessions?.find((session) => session.id === sessionId);
  if (backendSession) return cloneSession(backendSession);
  return sessionManager?.getSession(sessionId) ?? null;
}

async function killShellSessionForRemovedSession(sessionId: string): Promise<void> {
  try {
    await killShellSession({
      sessionId,
      token: process.env["SHELL_AUTH_TOKEN"] || "",
    });
  } catch (error) {
    console.warn(`Could not kill shell session "${sessionId}": ${getErrorMessage(error)}`);
  }
}

type VsCodeFocusResult = { ok: true } | { ok: false; error: string };

async function focusVscodeForSession(sessionId: string): Promise<VsCodeFocusResult> {
  const session = await lookupSessionForReconnect(sessionId);
  if (!session) return { ok: false, error: "session_not_found" };
  const meta = session.clientMetadata;
  if (!meta || meta.kind !== "vscode") return { ok: false, error: "no_vscode_metadata" };
  const workspace = meta.workspace || session.cwd || "";
  if (!workspace) return { ok: false, error: "no_workspace" };
  // Spawn `code --reuse-window <workspace>`. Setting VSCODE_IPC_HOOK_CLI in
  // the env makes the CLI talk to the *originating* VS Code instance (the one
  // that opened this terminal), so the right window is focused instead of
  // potentially opening a new one.
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (meta.ipcHook) env["VSCODE_IPC_HOOK_CLI"] = meta.ipcHook;
  const isWindows = process.platform === "win32";
  const cmd = isWindows ? "code.cmd" : "code";
  try {
    const child = spawn(cmd, ["--reuse-window", workspace], {
      env,
      detached: true,
      stdio: "ignore",
      shell: isWindows,
    });
    child.on("error", (err) => {
      console.error("[focus-vscode] spawn failed", (err as Error).message);
    });
    child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function buildSshConnectOptions(session: Session): {
  host: string;
  username: string;
  port: number;
  privateKeyPath?: string;
  agent?: string;
  initCommand?: string;
} | null {
  if (session.sshOptions && session.sshOptions.host && session.sshOptions.username) {
    const o = session.sshOptions;
    const opts: { host: string; username: string; port: number; privateKeyPath?: string; agent?: string; initCommand?: string } = {
      host: o.host,
      username: o.username,
      port: o.port ?? 22,
    };
    if (o.privateKeyPath) opts.privateKeyPath = o.privateKeyPath;
    if (o.agent) opts.agent = o.agent;
    if (o.initCommand) opts.initCommand = o.initCommand;
    return opts;
  }
  const parsed = parseSshCommand(session.sshCommand);
  if (!parsed) return null;
  return { host: parsed.host, username: parsed.username, port: parsed.port };
}

function parseSshCommand(value: string | undefined): { host: string; username: string; port: number } | null {
  if (!value) return null;
  const trimmed = value.trim();
  // user@host[:port] â€” does not handle IPv6 with brackets; falls back to null.
  const m = /^([^@\s]+)@([^@:\s]+)(?::(\d+))?$/.exec(trimmed);
  if (!m) return null;
  const username = m[1];
  const host = m[2];
  if (!username || !host) return null;
  const port = m[3] ? parseInt(m[3], 10) : 22;
  if (!Number.isFinite(port) || port <= 0) return null;
  return { username, host, port };
}

function setupGoogleCalendarIpc(): void {
  ipcMain.handle("google-calendar:list", () => googleCalendarEvents.map(cloneGoogleCalendarEvent));
  ipcMain.handle("google-calendar:status", () => getFreshGoogleCalendarStatus());
  ipcMain.handle("google-calendar:connect", () => startGoogleCalendarAuthFlow());
  ipcMain.handle("google-calendar:disconnect", (_event, id?: unknown) => disconnectGoogleCalendar(id));
  ipcMain.handle("google-calendar:refresh", () => refreshGoogleCalendarEvents());
  ipcMain.handle("google-calendar:open", (_event, id: unknown) => openGoogleCalendarEvent(id));
}

function getSessionsStateToSave(): SessionState[] {
  const allSessions = sessionManager?.getSessions() ?? [];
  return allSessions
    .filter((s) => s.status !== "error" && s.status !== "stopped" && s.status !== "detached")
    .map((s) => ({
      id: s.id,
      name: s.name,
      cmd: s.cmd,
      cwd: s.cwd,
      shellType: s.shellType,
      ...(s.sshCommand ? { sshCommand: s.sshCommand } : {}),
      ...(s.sshOptions ? { sshOptions: s.sshOptions } : {}),
      ...(s.terminalRef ? { terminalRef: s.terminalRef } : {}),
      ...(s.terminalPid !== undefined ? { terminalPid: s.terminalPid } : {}),
    }));
}

function restorePersistedSessions(settings: AppSettings): void {
  const persistedSessions = loadSessions();
  persistedSessions
    .filter((s) => s.status !== "stopped" && s.status !== "error" && s.status !== "detached")
    .forEach((sessionState) => {
      const rawShellType = String(sessionState.shellType);
      const shellType = isShellType(rawShellType) ? rawShellType : settings.defaultShell;
      sessionManager?.createSession(
        sessionState.name,
        sessionState.cmd,
        sessionState.cwd,
        shellType,
        sessionState.id ?? "",
        sessionState.sshCommand ?? "",
        sessionState.terminalRef ?? "",
        sessionState.terminalPid,
        sessionState.sshOptions,
      );
    });
  for (const session of sessionManager?.getSessions() ?? []) {
    if (session.terminalRef) taskIdByTerminalRef.set(session.terminalRef, session.id);
  }
  flushPendingTerminalUpdates();
  flushPendingTerminalEvents();
}

function getRestorableWindowState(): WindowState | null {
  const savedState = loadWindowState();
  if (!savedState) return null;

  const state = {
    ...savedState,
    width: Math.max(WINDOW_MIN_WIDTH, savedState.width),
    height: Math.max(WINDOW_MIN_HEIGHT, savedState.height),
  };
  return isWindowBoundsVisible(state) ? state : null;
}

function isWindowBoundsVisible(bounds: Rectangle): boolean {
  return screen.getAllDisplays().some((display) => {
    const workArea = display.workArea;
    const visibleWidth = Math.min(bounds.x + bounds.width, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x);
    const visibleHeight = Math.min(bounds.y + bounds.height, workArea.y + workArea.height) - Math.max(bounds.y, workArea.y);
    return visibleWidth >= MIN_VISIBLE_WINDOW_AREA && visibleHeight >= MIN_VISIBLE_WINDOW_AREA;
  });
}

function trackWindowState(window: BrowserWindow): void {
  const queueSave = (): void => queueWindowStateSave(window);
  window.on("move", queueSave);
  window.on("resize", queueSave);
  window.on("maximize", queueSave);
  window.on("unmaximize", queueSave);
  window.on("close", () => {
    if (windowStateSaveTimer) {
      clearTimeout(windowStateSaveTimer);
      windowStateSaveTimer = null;
    }
    saveWindowStateForWindow(window);
  });
}

function queueWindowStateSave(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer);
  windowStateSaveTimer = setTimeout(() => {
    windowStateSaveTimer = null;
    saveWindowStateForWindow(window);
  }, WINDOW_STATE_SAVE_DEBOUNCE_MS);
}

function saveWindowStateForWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  const bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds();
  saveWindowState({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized: window.isMaximized(),
  });
}

function createWindow(): void {
  sessionManager = new SessionManager();
  const savedWindowState = getRestorableWindowState();
  const windowOptions: BrowserWindowConstructorOptions = {
    width: savedWindowState?.width ?? WINDOW_WIDTH,
    height: savedWindowState?.height ?? WINDOW_HEIGHT,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    backgroundColor: "#0d1117",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  };
  if (savedWindowState) {
    windowOptions.x = savedWindowState.x;
    windowOptions.y = savedWindowState.y;
  }

  mainWindow = new BrowserWindow(windowOptions);
  if (savedWindowState?.isMaximized) mainWindow.maximize();
  trackWindowState(mainWindow);

  sessionManager?.on("sessionUpdate", (sessions: unknown) => {
    if (backendEventsSyncEnabled && standaloneBackendSessions) return;
    mainWindow?.webContents.send("session:list-update", sessions);
  });

  mainWindow.on("focus", () => {
    mainWindow?.flashFrame(false);
    sessionManager?.refreshGitChanges();
  });

  const settings = loadSettings();
  restorePersistedSessions(settings);
  restorePersistedManualTasks();
  restorePersistedRecurringTasks();
  startRecurringTaskScheduler();
  restorePersistedGoogleCalendarEvents();
  startGoogleCalendarScheduler();
  if (process.env["NODE_ENV"] === "development") {
    void mainWindow.loadURL("http://localhost:5173");
  } else {
    void mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  }
}

void app.whenReady().then(async () => {
  const hasSingleInstanceLock = app.requestSingleInstanceLock();
  if (!hasSingleInstanceLock) {
    app.quit();
    return;
  }

  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  setStorageDirectory(app.getPath("userData"));
  setupIpc();
  createWindow();
  await startTerminalUpdateServer();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
  stopRecurringTaskScheduler();
  stopGoogleCalendarScheduler();
  stopStandaloneBackendSync();
  stopTerminalUpdateServer();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
