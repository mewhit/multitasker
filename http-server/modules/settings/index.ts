import type { HttpModule, RouteDef } from '../../core/types';
import { writeJsonResponse } from '../../core/body';
import { loadSettings, saveSettings, type AppSettings } from '../../../shared/settings';
import { isLocalShellType } from '../../utils/types';
import { startGitHubReviewScheduler } from '../github-reviews';

export const settingsModule: HttpModule = {
  name: 'settings',
  routes(): RouteDef[] {
    return [
      {
        method: 'GET',
        path: '/api/settings',
        handler({ response }) {
          writeJsonResponse(response, 200, { ok: true, settings: loadSettings() });
        },
      },
      {
        method: 'POST',
        path: '/api/settings',
        handler({ payload, response }) {
          if (typeof payload !== 'object' || payload === null) {
            writeJsonResponse(response, 400, { ok: false, error: 'invalid_settings' });
            return;
          }
          const settings = payload as Partial<AppSettings>;
          const currentSettings = loadSettings();
          saveSettings({
            reviewTool: typeof settings.reviewTool === 'string' ? settings.reviewTool : currentSettings.reviewTool,
            defaultShell: isLocalShellType(settings.defaultShell) ? settings.defaultShell : currentSettings.defaultShell,
            googleCalendar: typeof settings.googleCalendar === 'object' && settings.googleCalendar !== null
              ? settings.googleCalendar
              : currentSettings.googleCalendar,
            githubReview: typeof settings.githubReview === 'object' && settings.githubReview !== null
              ? settings.githubReview
              : currentSettings.githubReview,
          });
          startGitHubReviewScheduler();
          writeJsonResponse(response, 200, { ok: true, settings: loadSettings() });
        },
      },
    ];
  },
};
