import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('draft edits persist, stale commits block export, export stays pending and repeated exports are rejected', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multitasker-review-test-'));
  const previousDirectory = process.env.MULTITASKER_DATA_DIR;
  const previousToken = process.env.MULTITASKER_GITHUB_TOKEN;
  process.env.MULTITASKER_DATA_DIR = directory;
  process.env.MULTITASKER_GITHUB_TOKEN = 'test-token';
  t.after(() => {
    if (previousDirectory === undefined) delete process.env.MULTITASKER_DATA_DIR; else process.env.MULTITASKER_DATA_DIR = previousDirectory;
    if (previousToken === undefined) delete process.env.MULTITASKER_GITHUB_TOKEN; else process.env.MULTITASKER_GITHUB_TOKEN = previousToken;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const review = { id: 'owner/repo#2', repository: 'owner/repo', number: 2, title: 'Test', url: 'https://github.com/owner/repo/pull/2',
    headSha: 'original', status: 'ready', summary: 'Initial', comments: [], instructions: [], error: '', updatedAt: 1, revision: 1 };
  const store = path.join(directory, 'github-review-drafts.json');
  fs.writeFileSync(store, JSON.stringify({ repositories: [], reviews: [review] }));
  let sha = 'original';
  const posts = [];
  t.mock.method(globalThis, 'fetch', async (value, options) => {
    const url = new URL(value);
    if (options.method === 'POST') { posts.push(JSON.parse(options.body)); return Response.json({ id: 10, state: 'PENDING' }); }
    if (url.pathname === '/user') return Response.json({ login: 'mewhit' });
    if (url.pathname.endsWith('/files')) return Response.json([{ filename: 'a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }]);
    if (url.pathname.endsWith('/reviews')) return Response.json([]);
    return Response.json({ state: 'open', head: { sha }, changed_files: 1 });
  });
  const previews = await import('./previews.ts');
  await previews.saveReviewPreview({ id: review.id, revision: 1, summary: 'Edited by Mike', comments: [] });
  assert.equal(JSON.parse(fs.readFileSync(store)).reviews[0].summary, 'Edited by Mike');
  await assert.rejects(previews.saveReviewPreview({ id: review.id, revision: 1, summary: 'Stale edit', comments: [] }), /draft changed/);
  sha = 'new-commit';
  await assert.rejects(previews.exportPendingReview(review.id, 2), /PR changed/);
  assert.equal(posts.length, 0);
  sha = 'original';
  await previews.exportPendingReview(review.id, 2);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].event, undefined);
  assert.equal(posts[0].commit_id, 'original');
  assert.equal(posts[0].body, 'Edited by Mike');
  assert.equal(previews.getReviewPreviews().reviews[0].status, 'exported');
  await assert.rejects(previews.exportPendingReview(review.id, 2), /current draft/);
  assert.equal(posts.length, 1);
});
