import type { HttpModule, RouteDef } from '../../core/types';
import { writeJsonResponse } from '../../core/body';
import { recurringTasks } from '../../state/tasks';
import { cloneRecurringTask } from '../../utils/clone';
import { readPayloadString, readPayloadValue } from '../../utils/payload';
import { createRecurringTask, removeRecurringTask } from './service';
import { startRecurringTaskScheduler, stopRecurringTaskScheduler } from './scheduler';

export const recurringTasksModule: HttpModule = {
  name: 'recurring-tasks',
  init() {
    startRecurringTaskScheduler();
  },
  dispose() {
    stopRecurringTaskScheduler();
  },
  routes(): RouteDef[] {
    return [
      {
        method: 'GET',
        path: '/api/recurring-tasks',
        handler({ response }) {
          writeJsonResponse(response, 200, { ok: true, recurringTasks: recurringTasks.map(cloneRecurringTask) });
        },
      },
      {
        method: 'POST',
        path: '/api/recurring-task/add',
        handler({ payload, response }) {
          const task = createRecurringTask(
            readPayloadValue(payload, 'text'),
            readPayloadValue(payload, 'time'),
            readPayloadValue(payload, 'schedule') ?? readPayloadValue(payload, 'recurrence') ?? readPayloadValue(payload, 'daysOfWeek')
          );
          if (!task) {
            writeJsonResponse(response, 400, { ok: false, error: 'invalid_recurring_task' });
            return;
          }
          writeJsonResponse(response, 200, { ok: true, task });
        },
      },
      {
        method: 'POST',
        path: '/api/recurring-task/remove',
        handler({ payload, response }) {
          const id = readPayloadString(payload, 'id').trim();
          if (!id) {
            writeJsonResponse(response, 400, { ok: false, error: 'missing_task_id' });
            return;
          }
          writeJsonResponse(response, 200, { ok: true, removed: removeRecurringTask(id) });
        },
      },
    ];
  },
};
