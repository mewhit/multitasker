import type { NextUpInput, NextUpState } from '../../shared/next-up';
import { createNextUpState, createNextUpStateWithDoneKey, createNextUpStateWithOrder } from '../../shared/next-up';
import { loadNextUpState, saveNextUpState } from '../../shared/settings';
import { sessionManager } from '../state/sessions';
import { googleCalendarEvents, manualTasks, slackNotifications } from '../state/tasks';

export function getBackendNextUpState(): NextUpState {
  return saveNextUpStateIfChanged(createNextUpState(getBackendNextUpInput(), loadNextUpState()));
}

export function setBackendNextUpOrder(keys: string[]): NextUpState {
  return saveNextUpStateIfChanged(createNextUpStateWithOrder(getBackendNextUpInput(), loadNextUpState(), keys));
}

export function markBackendNextUpDone(key: string): NextUpState {
  return saveNextUpStateIfChanged(createNextUpStateWithDoneKey(getBackendNextUpInput(), loadNextUpState(), key));
}

function getBackendNextUpInput(): NextUpInput {
  return {
    sessions: sessionManager.getSessions(),
    manualTasks,
    slackNotifications,
    googleCalendarEvents,
  };
}

function saveNextUpStateIfChanged(nextState: NextUpState): NextUpState {
  const previousState = loadNextUpState();
  if (hasNextUpStateChanged(previousState, nextState)) {
    saveNextUpState(nextState);
  }
  return nextState;
}

function hasNextUpStateChanged(previousState: NextUpState, nextState: NextUpState): boolean {
  return JSON.stringify(previousState.order) !== JSON.stringify(nextState.order) ||
    JSON.stringify(previousState.done) !== JSON.stringify(nextState.done) ||
    JSON.stringify(previousState.items) !== JSON.stringify(nextState.items);
}
