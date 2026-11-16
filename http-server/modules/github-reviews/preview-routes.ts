import type { RouteDef } from '../../core/types';
import { writeJsonResponse } from '../../core/body';
import { isRecord } from '../../utils/payload';
import { configureReviewRepository, deleteReviewPreview, exportPendingReview, getReviewPreviews, retryReviewPreview, saveReviewPreview } from './previews';

export function reviewPreviewRoutes(): RouteDef[] {
  return [
    { method: 'GET', path: '/api/github/previews', handler({ response }) {
      try { writeJsonResponse(response, 200, { ok: true, ...getReviewPreviews() }); }
      catch (error) { writeJsonResponse(response, 500, { ok: false, error: String(error) }); }
    } },
    { method: 'POST', path: '/api/github/previews', async handler({ payload, response }) {
      try {
        if (!isRecord(payload)) throw new Error('Invalid request.');
        const action = payload['action'];
        const id = typeof payload['id'] === 'string' ? payload['id'] : '';
        if (action === 'configure') configureReviewRepository(payload);
        else if (action === 'save') await saveReviewPreview(payload);
        else if (action === 'retry') retryReviewPreview(id);
        else if (action === 'delete') deleteReviewPreview(id);
        else if (action === 'export' && typeof payload['revision'] === 'number') await exportPendingReview(id, payload['revision']);
        else throw new Error('Unknown review action.');
        writeJsonResponse(response, 200, { ok: true, ...getReviewPreviews() });
      } catch (error) { writeJsonResponse(response, 400, { ok: false, error: error instanceof Error ? error.message : 'Review action failed.' }); }
    } },
  ];
}
