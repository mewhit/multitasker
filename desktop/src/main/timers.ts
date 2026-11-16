import { app, BrowserWindow, ipcMain, Notification, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { TimerTasks } from '../timerTasks.js';

export function startTimers(getWindow: () => BrowserWindow | null): () => void {
  const file = path.join(app.getPath('userData'), 'timer-tasks.json');
  let saved: unknown = [];
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const tasks = new TimerTasks(saved, value => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(value), 'utf8');
    fs.renameSync(`${file}.tmp`, file);
  });
  const broadcast = () => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send('timer:list-update', tasks.list());
  };
  ipcMain.handle('timer:list', () => tasks.list());
  ipcMain.handle('timer:add', (_event, text: unknown, seconds: unknown, sound: unknown) => {
    const result = tasks.add(text, seconds, Date.now(), sound);
    broadcast();
    return result;
  });
  ipcMain.handle('timer:remove', (_event, id: unknown) => {
    const result = tasks.remove(id);
    broadcast();
    return result;
  });
  const interval = setInterval(() => {
    try {
      const due = tasks.tick();
      if (!due.length) return;
      broadcast();
      if (due.some(task => task.sound === 'notification')) shell.beep();
      const window = getWindow();
      if (window && !window.isDestroyed()) window.flashFrame(true);
      if (Notification.isSupported()) {
        const notification = new Notification({
          title: due.length === 1 ? 'Timer finished' : `${due.length} timers finished`,
          body: due.map(task => task.text).join('\n'),
          silent: true,
        });
        notification.on('click', () => {
          const target = getWindow();
          if (!target || target.isDestroyed()) return;
          if (target.isMinimized()) target.restore();
          target.show();
          target.focus();
        });
        notification.show();
      }
    } catch (error) {
      console.error('[timers]', error);
    }
  }, 500);
  return () => clearInterval(interval);
}
