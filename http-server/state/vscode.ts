import type { VsCodeWindowEntry, PendingVsCodeCommandPoll, VsCodeCommand } from '../types';

export const vscodeWindowsById = new Map<string, VsCodeWindowEntry>();
export const pendingVsCodeCommandsByWindowId = new Map<string, VsCodeCommand[]>();
export const pendingVsCodeCommandPollsByWindowId = new Map<string, PendingVsCodeCommandPoll>();
