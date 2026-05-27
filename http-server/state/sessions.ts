import { SessionManager } from '../../desktop/sessionManager';
import type { TerminalUpdate } from '../../desktop/sessionManager';
import type { TerminalEvent } from '../../desktop/terminalEvents';
import { setStorageDirectory } from '../../desktop/settings';

// Storage directory initialization
const storageDirectory = process.env['MULTITASKER_DATA_DIR']?.trim() || process.env['MULTITASKER_STORAGE_DIR']?.trim();
if (storageDirectory) setStorageDirectory(storageDirectory);

export function getStorageDirectory(): string | undefined {
  return storageDirectory;
}

// Session manager singleton
export const sessionManager = new SessionManager();

// Pending updates and removed sessions
export const pendingTerminalUpdates = new Map<string, TerminalUpdate>();
export const pendingTerminalEvents = new Map<string, TerminalEvent[]>();
export const removedSessionIds = new Set<string>();
export const taskIdByTerminalRef = new Map<string, string>();
export const pendingLaunchTaskIdByLaunchId = new Map<string, string>();
