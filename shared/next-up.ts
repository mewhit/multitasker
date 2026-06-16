import type { Session, SessionStatus } from './sessionManager';
import type { GoogleCalendarEventState, ManualTaskState, SlackNotificationState } from './settings';

export type NextUpSource = 'manual-task' | 'slack' | 'google-calendar' | 'session';
export type NextUpType = 'base-next-up' | 'interactible' | 'interactible-statued';

export interface BaseNextUp {
  type: NextUpType;
  source: NextUpSource;
  key: string;
  id: string;
  name: string;
  description: string;
  color: string;
  startDate: number;
  priority: number;
}

export interface ManualTaskNextUp extends BaseNextUp {
  type: 'base-next-up';
  source: 'manual-task';
}

export interface InteractibleNextUp extends BaseNextUp {
  type: 'interactible';
  source: 'slack' | 'google-calendar';
  url: string;
}

export interface InteractibleStatuedNextUp extends BaseNextUp {
  type: 'interactible-statued';
  source: 'session';
  url: string;
  status: SessionStatus;
}

export type NextUpItem = ManualTaskNextUp | InteractibleNextUp | InteractibleStatuedNextUp;

export interface NextUpInput {
  sessions?: readonly Session[];
  manualTasks?: readonly ManualTaskState[];
  slackNotifications?: readonly SlackNotificationState[];
  googleCalendarEvents?: readonly GoogleCalendarEventState[];
}

export interface NextUpState {
  order: string[];
  done: string[];
  items: NextUpItem[];
  updatedAt: number;
}

export interface NextUpBuildOptions {
  order?: readonly string[];
  done?: readonly string[];
}

const CALENDAR_TOP_WINDOW_MS = 5 * 60 * 1000;
const COLORS = {
  manualTask: '#d29922',
  slack: '#a371f7',
  googleCalendar: '#58a6ff',
  running: '#3fb950',
  attention: '#d29922',
  error: '#f85149',
  muted: '#484f58',
};

export function buildNextUpItems(input: NextUpInput, nowMs = Date.now(), options: NextUpBuildOptions = {}): NextUpItem[] {
  const items: NextUpItem[] = [
    ...(input.sessions ?? []).map(sessionToNextUp),
    ...(input.manualTasks ?? []).map(manualTaskToNextUp),
    ...(input.googleCalendarEvents ?? [])
      .filter(event => isCalendarEventVisibleToday(event, nowMs))
      .map(event => googleCalendarEventToNextUp(event, nowMs)),
    ...(input.slackNotifications ?? []).map(slackNotificationToNextUp),
  ].filter(item => !(options.done ?? []).includes(nextUpDoneKey(item)));

  const defaultOrderedItems = items.sort(compareDefaultNextUpItems);
  const order = syncNextUpOrder(options.order ?? [], defaultOrderedItems.map(item => item.key));
  const orderIndex = new Map(order.map((key, index) => [key, index]));
  return defaultOrderedItems.sort((a, b) => compareOrderedNextUpItems(a, b, orderIndex, nowMs));
}

export function createNextUpState(input: NextUpInput, state: Partial<NextUpState> = {}, nowMs = Date.now()): NextUpState {
  const availableItems = buildNextUpItems(input, nowMs);
  const order = syncNextUpOrder(state.order ?? [], availableItems.map(item => item.key));
  const done = syncNextUpDone(state.done ?? [], availableItems.map(nextUpDoneKey));
  return {
    order,
    done,
    items: buildNextUpItems(input, nowMs, { order, done }),
    updatedAt: nowMs,
  };
}

export function createNextUpStateWithOrder(
  input: NextUpInput,
  state: Partial<NextUpState>,
  order: readonly string[],
  nowMs = Date.now()
): NextUpState {
  return createNextUpState(input, { ...state, order: [...order] }, nowMs);
}

export function createNextUpStateWithDoneKey(
  input: NextUpInput,
  state: Partial<NextUpState>,
  key: string,
  nowMs = Date.now()
): NextUpState {
  const item = buildNextUpItems(input, nowMs).find(candidate => candidate.key === key);
  if (!item) return createNextUpState(input, state, nowMs);
  return createNextUpState(input, {
    ...state,
    done: uniqueStrings([...(state.done ?? []), nextUpDoneKey(item)]),
  }, nowMs);
}

export function syncNextUpOrder(order: readonly string[], availableKeys: readonly string[]): string[] {
  const available = new Set(availableKeys);
  const defaultIndex = new Map(availableKeys.map((key, index) => [key, index]));
  let nextOrder = uniqueStrings(order).filter(key => available.has(key));
  const present = new Set(nextOrder);
  availableKeys.forEach(key => {
    if (present.has(key)) return;
    const keyIndex = defaultIndex.get(key) ?? Number.MAX_SAFE_INTEGER;
    const insertAt = nextOrder.findIndex(existingKey => (defaultIndex.get(existingKey) ?? Number.MAX_SAFE_INTEGER) > keyIndex);
    if (insertAt < 0) nextOrder.push(key);
    else nextOrder.splice(insertAt, 0, key);
    present.add(key);
  });
  return normalizeSlackNextUpOrder(nextOrder, defaultIndex);
}

export function syncNextUpDone(done: readonly string[], availableDoneKeys: readonly string[]): string[] {
  const available = new Set(availableDoneKeys);
  return uniqueStrings(done).filter(key => available.has(key));
}

export function nextUpDoneKey(item: NextUpItem): string {
  if (item.source === 'session') return `${item.key}:${item.status}:${item.startDate}`;
  if (item.source === 'google-calendar') return `${item.key}:${item.startDate}`;
  return item.key;
}

export function normalizeNextUpItems(value: unknown): NextUpItem[] | null {
  if (!Array.isArray(value)) return null;
  const items: NextUpItem[] = [];
  for (const itemValue of value) {
    const item = normalizeNextUpItem(itemValue);
    if (item) items.push(item);
  }
  return items;
}

export function normalizeNextUpItem(value: unknown): NextUpItem | null {
  if (!isRecord(value)) return null;
  const type = readString(value, 'type');
  const source = readString(value, 'source');
  const key = readString(value, 'key');
  const id = readString(value, 'id');
  const name = readString(value, 'name');
  const description = readString(value, 'description');
  const color = readString(value, 'color');
  const startDate = readNumber(value, 'startDate');
  const priority = readNumber(value, 'priority');
  if (!key || !id || !name || !color || startDate === null || priority === null) return null;

  const base = {
    key,
    id,
    name,
    description,
    color,
    startDate,
    priority,
  };

  if (type === 'base-next-up' && source === 'manual-task') {
    return { ...base, type, source };
  }

  if (type === 'interactible' && (source === 'slack' || source === 'google-calendar')) {
    return { ...base, type, source, url: readString(value, 'url') };
  }

  if (type === 'interactible-statued' && source === 'session') {
    const status = readString(value, 'status');
    if (!isSessionStatus(status)) return null;
    return { ...base, type, source, url: readString(value, 'url'), status };
  }

  return null;
}

function sessionToNextUp(session: Session): InteractibleStatuedNextUp {
  return {
    type: 'interactible-statued',
    source: 'session',
    key: `session:${session.id}`,
    id: session.id,
    name: session.name,
    description: sessionDescription(session),
    color: sessionColor(session.status),
    startDate: session.lastActivity,
    priority: sessionPriority(session.status),
    url: `multitasker://session/${encodeURIComponent(session.id)}`,
    status: session.status,
  };
}

function manualTaskToNextUp(task: ManualTaskState): ManualTaskNextUp {
  return {
    type: 'base-next-up',
    source: 'manual-task',
    key: `manual:${task.id}`,
    id: task.id,
    name: task.text,
    description: '',
    color: COLORS.manualTask,
    startDate: task.createdAt,
    priority: taskPriority(task),
  };
}

function slackNotificationToNextUp(notification: SlackNotificationState): InteractibleNextUp {
  return {
    type: 'interactible',
    source: 'slack',
    key: `slack:${notification.id}`,
    id: notification.id,
    name: notificationTitle(notification),
    description: notification.text,
    color: COLORS.slack,
    startDate: notification.receivedAt,
    priority: slackPriority(notification),
    url: slackNotificationUrl(notification),
  };
}

function googleCalendarEventToNextUp(event: GoogleCalendarEventState, nowMs: number): InteractibleNextUp {
  return {
    type: 'interactible',
    source: 'google-calendar',
    key: `calendar:${event.id}`,
    id: event.id,
    name: event.summary,
    description: event.location ?? '',
    color: COLORS.googleCalendar,
    startDate: event.startMs,
    priority: isCalendarEventUrgent(event, nowMs) ? -1 : 4.5,
    url: event.htmlLink ?? '',
  };
}

function compareDefaultNextUpItems(a: NextUpItem, b: NextUpItem): number {
  const priorityDiff = nextUpSortPriority(a) - nextUpSortPriority(b);
  if (priorityDiff !== 0) return priorityDiff;
  const taskPriorityDiff = nextUpTaskPriority(a) - nextUpTaskPriority(b);
  if (taskPriorityDiff !== 0) return taskPriorityDiff;
  if (a.source === 'google-calendar' && b.source === 'google-calendar') return a.startDate - b.startDate;
  if (a.source === 'slack' && b.source === 'slack') return a.startDate - b.startDate;
  return b.startDate - a.startDate;
}

function compareOrderedNextUpItems(a: NextUpItem, b: NextUpItem, orderIndex: Map<string, number>, nowMs: number): number {
  const displayGroupDiff = displayGroup(a, nowMs) - displayGroup(b, nowMs);
  if (displayGroupDiff !== 0) return displayGroupDiff;
  const priorityDiff = nextUpSortPriority(a) - nextUpSortPriority(b);
  if (priorityDiff !== 0) return priorityDiff;
  const taskPriorityDiff = nextUpTaskPriority(a) - nextUpTaskPriority(b);
  if (taskPriorityDiff !== 0) return taskPriorityDiff;
  if (a.source === 'google-calendar' && b.source === 'google-calendar') return a.startDate - b.startDate;
  return (orderIndex.get(a.key) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(b.key) ?? Number.MAX_SAFE_INTEGER);
}

function nextUpSortPriority(item: NextUpItem): number {
  return item.source === 'manual-task' ? 2.5 : item.priority;
}

function nextUpTaskPriority(item: NextUpItem): number {
  return item.source === 'manual-task' ? item.priority : 0;
}

function displayGroup(item: NextUpItem, nowMs: number): number {
  if (item.source === 'google-calendar' && isCalendarNextUpUrgent(item, nowMs)) return 0;
  if (item.source === 'google-calendar') return 2;
  if (item.source === 'session' && (item.status === 'running' || item.status === 'paused')) return 3;
  return 1;
}

function isCalendarNextUpUrgent(item: NextUpItem, nowMs: number): boolean {
  return item.source === 'google-calendar' && item.priority < 0 && item.startDate <= nowMs + CALENDAR_TOP_WINDOW_MS;
}

function sessionDescription(session: Session): string {
  if (session.sshCommand?.trim()) return session.sshCommand.trim();
  return [session.cmd, session.cwd].map(value => value.trim()).filter(Boolean).join(' - ');
}

function sessionPriority(status: SessionStatus): number {
  if (status === 'needs_attention') return 0;
  if (status === 'error') return 1;
  if (status === 'waiting' || status === 'starting') return 3;
  if (status === 'stopped' || status === 'detached') return 4;
  if (status === 'paused') return 6;
  return 5;
}

function sessionColor(status: SessionStatus): string {
  if (status === 'needs_attention') return COLORS.attention;
  if (status === 'error') return COLORS.error;
  if (status === 'paused' || status === 'stopped' || status === 'detached') return COLORS.muted;
  return COLORS.running;
}

function taskPriority(task: ManualTaskState): number {
  return Number.isFinite(Number(task.priority)) ? Number(task.priority) : 0;
}

function notificationTitle(notification: SlackNotificationState): string {
  if (notification.channelName) return `#${notification.channelName}`;
  if (notification.userName) return notification.userName;
  return 'Slack';
}

function slackPriority(notification: SlackNotificationState): number {
  const rank = Number.isFinite(Number(notification.priorityRank)) ? Math.floor(Number(notification.priorityRank)) : 4;
  return 2 + Math.max(0, Math.min(4, rank)) / 10;
}

function slackNotificationUrl(notification: SlackNotificationState): string {
  const permalink = notification.permalink?.trim() ?? '';
  const channelId = notification.channelId?.trim() ?? '';
  if (!channelId) return permalink;

  const url = new URL('slack://channel');
  const teamId = notification.teamId?.trim() ?? '';
  if (teamId) url.searchParams.set('team', teamId);
  url.searchParams.set('id', channelId);
  const messageTs = notification.ts?.trim() || notification.threadTs?.trim() || '';
  if (messageTs) url.searchParams.set('message', messageTs);
  return url.toString();
}

function normalizeSlackNextUpOrder(order: string[], defaultIndex: Map<string, number>): string[] {
  const sortedSlackKeys = order
    .filter(key => key.startsWith('slack:'))
    .sort((a, b) => (defaultIndex.get(a) ?? Number.MAX_SAFE_INTEGER) - (defaultIndex.get(b) ?? Number.MAX_SAFE_INTEGER));
  if (sortedSlackKeys.length < 2) return order;

  let slackIndex = 0;
  return order.map(key => {
    if (!key.startsWith('slack:')) return key;
    const nextKey = sortedSlackKeys[slackIndex];
    slackIndex += 1;
    return nextKey ?? key;
  });
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function isCalendarEventVisibleToday(event: GoogleCalendarEventState, nowMs: number): boolean {
  if (!Number.isFinite(event.startMs) || !Number.isFinite(event.endMs) || event.endMs < nowMs) return false;
  const todayStartMs = startOfLocalDayMs(nowMs);
  const tomorrowStartMs = startOfNextLocalDayMs(nowMs);
  return event.startMs < tomorrowStartMs && event.endMs > todayStartMs;
}

function isCalendarEventUrgent(event: GoogleCalendarEventState, nowMs: number): boolean {
  if (event.allDay) return false;
  return event.endMs >= nowMs && nowMs >= event.startMs - CALENDAR_TOP_WINDOW_MS;
}

function startOfLocalDayMs(ms: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function startOfNextLocalDayMs(ms: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}

function isSessionStatus(value: string): value is SessionStatus {
  return value === 'waiting' ||
    value === 'starting' ||
    value === 'running' ||
    value === 'needs_attention' ||
    value === 'paused' ||
    value === 'error' ||
    value === 'stopped' ||
    value === 'detached';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
