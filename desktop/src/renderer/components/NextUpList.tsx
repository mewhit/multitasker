import React, { useEffect, useMemo, useState } from 'react';
import { useNextUpList, type NextUpItem } from '../hooks/useNextUpList';
import { useAnnoyingNotifications } from '../hooks/useAnnoyingNotifications';

type MenuState = { visible: boolean; key: string; x: number; y: number };

function formatTime(value: number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatCalendarWhen(value: number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const dateLabel = date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const timeLabel = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${dateLabel} ${timeLabel}`;
}

function normalizeStatus(status?: NextUpItem['status']): NonNullable<NextUpItem['status']> {
  if (
    status === 'starting' ||
    status === 'running' ||
    status === 'needs_attention' ||
    status === 'paused' ||
    status === 'error' ||
    status === 'stopped' ||
    status === 'detached'
  ) {
    return status;
  }
  return 'waiting';
}

function statusLabel(status: NonNullable<NextUpItem['status']>): string {
  if (status === 'starting') return 'STARTING';
  if (status === 'running') return 'RUNNING';
  if (status === 'needs_attention') return 'NEEDS INPUT';
  if (status === 'paused') return 'PAUSED';
  if (status === 'error') return 'ERROR';
  if (status === 'stopped') return 'STOPPED';
  if (status === 'detached') return 'DETACHED';
  return 'WAITING';
}

function canPauseSession(item: NextUpItem): boolean {
  if (item.source !== 'session') return false;
  const status = normalizeStatus(item.status);
  return status !== 'paused' && status !== 'error' && status !== 'stopped' && status !== 'detached';
}

function channelLabel(name: string): string {
  const stripped = name.replace(/^Slack\s*-\s*/i, '').trim();
  return stripped || 'Slack';
}

function cardClassName(item: NextUpItem): string {
  if (item.source === 'slack') return 'react-next-up-card slack-card';
  if (item.source === 'manual-task') return 'react-next-up-card manual-task-card';
  if (item.source === 'google-calendar') return 'react-next-up-card calendar-card';
  return 'react-next-up-card session-card';
}

function clickLegacyNextUpCard(key: string): void {
  const legacyCard = document.querySelector<HTMLElement>(`#session-list > .next-up-card[data-next-up-key="${key}"]`);
  if (!legacyCard) return;
  legacyCard.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
}

function renderItemBody(item: NextUpItem): React.ReactNode {
  if (item.source === 'slack') {
    return (
      <>
        <div className="slack-card-top">
          <span className="slack-channel">{channelLabel(item.name)}</span>
          <span className="slack-time">{formatTime(item.startDate)}</span>
        </div>
        {item.description ? <div className="slack-text">{item.description}</div> : null}
      </>
    );
  }

  if (item.source === 'manual-task') {
    return (
      <>
        <div className="manual-task-top">
          <span className="manual-task-label">Manual task</span>
          <span className="manual-task-time">{formatTime(item.startDate)}</span>
        </div>
        <div className="manual-task-text">{item.name}</div>
      </>
    );
  }

  if (item.source === 'google-calendar') {
    return (
      <>
        <div className="calendar-card-top">
          <span className="calendar-label">Calendar</span>
          <span className="calendar-time">{formatCalendarWhen(item.startDate)}</span>
        </div>
        <div className="calendar-title">{item.name || '(no title)'}</div>
        {item.description ? <div className="calendar-location">{item.description}</div> : null}
      </>
    );
  }

  const status = normalizeStatus(item.status);
  const location = item.description || '';
  const shortLocation = location.length > 32 ? `...${location.slice(-30)}` : location;
  return (
    <>
      <div className="session-card-top">
        <span className={`status-dot ${status}`} />
        <span className="session-name">{item.name}</span>
        <span className={`status-badge ${status}`}>{statusLabel(status)}</span>
        <span className="kind-badge terminal">TASK</span>
      </div>
      <div className="session-cwd" title={location}>{shortLocation}</div>
    </>
  );
}

export function NextUpList() {
  const { items, loading, error, markDone, moveItem, pauseItem, resumeItem } = useNextUpList();
  useAnnoyingNotifications(items);
  const [menu, setMenu] = useState<MenuState>({ visible: false, key: '', x: 0, y: 0 });
  const [selectedKey, setSelectedKey] = useState('');
  const menuTarget = useMemo(() => items.find((item) => item.key === menu.key) ?? null, [items, menu.key]);
  const visibleCount = !loading && !error ? items.length : 0;

  useEffect(() => {
    const closeMenu = (): void => setMenu((prev) => ({ ...prev, visible: false }));
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeMenu();
    };

    document.addEventListener('click', closeMenu);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('click', closeMenu);
      document.removeEventListener('keydown', onEscape);
    };
  }, []);

  useEffect(() => {
    const counter = document.getElementById('session-count');
    if (!counter) return;
    if (visibleCount > 0) {
      counter.textContent = String(visibleCount);
      counter.style.display = '';
      return;
    }
    counter.textContent = '';
    counter.style.display = 'none';
  }, [visibleCount]);

  const openContextMenu = (event: React.MouseEvent, key: string): void => {
    event.preventDefault();
    event.stopPropagation();
    setSelectedKey(key);
    const menuWidth = 180;
    const menuHeight = 180;
    const x = Math.min(event.clientX, window.innerWidth - menuWidth - 8);
    const y = Math.min(event.clientY, window.innerHeight - menuHeight - 8);
    setMenu({ visible: true, key, x: Math.max(8, x), y: Math.max(8, y) });
  };

  const openItem = async (item: NextUpItem): Promise<void> => {
    if (item.source === 'session') {
      clickLegacyNextUpCard(item.key);
      return;
    }
    if (item.source === 'slack') {
      const openSlackNotification = window.electronAPI.openSlackNotification;
      if (typeof openSlackNotification === 'function') {
        void openSlackNotification(item.id).catch((error: unknown) => {
          console.error('Failed to open Slack notification:', error);
        });
      }
      if (window.showSlackHistory) {
        window.showSlackHistory(item.id);
      } else {
        window.dispatchEvent(new CustomEvent('multitasker:show-slack-history', { detail: { id: item.id } }));
      }
      return;
    }
    if (item.source === 'google-calendar') {
      await window.electronAPI.openGoogleCalendarEvent?.(item.id);
    }
  };

  const runMenuAction = (action: () => void): void => {
    setMenu((prev) => ({ ...prev, visible: false, key: '' }));
    action();
  };

  if (loading) return <div className="next-up-react-loading">Loading next-up items...</div>;
  if (error) return <div className="next-up-react-error">{error}</div>;
  if (items.length === 0) return <div className="next-up-react-empty">Nothing to do right now.</div>;

  return (
    <div className="next-up-react-list">
      {items.map((item) => (
        <div
          key={item.key}
          className={`${cardClassName(item)}${item.key === selectedKey ? ' selected' : ''}`}
          data-next-up-key={item.key}
          onContextMenu={(event) => openContextMenu(event, item.key)}
          onClick={() => {
            setSelectedKey(item.key);
            void openItem(item);
          }}
        >
          {renderItemBody(item)}
        </div>
      ))}

      {menu.visible && menuTarget ? (
        <div
          className="context-menu next-up-react-menu"
          style={{ top: `${menu.y}px`, left: `${menu.x}px`, display: 'block' }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            className="context-menu-item"
            onClick={() => {
              runMenuAction(() => { void markDone(menu.key); });
            }}
          >
            Done
          </button>
          {menuTarget.source === 'session' ? (
            <button
              className="context-menu-item"
              onClick={() => {
                runMenuAction(() => {
                  if (menuTarget.status === 'paused') void resumeItem(menuTarget);
                  else if (canPauseSession(menuTarget)) void pauseItem(menuTarget);
                });
              }}
            >
              {normalizeStatus(menuTarget.status) === 'paused' ? 'Resume' : 'Pause'}
            </button>
          ) : null}
          <button
            className="context-menu-item"
            onClick={() => {
              runMenuAction(() => moveItem(menu.key, 'up'));
            }}
          >
            Move up
          </button>
          <button
            className="context-menu-item"
            onClick={() => {
              runMenuAction(() => moveItem(menu.key, 'down'));
            }}
          >
            Move down
          </button>
        </div>
      ) : null}
    </div>
  );
}
