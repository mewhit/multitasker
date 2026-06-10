import type { HttpModule } from '../core/types';
import { healthModule } from './health';
import { eventsModule } from './events';
import { coreModule } from './core';
import { settingsModule } from './settings';
import { googleCalendarModule } from './google-calendar';
import { manualTasksModule } from './manual-tasks';
import { recurringTasksModule } from './recurring-tasks';
import { githubReviewsModule } from './github-reviews';
import { terminalsModule } from './terminals';
import { sessionsModule } from './sessions';
export const modules: HttpModule[] = [
  healthModule,
  eventsModule,
  coreModule,
  settingsModule,
  googleCalendarModule,
  manualTasksModule,
  recurringTasksModule,
  githubReviewsModule,
  terminalsModule,
  sessionsModule,
];
