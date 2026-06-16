import { broadcastSseEvent } from '../../core/sse';
import { getBackendNextUpItems, getBackendState } from '../../core/backend-state';
import { publishManualTasksSnapshotToWebSocket } from '../../core/websocket-events';
import { manualTasks } from '../../state/tasks';
import { cloneManualTask } from '../../utils/clone';

export function broadcastManualTasks(): void {
  const tasks = manualTasks.map(cloneManualTask);
  broadcastSseEvent('manual-task:list-update', tasks);
  publishManualTasksSnapshotToWebSocket(tasks);
  broadcastSseEvent('state', getBackendState());
  broadcastSseEvent('next-up:list-update', getBackendNextUpItems());
}
