import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SlackConversationHistory } from '../../preload/preload';

interface ShowSlackHistoryDetail {
  id?: string;
}

function setLegacyDetailVisibility(showSlack: boolean): void {
  document.getElementById('no-session-msg')?.classList.toggle('hidden', showSlack);
  document.getElementById('session-summary')?.classList.add('hidden');
  document.getElementById('shell-terminal')?.classList.add('hidden');
  for (const id of ['detail-session-id', 'detail-cwd', 'btn-rename-active', 'btn-review-active', 'btn-vscode-active', 'btn-remove-active']) {
    const element = document.getElementById(id);
    if (showSlack && element instanceof HTMLElement) element.style.display = 'none';
  }
}

function formatMessageTime(value: number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function SlackHistoryPanel() {
  const [notificationId, setNotificationId] = useState('');
  const [history, setHistory] = useState<SlackConversationHistory | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const showHistoryById = (id: string): void => {
      if (typeof id !== 'string' || !id.trim()) return;
      setLegacyDetailVisibility(true);
      const title = document.getElementById('detail-title');
      if (title) {
        title.textContent = 'Slack conversation';
        title.style.color = '';
      }
      setNotificationId(id.trim());
    };
    const showHistory = (event: Event): void => {
      const id = (event as CustomEvent<ShowSlackHistoryDetail>).detail?.id;
      if (typeof id === 'string') showHistoryById(id);
    };
    const hideForOtherItem = (event: MouseEvent): void => {
      if (!(event.target instanceof Element)) return;
      const card = event.target.closest<HTMLElement>('[data-next-up-key]');
      if (!card || card.dataset.nextUpKey?.startsWith('slack:')) return;
      setLegacyDetailVisibility(false);
      const title = document.getElementById('detail-title');
      if (title) {
        title.textContent = 'No session selected';
        title.style.color = 'var(--text-dim)';
      }
      setNotificationId('');
      setHistory(null);
    };
    window.showSlackHistory = showHistoryById;
    window.addEventListener('multitasker:show-slack-history', showHistory);
    document.addEventListener('click', hideForOtherItem, true);
    return () => {
      if (window.showSlackHistory === showHistoryById) delete window.showSlackHistory;
      window.removeEventListener('multitasker:show-slack-history', showHistory);
      document.removeEventListener('click', hideForOtherItem, true);
    };
  }, []);

  useEffect(() => {
    if (!notificationId) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setHistory(null);
    const getHistory = window.electronAPI?.getSlackConversationHistory;
    if (typeof getHistory !== 'function') {
      setLoading(false);
      setError('Slack history is unavailable until the desktop app is restarted.');
      return;
    }
    void getHistory(notificationId)
      .then((value: SlackConversationHistory) => {
        if (cancelled) return;
        setHistory(value);
        const title = document.getElementById('detail-title');
        if (title) title.textContent = value.title;
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(errorMessage(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [notificationId]);

  useEffect(() => {
    if (!history) return;
    panelRef.current?.querySelector('.slack-history-message.selected')?.scrollIntoView({ block: 'center' });
  }, [history]);

  if (!notificationId) return null;
  return (
    <div className="slack-history-panel" ref={panelRef}>
      <div className="slack-history-toolbar">
        <span>{history?.kind === 'thread' ? 'Thread history' : 'Channel history'}</span>
        <button className="btn" onClick={() => { void window.electronAPI.openSlackNotification(notificationId); }}>
          Open in Slack
        </button>
      </div>
      {loading ? <div className="slack-history-state">Loading Slack history...</div> : null}
      {error ? <div className="slack-history-state error">{error}</div> : null}
      {history && history.messages.length === 0 ? <div className="slack-history-state">No messages were returned.</div> : null}
      {history?.messages.map((message) => (
        <article key={message.ts} className={`slack-history-message${message.selected ? ' selected' : ''}`}>
          <div className="slack-history-message-header">
            <strong>{message.userName}</strong>
            <time>{formatMessageTime(message.sentAt)}</time>
          </div>
          <div className="slack-history-text">{message.text}</div>
        </article>
      ))}
    </div>
  );
}
