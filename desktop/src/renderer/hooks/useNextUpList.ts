import { useCallback, useEffect, useState } from 'react';

export interface NextUpItem {
  key: string;
  id: string;
  name: string;
  description: string;
  source: 'manual-task' | 'slack' | 'google-calendar' | 'session';
  color: string;
  startDate: number;
  priority: number;
  status?: 'waiting' | 'starting' | 'running' | 'needs_attention' | 'paused' | 'error' | 'stopped' | 'detached';
}

interface PausedSession {
  id: string;
  status?: NextUpItem['status'];
  lastActivity?: number;
}

interface BackendNextUpResponse {
  ok?: boolean;
  nextUp?: NextUpItem[];
}

const BACKEND_BASE_URL = 'http://127.0.0.1:39017';

export function useNextUpList() {
  const [items, setItems] = useState<NextUpItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (showLoading = false): Promise<NextUpItem[]> => {
    if (showLoading) setLoading(true);
    try {
      const nextUpItems = await window.electronAPI.getNextUp?.();
      const normalizedItems = Array.isArray(nextUpItems) ? nextUpItems : await fetchBackendNextUp();
      setItems(normalizedItems);
      setError(null);
      return normalizedItems;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load next-up list');
      return [];
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;

    void load(true);

    window.electronAPI.onNextUpListUpdate?.((nextUpItems: NextUpItem[]) => {
      if (!active) return;
      setItems(Array.isArray(nextUpItems) ? nextUpItems : []);
    });

    // Keep React list in sync when legacy events fire before next-up:list-update.
    window.electronAPI.onListUpdate?.(() => { void load(false); });
    window.electronAPI.onManualTaskListUpdate?.(() => { void load(false); });
    window.electronAPI.onSlackListUpdate?.(() => { void load(false); });
    window.electronAPI.onGoogleCalendarListUpdate?.(() => { void load(false); });

    return () => {
      active = false;
    };
  }, [load]);

  const markDone = async (key: string): Promise<void> => {
    try {
      if (key.startsWith('calendar:')) {
        await window.electronAPI.markNextUpDone?.(key);
      } else if (key.startsWith('slack:')) {
        await window.electronAPI.removeSlackNotification?.(key.slice('slack:'.length));
      } else if (key.startsWith('manual:')) {
        await window.electronAPI.removeManualTask?.(key.slice('manual:'.length));
      } else if (key.startsWith('session:')) {
        await window.electronAPI.removeSession?.(key.slice('session:'.length));
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to update next-up item');
    }
  };

  const moveItem = (key: string, direction: 'up' | 'down'): void => {
    setItems((prev) => {
      const index = prev.findIndex((item) => item.key === key);
      if (index < 0) return prev;
      const targetIndex = direction === 'up' ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= prev.length) return prev;

      const next = [...prev];
      [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
      void window.electronAPI.setNextUpOrder?.(next.map((item) => item.key));
      return next;
    });
  };

  const pauseItem = async (item: NextUpItem): Promise<void> => {
    if (item.source !== 'session') return;
    try {
      const pauseSession = window.electronAPI.pauseSession;
      if (typeof pauseSession !== 'function') throw new Error('Pause is unavailable.');
      const session = await pauseSession(item.id) as PausedSession | null | undefined;
      if (!isPausedSession(session)) throw new Error('The session could not be paused.');
      updatePausedItem(item.key, session);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to pause session');
    }
  };

  return { items, loading, error, markDone, moveItem, pauseItem };

  function updatePausedItem(key: string, session: PausedSession): void {
    setItems((prev) => prev.map((candidate) => (
      candidate.key === key
        ? {
            ...candidate,
            status: session.status ?? 'paused',
            startDate: session.lastActivity ?? candidate.startDate,
          }
        : candidate
    )));
  }
}

function isPausedSession(session: PausedSession | null | undefined): session is PausedSession {
  return session?.status === 'paused';
}

async function fetchBackendNextUp(): Promise<NextUpItem[]> {
  const response = await fetch(`${BACKEND_BASE_URL}/api/next-up`);
  if (!response.ok) throw new Error(`Failed to load next-up list (${response.status})`);

  const payload = (await response.json()) as BackendNextUpResponse;
  return Array.isArray(payload.nextUp) ? payload.nextUp : [];
}
