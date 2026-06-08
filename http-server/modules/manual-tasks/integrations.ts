import type { ManualTaskState } from '../../../shared/settings';
import { shouldBackendOwnState } from '../../core/constants';
import { broadcastSseEvent } from '../../core/sse';
import { cloneManualTask } from '../../utils/clone';
import { storeManualTask } from './service';

export function publishIntegrationManualTask(task: ManualTaskState): void {
  if (shouldBackendOwnState()) {
    storeManualTask(task);
    return;
  }
  broadcastSseEvent('manual-task:add', cloneManualTask(task));
}
