import type { BackendState } from '../types';
import { sessionManager } from '../state/sessions';
import { manualTasks, recurringTasks, slackNotifications, googleCalendarEvents } from '../state/tasks';
import { getBackendNextUpState } from './next-up-state';
import { cloneGoogleCalendarEvent, cloneManualTask, cloneRecurringTask, cloneSlackNotification } from '../utils/clone';

export function getBackendState(): BackendState {
  const sessions = sessionManager.getSessions();
  return {
    sessions,
    manualTasks: manualTasks.map(cloneManualTask),
    recurringTasks: recurringTasks.map(cloneRecurringTask),
    slackNotifications: slackNotifications.map(cloneSlackNotification),
    googleCalendarEvents: googleCalendarEvents.map(cloneGoogleCalendarEvent),
    nextUp: getBackendNextUpState().items,
  };
}

export function getBackendNextUpItems() {
  return getBackendNextUpState().items;
}
