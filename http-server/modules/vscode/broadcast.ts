import { broadcastSseEvent } from '../../core/sse';
import { getBackendState } from '../../core/backend-state';
import { vscodeWindowsById } from '../../state/vscode';
import { cloneVsCodeWindowEntry } from '../../utils/clone';

export function broadcastVsCodeWindowsUpdate(): void {
  broadcastSseEvent('vscode:windows-update', [...vscodeWindowsById.values()].map(cloneVsCodeWindowEntry));
  broadcastSseEvent('state', getBackendState());
}
