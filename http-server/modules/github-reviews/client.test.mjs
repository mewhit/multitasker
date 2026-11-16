import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchGitHubReviewNotifications } from './client.ts';

const notification = (id, unread = false) => ({ id: String(id), reason: 'review_requested', unread,
  subject: { type: 'PullRequest', title: 'Review me', url: `https://api.github.com/repos/mewhit/multitasker/pulls/${id}` },
  repository: { full_name: 'mewhit/multitasker', html_url: 'https://github.com/mewhit/multitasker' } });

test('read notifications still produce outstanding direct reviews, excluding closed and completed reviews', async t => {
  t.mock.method(globalThis, 'fetch', async value => {
    const url = new URL(value);
    if (url.pathname === '/notifications') {
      assert.equal(url.searchParams.get('all'), 'true');
      return Response.json([notification(2), notification(3), notification(4), notification(5, true)]);
    }
    if (url.pathname === '/user') return Response.json({ login: 'mewhit' });
    const id = url.pathname.split('/').at(-1);
    return Response.json({ state: id === '3' ? 'closed' : 'open', requested_reviewers: id === '4' ? [] : [{ login: 'Mewhit' }] });
  });
  assert.deepEqual((await fetchGitHubReviewNotifications('test')).map(n => n.id), ['2', '5']);
});

test('failed review lookup fails the poll rather than silently losing tracked requests', async t => {
  t.mock.method(globalThis, 'fetch', async value => {
    const url = new URL(value);
    if (url.pathname === '/notifications') return Response.json([notification(2)]);
    if (url.pathname === '/user') return Response.json({ login: 'mewhit' });
    return Response.json({ message: 'Rate limit exceeded' }, { status: 403 });
  });
  await assert.rejects(fetchGitHubReviewNotifications('test'), /GitHub review lookup failed \(403\)/);
});

test('does not send credentials to an untrusted notification subject URL', async t => {
  const n = notification(2); n.subject.url = 'https://example.com/repos/mewhit/multitasker/pulls/2';
  t.mock.method(globalThis, 'fetch', async value => {
    const url = new URL(value);
    assert.equal(url.origin, 'https://api.github.com');
    return Response.json(url.pathname === '/user' ? { login: 'mewhit' } : [n]);
  });
  assert.deepEqual(await fetchGitHubReviewNotifications('test'), []);
});
