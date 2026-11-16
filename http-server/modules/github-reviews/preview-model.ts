import { randomUUID } from 'node:crypto';
import type { ReviewCommentDraft } from '../../../shared/github-previews';
import { isRecord } from '../../utils/payload';

export interface ReviewFile { filename: string; patch?: string; status: string }

export const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'comments'],
  properties: {
    summary: { type: 'string' },
    comments: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['path', 'line', 'body'],
      properties: { path: { type: 'string' }, line: { type: 'integer' }, body: { type: 'string' } },
    } },
  },
};

export function changedLines(patch: string): Set<number> {
  const lines = new Set<number>();
  let line = 0;
  let inHunk = false;
  for (const row of patch.split('\n')) {
    const hunk = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { line = Number(hunk[1]); inHunk = true; continue; }
    if (!inHunk) continue;
    if (row.startsWith('+')) { lines.add(line); line++; }
    else if (row.startsWith(' ')) line++;
  }
  return lines;
}

export function validateReviewDraft(value: unknown, files: ReviewFile[]): { summary: string; comments: ReviewCommentDraft[] } {
  if (!isRecord(value) || typeof value['summary'] !== 'string' || !Array.isArray(value['comments'])) throw new Error('The AI did not return a review draft.');
  if (value['summary'].length > 20000 || value['comments'].length > 50) throw new Error('Review draft is too large.');
  const allowed = new Map(files.map(file => [file.filename, changedLines(file.patch ?? '')]));
  const comments = value['comments'].map((comment): ReviewCommentDraft => {
    if (!isRecord(comment) || typeof comment['path'] !== 'string' || !Number.isInteger(comment['line']) ||
        typeof comment['body'] !== 'string' || !comment['body'].trim() || comment['body'].length > 10000) throw new Error('Invalid review comment.');
    const line = comment['line'] as number;
    if (!allowed.get(comment['path'])?.has(line)) throw new Error(`Comment is not on an added line: ${comment['path']}:${line}`);
    return { id: randomUUID(), path: comment['path'], line, body: comment['body'].trim() };
  });
  return { summary: value['summary'].trim(), comments };
}

export function instructionPaths(files: ReviewFile[]): string[] {
  const paths = new Set(['AGENTS.md']);
  for (const file of files) {
    const parts = file.filename.split('/');
    for (let i = 1; i < parts.length; i++) paths.add(parts.slice(0, i).join('/') + '/AGENTS.md');
  }
  return [...paths].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}
