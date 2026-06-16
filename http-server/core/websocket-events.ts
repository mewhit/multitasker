import type { ManualTaskState } from '../../shared/settings';
import { getServerEnvValue } from './env';

type BackendWebSocketMessage =
  | { type: 'backend_manual_task_added'; task: ManualTaskState }
  | { type: 'backend_manual_tasks'; tasks: ManualTaskState[] };

const MAX_PENDING_MESSAGES = 100;
const RECONNECT_DELAY_MS = 1000;
const WS_OPEN = 1;

let socket: WebSocket | null = null;
let socketReady = false;
let connecting = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let disabledReason = '';
let warnedMissingWebSocket = false;
let lastWarning = '';
const pendingMessages: BackendWebSocketMessage[] = [];

export function publishManualTaskAddedToWebSocket(task: ManualTaskState): void {
  enqueueBackendWebSocketMessage({ type: 'backend_manual_task_added', task: cloneManualTask(task) });
}

export function publishManualTasksSnapshotToWebSocket(tasks: ManualTaskState[]): void {
  enqueueBackendWebSocketMessage({ type: 'backend_manual_tasks', tasks: tasks.map(cloneManualTask) });
}

function enqueueBackendWebSocketMessage(message: BackendWebSocketMessage): void {
  if (disabledReason) return;

  if (socketReady && socket?.readyState === WS_OPEN) {
    sendBackendWebSocketMessage(message);
    return;
  }

  pendingMessages.push(message);
  if (pendingMessages.length > MAX_PENDING_MESSAGES) {
    pendingMessages.splice(0, pendingMessages.length - MAX_PENDING_MESSAGES);
  }
  connectBackendWebSocket();
}

function connectBackendWebSocket(): void {
  if (socketReady || connecting || disabledReason) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const WebSocketCtor = globalThis.WebSocket;
  if (typeof WebSocketCtor !== 'function') {
    if (!warnedMissingWebSocket) {
      warnedMissingWebSocket = true;
      console.warn('Manual task WebSocket publishing is unavailable because this Node runtime has no global WebSocket.');
    }
    return;
  }

  connecting = true;
  try {
    const ws = new WebSocketCtor(getShellServerWebSocketUrl());
    socket = ws;
    ws.addEventListener('open', () => {
      connecting = false;
    });
    ws.addEventListener('message', event => {
      handleBackendWebSocketMessage(ws, event.data);
    });
    ws.addEventListener('error', () => {
      reportWebSocketWarning('Manual task WebSocket publisher could not connect to the shell gateway.');
    });
    ws.addEventListener('close', () => {
      handleBackendWebSocketClose(ws);
    });
  } catch (error) {
    connecting = false;
    reportWebSocketWarning(`Manual task WebSocket publisher failed to start: ${getErrorMessage(error)}`);
    scheduleReconnect();
  }
}

function handleBackendWebSocketMessage(ws: WebSocket, data: unknown): void {
  if (socket !== ws) return;
  const message = parseJson(readWebSocketData(data));
  if (!isRecord(message)) return;

  const type = readStringField(message, 'type');
  if (type === 'ready') {
    if (message['requiresAuth'] === true && message['authenticated'] !== true) {
      const token = getServerEnvValue('SHELL_AUTH_TOKEN');
      if (!token) {
        disablePublisher('shell gateway requires SHELL_AUTH_TOKEN for manual task WebSocket publishing');
        return;
      }
      sendRawWebSocketMessage({ type: 'hello', token });
      return;
    }
    markSocketReady(ws);
    return;
  }

  if (type === 'authenticated') {
    markSocketReady(ws);
    return;
  }

  if (type === 'error' && readStringField(message, 'code') === 'unauthorized') {
    disablePublisher('shell gateway rejected manual task WebSocket publisher authentication');
  }
}

function markSocketReady(ws: WebSocket): void {
  if (socket !== ws || ws.readyState !== WS_OPEN) return;
  socketReady = true;
  connecting = false;
  lastWarning = '';
  flushPendingMessages();
}

function flushPendingMessages(): void {
  const messages = pendingMessages.splice(0);
  for (const message of messages) {
    sendBackendWebSocketMessage(message);
  }
}

function sendBackendWebSocketMessage(message: BackendWebSocketMessage): void {
  if (!socket || socket.readyState !== WS_OPEN || !socketReady) {
    pendingMessages.unshift(message);
    connectBackendWebSocket();
    return;
  }

  try {
    socket.send(JSON.stringify(message));
  } catch (error) {
    pendingMessages.unshift(message);
    socketReady = false;
    reportWebSocketWarning(`Manual task WebSocket publish failed: ${getErrorMessage(error)}`);
    try {
      socket.close();
    } catch {
      // The reconnect path below handles a socket that is already closing.
    }
    scheduleReconnect();
  }
}

function sendRawWebSocketMessage(message: { type: 'hello'; token: string }): void {
  if (!socket || socket.readyState !== WS_OPEN) return;
  try {
    socket.send(JSON.stringify(message));
  } catch (error) {
    reportWebSocketWarning(`Manual task WebSocket authentication failed: ${getErrorMessage(error)}`);
    try {
      socket.close();
    } catch {
      // The close handler will reconnect if there is still pending work.
    }
  }
}

function handleBackendWebSocketClose(ws: WebSocket): void {
  if (socket !== ws) return;
  socket = null;
  socketReady = false;
  connecting = false;
  if (pendingMessages.length > 0) scheduleReconnect();
}

function scheduleReconnect(): void {
  if (disabledReason || reconnectTimer || pendingMessages.length === 0) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectBackendWebSocket();
  }, RECONNECT_DELAY_MS);
}

function disablePublisher(reason: string): void {
  disabledReason = reason;
  pendingMessages.length = 0;
  console.warn(`Manual task WebSocket publishing disabled: ${reason}.`);
  if (socket) {
    try {
      socket.close();
    } catch {
      // Nothing else to do; publishing is disabled for this process.
    }
  }
  socket = null;
  socketReady = false;
  connecting = false;
}

function getShellServerWebSocketUrl(): string {
  const configured = getServerEnvValue('MULTITASKER_SHELL_SERVER_URL');
  if (configured) return configured;

  const host = getServerEnvValue('SHELL_HOST') || '127.0.0.1';
  const port = getServerEnvValue('SHELL_PORT') || '4321';
  return `ws://${host}:${port}`;
}

function reportWebSocketWarning(message: string): void {
  if (message === lastWarning) return;
  lastWarning = message;
  console.warn(message);
}

function cloneManualTask(task: ManualTaskState): ManualTaskState {
  return { ...task };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function readWebSocketData(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  return String(data);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
