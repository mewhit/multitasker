import { broadcastSseEvent } from '../../core/sse';
import { getBackendState } from '../../core/backend-state';
import { slackNotifications } from '../../state/tasks';
import { cloneSlackNotification } from '../../utils/clone';

export function broadcastSlackListUpdate(): void {
  broadcastSseEvent('slack:list-update', slackNotifications.map(cloneSlackNotification));
  broadcastSseEvent('state', getBackendState());
}
