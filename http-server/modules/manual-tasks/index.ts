import type { HttpModule, RouteDef } from '../../core/types';
import { writeJsonResponse } from '../../core/body';
import { shouldBackendOwnState } from '../../core/constants';
import { broadcastSseEvent } from '../../core/sse';
import { manualTasks } from '../../state/tasks';
import { cloneManualTask } from '../../utils/clone';
import { readPayloadString } from '../../utils/payload';
import { parseManualTaskAddRequest, storeManualTask, removeManualTask } from './service';

export const manualTasksModule: HttpModule = {
  name: 'manual-tasks',
  routes(): RouteDef[] {
    return [
      {
        method: 'GET',
        path: '/api/manual-tasks',
        handler({ response }) {
          writeJsonResponse(response, 200, { ok: true, manualTasks: manualTasks.map(cloneManualTask) });
        },
      },
      {
        method: 'POST',
        path: '/api/manual-task/add',
        handler({ payload, response }) {
          handleManualTaskAddPost(payload, response);
        },
      },
      {
        method: 'POST',
        path: '/api/task/add',
        handler({ payload, response }) {
          handleManualTaskAddPost(payload, response);
        },
      },
      {
        method: 'POST',
        path: '/api/tasks',
        handler({ payload, response }) {
          handleManualTaskAddPost(payload, response);
        },
      },
      {
        method: 'POST',
        path: '/api/manual-task/remove',
        handler({ payload, response }) {
          const id = readPayloadString(payload, 'id').trim();
          if (!id) {
            writeJsonResponse(response, 400, { ok: false, error: 'missing_task_id' });
            return;
          }
          writeJsonResponse(response, 200, { ok: true, removed: removeManualTask(id) });
        },
      },
    ];
  },
};

function handleManualTaskAddPost(payload: unknown, response: import('http').ServerResponse): void {
  const task = parseManualTaskAddRequest(payload);
  if (!task) {
    writeJsonResponse(response, 400, { ok: false, error: 'invalid_manual_task' });
    return;
  }

  if (shouldBackendOwnState()) {
    writeJsonResponse(response, 200, { ok: true, task: storeManualTask(task) });
    return;
  }

  broadcastSseEvent('manual-task:add', cloneManualTask(task));
  writeJsonResponse(response, 200, { ok: true, task: cloneManualTask(task) });
}
