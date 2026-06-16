import { broadcastSseEvent } from '../../core/sse';
import { getBackendNextUpItems, getBackendState } from '../../core/backend-state';
import { recurringTasks } from '../../state/tasks';
import { cloneRecurringTask } from '../../utils/clone';

export function broadcastRecurringTasks(): void {
  broadcastSseEvent('recurring-task:list-update', recurringTasks.map(cloneRecurringTask));
  broadcastSseEvent('state', getBackendState());
  broadcastSseEvent('next-up:list-update', getBackendNextUpItems());
}
