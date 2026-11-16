import { randomUUID } from 'node:crypto';

export type TimerSound = 'notification' | 'ringtone';

export interface TimerTask {
  id: string;
  text: string;
  dueAt: number;
  fired: boolean;
  sound: TimerSound;
}

export class TimerTasks {
  private tasks: TimerTask[];
  private save: (tasks: TimerTask[]) => void;

  constructor(value: unknown, save: (tasks: TimerTask[]) => void) {
    this.save = save;
    this.tasks = Array.isArray(value) ? value.filter((task): task is TimerTask =>
      typeof task === 'object' && task !== null &&
      typeof task.id === 'string' && typeof task.text === 'string' &&
      Number.isSafeInteger(task.dueAt) && task.dueAt > 0 && typeof task.fired === 'boolean'
    ).map(task => ({ ...task, sound: task.sound === 'ringtone' ? 'ringtone' : 'notification' })) : [];
  }

  list(): TimerTask[] {
    return this.tasks.map(task => ({ ...task })).sort((a, b) => a.dueAt - b.dueAt);
  }

  add(text: unknown, seconds: unknown, now = Date.now(), sound: unknown = 'notification'): TimerTask[] {
    if (sound !== 'notification' && sound !== 'ringtone') throw new Error('Choose a notification sound or ringtone.');
    if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 1 || seconds > 604800) {
      throw new Error('Choose a duration between 1 second and 7 days.');
    }
    if (typeof text !== 'string' || text.length > 200) throw new Error('Use a label of at most 200 characters.');
    if (this.tasks.length >= 100) throw new Error('Remove a timer before adding more (maximum 100).');
    this.commit([...this.tasks, { id: randomUUID(), text: text.trim() || 'Timer', dueAt: now + seconds * 1000, fired: false, sound }]);
    return this.list();
  }

  remove(id: unknown): TimerTask[] {
    if (typeof id !== 'string') throw new Error('Invalid timer.');
    this.commit(this.tasks.filter(task => task.id !== id));
    return this.list();
  }

  tick(now = Date.now()): TimerTask[] {
    const due = this.tasks.filter(task => !task.fired && task.dueAt <= now);
    if (!due.length) return [];
    this.commit(this.tasks.map(task => !task.fired && task.dueAt <= now ? { ...task, fired: true } : task));
    return due.map(task => ({ ...task, fired: true }));
  }

  private commit(tasks: TimerTask[]): void {
    this.save(tasks);
    this.tasks = tasks;
  }
}
