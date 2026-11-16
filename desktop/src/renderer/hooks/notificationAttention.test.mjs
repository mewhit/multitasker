import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NotificationAttention } from './notificationAttention.ts';

const session = (key, status = 'needs_attention') => ({ key, source: 'session', status, startDate: 0 });

test('pausing silences a pending session until it is explicitly resumed', () => {
  const attention = new NotificationAttention();
  assert.equal(attention.update([session('session:a')], 0), true);
  assert.equal(attention.update([session('session:a', 'paused')], 1), false);
  assert.equal(attention.update([session('session:a', 'paused')], 60_000), false);
  assert.equal(attention.update([session('session:a')], 60_001), true);
});

test('each pending task needs its own click; a new attention episode rings again', () => {
  const attention = new NotificationAttention();
  const items = [session('a'), session('b')];
  assert.equal(attention.update(items, 0), true);
  assert.equal(attention.acknowledge('unrelated'), true);
  assert.equal(attention.acknowledge('a'), true);
  assert.equal(attention.acknowledge('b'), false);
  assert.equal(attention.update(items, 1), false);
  assert.equal(attention.update([session('a', 'running'), session('b')], 2), false);
  assert.equal(attention.update(items, 3), true);
  assert.equal(attention.update([], 4), false);
});

test('scheduled tasks wait until due; calendar reminders begin five minutes before', () => {
  const attention = new NotificationAttention();
  const manual = { key: 'manual', source: 'manual-task', startDate: 600_000 };
  const calendar = { key: 'calendar', source: 'google-calendar', startDate: 900_000 };
  assert.equal(attention.update([manual, calendar], 599_999), false);
  assert.equal(attention.update([manual, calendar], 600_000), true);
  assert.equal(attention.acknowledge('manual'), true);
  assert.equal(attention.acknowledge('calendar'), false);
  assert.equal(attention.update([manual, { ...calendar, startDate: 900_001 }], 600_001), true);
});
