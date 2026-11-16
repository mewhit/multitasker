import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TimerSound, TimerTask } from '../../timerTasks';
import './TimerMenu.css';

function remaining(dueAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((dueAt - now) / 1000));
  const hours = Math.floor(seconds / 3600);
  return `${hours ? `${hours}:` : ''}${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function TimerMenu() {
  const [tasks, setTasks] = useState<TimerTask[]>([]);
  const [text, setText] = useState('');
  const [duration, setDuration] = useState('1');
  const [unit, setUnit] = useState(60);
  const [sound, setSound] = useState<TimerSound>('notification');
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const ringing = tasks.some(task => task.fired && task.sound === 'ringtone');

  useEffect(() => {
    if (!ringing) return;
    const audio = new AudioContext();
    // A looping audio buffer keeps ringing even when the window is minimized.
    const buffer = audio.createBuffer(1, audio.sampleRate * 2, audio.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) {
      const time = i / audio.sampleRate;
      const beat = time % 0.4;
      if (time < 1.2 && beat < 0.25) {
        const envelope = Math.min(1, beat / 0.01, (0.25 - beat) / 0.03);
        samples[i] = 0.18 * envelope * Math.sin(2 * Math.PI * (time < 0.4 ? 660 : 880) * time);
      }
    }
    const source = audio.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(audio.destination);
    source.start();
    void audio.resume().catch(() => setError('Could not play the ringtone.'));
    return () => { source.stop(); void audio.close(); };
  }, [ringing]);

  useEffect(() => {
    let active = true;
    let receivedUpdate = false;
    const update = (value: TimerTask[]) => {
      if (!active) return;
      setTasks(value);
      if (value.some(task => task.fired)) setOpen(true);
    };
    const unsubscribe = window.electronAPI.onTimersUpdate((value: TimerTask[]) => {
      receivedUpdate = true;
      update(value);
    });
    window.electronAPI.getTimers().then((value: TimerTask[]) => {
      if (!receivedUpdate) update(value);
    }).catch(() => { if (active) setError('Could not load timers.'); });
    const ticker = window.setInterval(() => setNow(Date.now()), 1000);
    const dismiss = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && root.current) {
        setOpen(false);
        document.getElementById('btn-sidebar-add')?.focus();
      }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      active = false;
      unsubscribe();
      window.clearInterval(ticker);
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, []);

  const change = async (operation: () => Promise<TimerTask[]>) => {
    setBusy(true);
    setError('');
    try { setTasks(await operation()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not update timer.'); }
    finally { setBusy(false); }
  };
  const add = (seconds: number) => void change(() => window.electronAPI.addTimer(text, seconds, sound));
  const finished = tasks.filter(task => task.fired).length;
  const addMenu = document.getElementById('sidebar-add-menu');

  return <>
    {addMenu && createPortal(<button className={`context-menu-item${finished ? ' timer-alert' : ''}`} id="btn-add-timer" onClick={() => {
      addMenu.classList.add('hidden');
      setOpen(true);
    }}>
      Timer{tasks.length > 0 ? ` (${finished ? `${finished} finished` : tasks.length})` : ''}
    </button>, addMenu)}
    {open && createPortal(<div className="plugin-menu timer-menu" ref={root} role="dialog" aria-label="Task timers">
      <h3>Task timers</h3>
      <label>Task (optional)<input maxLength={200} value={text} placeholder="Take a break, check a task…" onChange={event => setText(event.target.value)} /></label>
      <label className="timer-sound">Alert sound<select value={sound} onChange={event => setSound(event.target.value as TimerSound)}>
        <option value="notification">Notification sound (once)</option>
        <option value="ringtone">Ringtone (until dismissed)</option>
      </select></label>
      <div className="timer-presets">
        <button className="btn" disabled={busy} onClick={() => add(60)}>1 minute</button>
        <button className="btn" disabled={busy} onClick={() => add(3600)}>1 hour</button>
        <button className="btn" disabled={busy} onClick={() => add(7200)}>2 hours</button>
      </div>
      <form className="timer-duration" onSubmit={event => { event.preventDefault(); add(Number(duration) * unit); }}>
        <label>Duration<input type="number" min={1} max={604800 / unit} step={1} required value={duration} onChange={event => setDuration(event.target.value)} /></label>
        <label>Unit<select value={unit} onChange={event => setUnit(Number(event.target.value))}>
          <option value={1}>Seconds</option><option value={60}>Minutes</option><option value={3600}>Hours</option>
        </select></label>
        <button className="btn" type="submit" disabled={busy}>Start</button>
      </form>
      {error && <p role="alert" className="timer-error">{error}</p>}
      <p className="timer-hint">Keep Multitasker open for the alarm. Missed timers appear when you reopen it.</p>
      <div className="timer-list">
        {tasks.length === 0 && <p className="timer-hint">No timers yet.</p>}
        {tasks.map(task => <div className={`timer-row${task.fired ? ' timer-finished' : ''}`} key={task.id}>
          <div><strong>{task.text}</strong><div className="timer-countdown">{task.fired ? 'Time’s up!' : remaining(task.dueAt, now)}</div>
            <small>Due {new Date(task.dueAt).toLocaleString()} · {task.sound === 'ringtone' ? 'Ringtone' : 'Notification sound'}</small></div>
          <button className="btn" disabled={busy} aria-label={`${task.fired ? 'Dismiss' : 'Cancel'} ${task.text}`}
            onClick={() => void change(() => window.electronAPI.removeTimer(task.id))}>{task.fired ? 'Dismiss' : 'Cancel'}</button>
        </div>)}
      </div>
    </div>, document.body)}
  </>;
}
