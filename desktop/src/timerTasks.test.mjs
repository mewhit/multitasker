import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TimerTasks } from './timerTasks.ts';

test('sound choices survive saving, firing and restoring; legacy timers use notification sounds', () => {
  let saved;
  const timers = new TimerTasks([], value => { saved = structuredClone(value); });
  timers.add('Ring', 1, 1000, 'ringtone');
  timers.add('Notify', 2, 1000, 'notification');
  const restored = new TimerTasks(saved, () => {});
  assert.deepEqual(restored.tick(3000).map(task => task.sound), ['ringtone', 'notification']);
  const legacy = saved.map(({ sound, ...task }) => task);
  assert.ok(new TimerTasks(legacy, () => {}).list().every(task => task.sound === 'notification'));
  assert.throws(() => timers.add('Invalid', 1, 1000, 'invalid'), /Choose/);
  assert.equal(timers.list().length, 2);
});

test('timers fire at their deadline once, including after a long sleep', () => {
  const timers = new TimerTasks([], () => {});
  timers.add('Minute', 60, 1000);
  timers.add('Hour', 3600, 1000);
  timers.add('Two hours', 7200, 1000);
  assert.deepEqual(timers.tick(60999), []);
  assert.deepEqual(timers.tick(61000).map(task => task.text), ['Minute']);
  assert.deepEqual(timers.tick(61000), []);
  assert.deepEqual(timers.tick(8000000).map(task => task.text), ['Hour', 'Two hours']);
  assert.deepEqual(timers.tick(8000001), []);
});

test('restored timers catch up, dismissed and cancelled timers stay removed', () => {
  let saved;
  const timers = new TimerTasks([], value => { saved = structuredClone(value); });
  const [first] = timers.add('Cancel me', 60, 1000);
  timers.remove(first.id);
  timers.add('Remind me', 60, 1000);
  const restored = new TimerTasks(saved, value => { saved = structuredClone(value); });
  const [alarm] = restored.tick(90000);
  assert.equal(alarm.text, 'Remind me');
  assert.deepEqual(new TimerTasks(saved, () => {}).tick(100000), []);
  restored.remove(alarm.id);
  assert.deepEqual(new TimerTasks(saved, () => {}).list(), []);
});

test('rejects invalid durations and does not lose state on failed persistence', () => {
  const timers = new TimerTasks([], () => {});
  for (const seconds of [0, -1, NaN, Infinity, 0.5, 604801, '60']) {
    assert.throws(() => timers.add('Test', seconds));
  }
  assert.throws(() => timers.add('x'.repeat(201), 60));
  const [task] = timers.add('', 60, 1000);
  assert.equal(task.text, 'Timer');
  const broken = new TimerTasks(timers.list(), () => { throw new Error('Disk full'); });
  assert.throws(() => broken.tick(61000), /Disk full/);
  assert.equal(broken.list()[0].fired, false);
});
