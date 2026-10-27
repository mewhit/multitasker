import { type FormEvent, type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SlackConversationHistory, SlackHistoryMessage } from '../../preload/preload';

interface ShowSlackHistoryDetail {
  id?: string;
}

interface RewriteMessage {
  role: 'user' | 'assistant';
  text: string;
}

interface RewriteCommand {
  instruction: string;
  text: string;
}

const BACKEND_BASE_URL = 'http://127.0.0.1:39017';

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
  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState('');
  const [sending, setSending] = useState(false);
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [rewriteMessages, setRewriteMessages] = useState<RewriteMessage[]>([]);
  const [rewriteInput, setRewriteInput] = useState('');
  const [rewriteLoading, setRewriteLoading] = useState(false);
  const [rewriteError, setRewriteError] = useState('');
  const [aiInstalled, setAiInstalled] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const refresh = (): void => {
      void window.electronAPI.getInstalledPlugins()
        .then((installedPlugins: string[]) => setAiInstalled(installedPlugins.includes('ai')))
        .catch(() => setAiInstalled(false));
    };
    const pluginsChanged = (event: Event): void => {
      const installedPlugins = (event as CustomEvent<{ installedPlugins?: string[] }>).detail?.installedPlugins;
      if (Array.isArray(installedPlugins)) setAiInstalled(installedPlugins.includes('ai'));
      else refresh();
    };
    refresh();
    window.addEventListener('multitasker:plugins-changed', pluginsChanged);
    return () => window.removeEventListener('multitasker:plugins-changed', pluginsChanged);
  }, []);

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
      setDraft('');
      setSendError('');
      window.setTimeout(() => composerRef.current?.focus(), 0);
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

  const sendMessage = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    const rewriteCommand = parseRewriteCommand(text);
    if (rewriteCommand) {
      if (!aiInstalled) {
        setSendError('Install the AI plugin from Plugins before using /rewrite.');
        return;
      }
      setDraft('');
      setRewriteOpen(true);
      setRewriteMessages([]);
      setRewriteInput('');
      setRewriteError('');
      void requestRewrite(rewriteCommand, []);
      return;
    }
    setSending(true);
    setSendError('');
    try {
      const sentMessage = await window.electronAPI.sendSlackMessage(notificationId, text) as SlackHistoryMessage;
      setHistory((current) => current ? { ...current, messages: [...current.messages, sentMessage] } : current);
      setDraft('');
      const removed = await window.electronAPI.removeSlackNotification(notificationId) as boolean;
      if (!removed) setSendError('Message sent, but the Slack task could not be removed from Next Up.');
      window.setTimeout(() => {
        if (panelRef.current) panelRef.current.scrollTop = panelRef.current.scrollHeight;
        composerRef.current?.focus();
      }, 0);
    } catch (reason: unknown) {
      setSendError(errorMessage(reason));
    } finally {
      setSending(false);
    }
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || (!event.ctrlKey && !event.metaKey)) return;
    event.preventDefault();
    void sendMessage();
  };

  const requestRewrite = async (command: RewriteCommand, context: RewriteMessage[]): Promise<void> => {
    const userMessage: RewriteMessage = {
      role: 'user',
      text: command.text ? `${command.instruction}\n\nText:\n${command.text}` : command.instruction,
    };
    const pendingContext = [...context, userMessage];
    setRewriteMessages(pendingContext);
    setRewriteLoading(true);
    setRewriteError('');
    try {
      const response = await fetch(`${BACKEND_BASE_URL}/text`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instruction: command.instruction, text: command.text, context }),
      });
      const payload = await response.json() as { ok?: boolean; text?: string; error?: string };
      if (!response.ok || payload.ok !== true || typeof payload.text !== 'string') {
        throw new Error(payload.error || `Rewrite failed (HTTP ${response.status}).`);
      }
      setRewriteMessages([...pendingContext, { role: 'assistant', text: payload.text }]);
    } catch (reason: unknown) {
      setRewriteError(errorMessage(reason));
    } finally {
      setRewriteLoading(false);
    }
  };

  const improveRewrite = (): void => {
    const instruction = rewriteInput.trim();
    if (!instruction || rewriteLoading) return;
    const previousText = [...rewriteMessages].reverse().find(message => message.role === 'assistant')?.text ?? '';
    setRewriteInput('');
    void requestRewrite({ instruction, text: previousText }, rewriteMessages);
  };

  const useRewrite = (): void => {
    const result = [...rewriteMessages].reverse().find(message => message.role === 'assistant')?.text;
    if (!result) return;
    setDraft(result);
    setRewriteOpen(false);
    window.setTimeout(() => composerRef.current?.focus(), 0);
  };

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
      <form className="slack-history-composer" onSubmit={(event) => { void sendMessage(event); }}>
        <textarea
          ref={composerRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleComposerKeyDown}
          placeholder={history?.kind === 'thread' ? 'Reply in thread…' : 'Message this conversation…'}
          aria-label="Slack message"
          maxLength={40_000}
          rows={3}
          disabled={sending}
        />
        <div className="slack-history-composer-footer">
          <span className={sendError ? 'slack-history-send-error' : ''}>
            {sendError || (aiInstalled ? 'Ctrl+Enter to send · /rewrite instruction | text' : 'Ctrl+Enter to send · Install the AI plugin to enable /rewrite')}
          </span>
          <button className="btn primary" type="submit" disabled={!draft.trim() || sending}>
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>
      {rewriteOpen ? (
        <div className="modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !rewriteLoading) setRewriteOpen(false); }}>
          <div className="modal rewrite-modal" role="dialog" aria-modal="true" aria-labelledby="rewrite-modal-title">
            <div className="rewrite-modal-header">
              <div>
                <h2 id="rewrite-modal-title">Rewrite with AI</h2>
                <p>Ask for another pass, then place the result back in your Slack message.</p>
              </div>
              <button className="btn-xs" aria-label="Close" disabled={rewriteLoading} onClick={() => setRewriteOpen(false)}>x</button>
            </div>
            <div className="rewrite-chat" aria-live="polite">
              {rewriteMessages.map((message, index) => (
                <div className={`rewrite-message ${message.role}`} key={`${message.role}-${index}`}>
                  <strong>{message.role === 'user' ? 'You' : 'AI'}</strong>
                  <div>{message.text}</div>
                </div>
              ))}
              {rewriteLoading ? <div className="rewrite-thinking">Codex is rewriting…</div> : null}
            </div>
            {rewriteError ? <div className="rewrite-error" role="alert">{rewriteError}</div> : null}
            <div className="rewrite-followup">
              <textarea
                value={rewriteInput}
                onChange={(event) => setRewriteInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault();
                    improveRewrite();
                  }
                }}
                placeholder="Improve it again, e.g. make it shorter…"
                rows={2}
                disabled={rewriteLoading}
              />
              <div className="rewrite-actions">
                <button className="btn" disabled={!rewriteInput.trim() || rewriteLoading} onClick={improveRewrite}>Improve again</button>
                <button className="btn btn-primary" disabled={rewriteLoading || !rewriteMessages.some(message => message.role === 'assistant')} onClick={useRewrite}>Use in Slack</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function parseRewriteCommand(value: string): RewriteCommand | null {
  const trimmed = value.trim();
  if (trimmed !== '/rewrite' && !trimmed.startsWith('/rewrite ')) return null;
  const argumentsText = trimmed.slice('/rewrite'.length).trim();
  if (!argumentsText) return { instruction: 'Improve this text', text: '' };

  const quoted = argumentsText.match(/^(["'])(.*?)\1(?:\s+(["'])(.*?)\3)?$/s);
  if (quoted) return { instruction: quoted[2]?.trim() || 'Improve this text', text: quoted[4]?.trim() || '' };

  const separatorIndex = argumentsText.indexOf('|');
  if (separatorIndex >= 0) {
    const instruction = argumentsText.slice(0, separatorIndex).trim();
    const text = argumentsText.slice(separatorIndex + 1).trim();
    return { instruction: instruction || 'Improve this text', text };
  }
  return { instruction: argumentsText, text: '' };
}
