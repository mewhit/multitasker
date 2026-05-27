import fs from 'node:fs';
import path from 'node:path';
import { DEBUG_LOG_DIRECTORY, SLACK_SOCKET_DEBUG_LOG_FILE } from '../../core/constants';
import { getErrorMessage, formatDebugValue } from '../../core/util';
import { reportedDebugLogWriteFailures } from '../../state/debug';

export function debugSlackEventDecision(decision: string, details: Record<string, unknown>): void {
  debugSlackLog(`Slack event ${decision}`, details);
}

export function debugSlackLog(message: string, details: Record<string, unknown> = {}): void {
  appendSlackDebugLog(message, details);
}

export function appendSlackDebugLog(message: string, details: Record<string, unknown> = {}): void {
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

function reportDebugLogWriteFailure(message: string): void {
  if (reportedDebugLogWriteFailures.has(message)) return;
  reportedDebugLogWriteFailures.add(message);
  console.warn(message);
}
