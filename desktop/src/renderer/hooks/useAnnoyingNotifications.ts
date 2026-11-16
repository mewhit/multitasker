import { useEffect, useRef, useState } from 'react';
import type { NextUpItem } from './useNextUpList';
import { NotificationAttention } from './notificationAttention';

export function useAnnoyingNotifications(items: NextUpItem[]): void {
  const attention = useRef(new NotificationAttention());
  const [enabled, setEnabled] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let active = true;
    let changed = false;
    const settingsChanged = (event: Event) => {
      changed = true;
      setEnabled((event as CustomEvent<boolean>).detail === true);
    };
    window.addEventListener('multitasker:notification-settings', settingsChanged);
    void window.electronAPI.getSettings().then((settings: { annoyingNotifications?: boolean }) => {
      if (active && !changed) setEnabled(settings.annoyingNotifications === true);
    }).catch(console.error);
    const clicked = (event: MouseEvent) => {
      const card = (event.target as Element).closest<HTMLElement>('[data-next-up-key]');
      if (card?.dataset.nextUpKey) setPending(attention.current.acknowledge(card.dataset.nextUpKey));
    };
    const terminalPressed = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      const terminal = event.target.closest<HTMLElement>('[data-terminal-session-id]');
      const sessionId = terminal?.dataset.terminalSessionId;
      if (sessionId) setPending(attention.current.acknowledge(`session:${sessionId}`));
    };
    document.addEventListener('click', clicked, true);
    document.addEventListener('pointerdown', terminalPressed, true);
    return () => {
      active = false;
      window.removeEventListener('multitasker:notification-settings', settingsChanged);
      document.removeEventListener('click', clicked, true);
      document.removeEventListener('pointerdown', terminalPressed, true);
    };
  }, []);

  useEffect(() => {
    const update = () => setPending(attention.current.update(items, Date.now()));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [items]);

  const ringing = enabled && pending;
  useEffect(() => {
    if (!ringing) return;
    const audio = new AudioContext();
    // The audio loop continues while the application is in the background.
    const buffer = audio.createBuffer(1, audio.sampleRate, audio.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) {
      const time = i / audio.sampleRate;
      const beat = time % 0.5;
      if (beat < 0.3) {
        const envelope = Math.min(1, beat / 0.01, (0.3 - beat) / 0.03);
        samples[i] = 0.12 * envelope * Math.sin(2 * Math.PI * (time < 0.5 ? 660 : 880) * time);
      }
    }
    const source = audio.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(audio.destination);
    source.start();
    void audio.resume().catch(console.error);
    return () => { source.stop(); void audio.close(); };
  }, [ringing]);
}
