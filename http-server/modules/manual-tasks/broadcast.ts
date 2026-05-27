import { broadcastSseEvent } from '../../core/sse';
import { getBackendState } from '../../core/backend-state';
import { manualTasks } from '../../state/tasks';
import { cloneManualTask } from '../../utils/clone';

export function broadcastManualTasks(): void {
  broadcastSseEvent('manual-task:list-update', manualTasks.map(cloneManualTask));
  broadcastSseEvent('state', getBackendState());
}
