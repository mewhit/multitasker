import { useEffect } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { createRoot, type Root } from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { legacyMarkup } from './legacyMarkup';
import { legacyScript } from './legacyScript';
import { NextUpList } from './components/NextUpList';
import { SlackHistoryPanel } from './components/SlackHistoryPanel';
import { PluginMenu } from './components/PluginMenu';

declare global {
  interface Window {
    electronAPI: any;
    __MULTITASKER_RENDERER_INITIALIZED__?: boolean;
    __MULTITASKER_TERMINAL_INPUT_SOUND_CLEANUP__?: () => void;
    __MULTITASKER_DONE_FALLBACK_CLEANUP__?: () => void;
    __MULTITASKER_CONTEXT_MENU_AUTO_CLOSE_CLEANUP__?: () => void;
    __MULTITASKER_NEXT_UP_SUBSCRIBED__?: boolean;
    __MULTITASKER_REACT_NEXT_UP_ROOT__?: Root;
    __MULTITASKER_SLACK_HISTORY_ROOT__?: Root;
    __MULTITASKER_SLACK_HISTORY_HOST__?: HTMLElement;
    __MULTITASKER_PLUGIN_MENU_ROOT__?: Root;
    __MULTITASKER_PLUGIN_MENU_HOST__?: HTMLElement;
    showSlackHistory?: (id: string) => void;
    FitAddon?: { FitAddon: typeof FitAddon };
    WebglAddon?: { WebglAddon: typeof WebglAddon };
    Unicode11Addon?: { Unicode11Addon: typeof Unicode11Addon };
    webkitAudioContext?: typeof AudioContext;
  }
}

interface TerminalClipboardPaste {
  text?: string;
}

interface TerminalNotificationSession {
  id?: string;
  status?: string;
}

const TERMINAL_INPUT_SOUND_COOLDOWN_MS = 1500;
const TERMINAL_INPUT_SOUND_DURATION_SECONDS = 0.14;
const TERMINAL_INPUT_ATTENTION_CLASS = 'terminal-input-attention';
const TERMINAL_INPUT_FLASH_CLASS = 'terminal-input-attention-flash';
let lastTerminalInputSoundAt = 0;
let terminalInputSoundWarningShown = false;

export function App() {
  useEffect(() => {
    const cleanupTerminalInputNotification = reinstallTerminalInputNotification();
    installSlackHistoryPanel();
    installPluginMenu();
    if (window.__MULTITASKER_RENDERER_INITIALIZED__) {
      const cleanupPostHooks = reinstallRendererPostHooks();
      return () => {
        cleanupTerminalInputNotification();
        cleanupPostHooks();
      };
    }
    window.__MULTITASKER_RENDERER_INITIALIZED__ = true;
    window.FitAddon = { FitAddon };
    window.WebglAddon = { WebglAddon };
    window.Unicode11Addon = { Unicode11Addon };

    const runLegacyRenderer = new Function('Terminal', legacyScript);
    runLegacyRenderer(TerminalWithRightClickCopy);
    hideLegacyGitHubReviewSettings();
    installReactNextUpList();

    const cleanupPostHooks = reinstallRendererPostHooks();
    return () => {
      cleanupTerminalInputNotification();
      cleanupPostHooks();
    };
  }, []);

  return <div style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: legacyMarkup }} />;
}

function hideLegacyGitHubReviewSettings(): void {
  const legacyToggle = document.getElementById('settings-github-enabled');
  const section = legacyToggle?.closest<HTMLElement>('.settings-section');
  if (section) section.hidden = true;
}

function installPluginMenu(): void {
  const header = document.getElementById('header');
  const newSessionButton = document.getElementById('btn-new');
  if (!header || !newSessionButton) return;
  let host = document.getElementById('plugin-menu-root');
  if (!host) {
    host = document.createElement('div');
    host.id = 'plugin-menu-root';
    header.insertBefore(host, newSessionButton);
  }
  if (window.__MULTITASKER_PLUGIN_MENU_HOST__ !== host) {
    window.__MULTITASKER_PLUGIN_MENU_ROOT__?.unmount();
    window.__MULTITASKER_PLUGIN_MENU_ROOT__ = createRoot(host);
    window.__MULTITASKER_PLUGIN_MENU_HOST__ = host;
  }
  window.__MULTITASKER_PLUGIN_MENU_ROOT__.render(<PluginMenu />);
}

function installSlackHistoryPanel(): void {
  const detailBody = document.getElementById('detail-body');
  if (!detailBody) return;
  let host = document.getElementById('slack-history-root');
  if (!host) {
    host = document.createElement('div');
    host.id = 'slack-history-root';
    detailBody.appendChild(host);
  }
  if (window.__MULTITASKER_SLACK_HISTORY_HOST__ !== host) {
    window.__MULTITASKER_SLACK_HISTORY_ROOT__?.unmount();
    window.__MULTITASKER_SLACK_HISTORY_ROOT__ = createRoot(host);
    window.__MULTITASKER_SLACK_HISTORY_HOST__ = host;
  }
  window.__MULTITASKER_SLACK_HISTORY_ROOT__.render(<SlackHistoryPanel />);
}

function reinstallTerminalInputNotification(): () => void {
  window.__MULTITASKER_TERMINAL_INPUT_SOUND_CLEANUP__?.();
  const cleanup = installTerminalInputNotification();
  window.__MULTITASKER_TERMINAL_INPUT_SOUND_CLEANUP__ = cleanup;
  return cleanup;
}

function installTerminalInputNotification(): () => void {
  const sessionStatuses = new Map<string, string>();
  const domNeedsInput = new Map<string, boolean>();
  let active = true;
  let sessionsInitialized = false;
  let domInitialized = false;
  let attentionActive = false;
  let scanFrame = 0;

  const syncAttentionState = (): void => {
    const needsInput = sessionsInitialized
      ? [...sessionStatuses.values()].some((status) => status === 'needs_attention')
      : [...domNeedsInput.values()].some(Boolean);
    if (needsInput === attentionActive) return;
    attentionActive = needsInput;
    document.documentElement.classList.toggle(TERMINAL_INPUT_ATTENTION_CLASS, needsInput);
    window.electronAPI.setWindowInputAttention?.(needsInput);
    if (!needsInput) document.documentElement.classList.remove(TERMINAL_INPUT_FLASH_CLASS);
  };

  const applySessions = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    let shouldPlay = false;
    const seen = new Set<string>();

    for (const session of value) {
      if (!isTerminalNotificationSession(session)) continue;
      const id = session.id.trim();
      const status = normalizeNotificationStatus(session.status);
      seen.add(id);

      const previousStatus = sessionStatuses.get(id);
      if (
        sessionsInitialized &&
        previousStatus !== undefined &&
        previousStatus !== 'needs_attention' &&
        status === 'needs_attention'
      ) {
        shouldPlay = true;
      }
      sessionStatuses.set(id, status);
    }

    for (const id of [...sessionStatuses.keys()]) {
      if (!seen.has(id)) sessionStatuses.delete(id);
    }
    sessionsInitialized = true;
    syncAttentionState();
    if (shouldPlay) signalTerminalInputNeeded();
  };

  const scanDom = (): void => {
    scanFrame = 0;
    if (!active) return;

    const cards = document.querySelectorAll<HTMLElement>('[data-next-up-key^="session:"]');
    const seen = new Set<string>();
    let shouldPlay = false;

    cards.forEach((card) => {
      const key = card.dataset.nextUpKey;
      if (!key) return;
      const badge = card.querySelector<HTMLElement>('.status-badge');
      if (!badge) return;

      const needsInput = isNeedsInputBadge(badge);
      seen.add(key);
      const previousNeedsInput = domNeedsInput.get(key);
      if (domInitialized && previousNeedsInput === false && needsInput) {
        shouldPlay = true;
      }
      domNeedsInput.set(key, needsInput);
    });

    for (const key of [...domNeedsInput.keys()]) {
      if (!seen.has(key)) domNeedsInput.delete(key);
    }
    domInitialized = true;
    syncAttentionState();
    if (shouldPlay) signalTerminalInputNeeded();
  };

  const queueDomScan = (): void => {
    if (scanFrame || !active) return;
    scanFrame = window.requestAnimationFrame(scanDom);
  };

  const getSessions = window.electronAPI.getSessions;
  if (typeof getSessions === 'function') {
    void getSessions().then(applySessions).catch(reportTerminalInputSoundFailure);
  }
  window.electronAPI.onListUpdate?.((sessions: TerminalNotificationSession[]) => {
    if (!active) return;
    applySessions(sessions);
  });

  const observer = new MutationObserver(queueDomScan);
  const list = document.getElementById('session-list');
  if (list) {
    observer.observe(list, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
      characterData: true,
    });
    scanDom();
  }

  const cleanup = (): void => {
    active = false;
    observer.disconnect();
    if (scanFrame) window.cancelAnimationFrame(scanFrame);
    document.documentElement.classList.remove(TERMINAL_INPUT_ATTENTION_CLASS, TERMINAL_INPUT_FLASH_CLASS);
    window.electronAPI.setWindowInputAttention?.(false);
    if (window.__MULTITASKER_TERMINAL_INPUT_SOUND_CLEANUP__ === cleanup) {
      delete window.__MULTITASKER_TERMINAL_INPUT_SOUND_CLEANUP__;
    }
  };
  return cleanup;
}

function isTerminalNotificationSession(value: unknown): value is Required<TerminalNotificationSession> {
  if (typeof value !== 'object' || value === null) return false;
  const session = value as TerminalNotificationSession;
  return typeof session.id === 'string' && session.id.trim().length > 0 && typeof session.status === 'string';
}

function normalizeNotificationStatus(status: string | undefined): string {
  return typeof status === 'string' ? status.trim() : '';
}

function isNeedsInputBadge(badge: HTMLElement): boolean {
  return badge.classList.contains('needs_attention') || badge.textContent?.trim().toLowerCase() === 'needs input';
}

function signalTerminalInputNeeded(): void {
  const root = document.documentElement;
  root.classList.remove(TERMINAL_INPUT_FLASH_CLASS);
  void root.offsetWidth;
  root.classList.add(TERMINAL_INPUT_FLASH_CLASS);
  window.electronAPI.requestWindowAttention?.();
  playTerminalInputNeededSound();
}

function playTerminalInputNeededSound(): void {
  const now = Date.now();
  if (now - lastTerminalInputSoundAt < TERMINAL_INPUT_SOUND_COOLDOWN_MS) return;
  lastTerminalInputSoundAt = now;
  void playTerminalInputNeededSoundAsync().catch(reportTerminalInputSoundFailure);
}

async function playTerminalInputNeededSoundAsync(): Promise<void> {
  const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext;
  if (!AudioContextCtor) throw new Error('AudioContext is not available');

  const audioContext = new AudioContextCtor();
  try {
    if (audioContext.state === 'suspended') await audioContext.resume();

    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const startAt = audioContext.currentTime;
    const stopAt = startAt + TERMINAL_INPUT_SOUND_DURATION_SECONDS;

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, startAt);
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(0.06, startAt + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, stopAt);

    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start(startAt);
    oscillator.stop(stopAt);

    await new Promise<void>((resolve) => {
      oscillator.onended = () => resolve();
    });
  } finally {
    await audioContext.close();
  }
}

function reportTerminalInputSoundFailure(error: unknown): void {
  if (terminalInputSoundWarningShown) return;
  terminalInputSoundWarningShown = true;
  console.warn('[shell-renderer] Terminal input notification sound failed:', error);
}

class TerminalWithRightClickCopy extends Terminal {
  private rightClickCopyCleanup?: () => void;

  attachCustomKeyEventHandler(customKeyEventHandler: (event: KeyboardEvent) => boolean): void {
    super.attachCustomKeyEventHandler((event) => {
      if (isTerminalPasteShortcut(event)) {
        event.preventDefault();
        void this.pasteClipboardContents();
        return false;
      }

      return customKeyEventHandler(event);
    });
  }

  open(parent: HTMLElement): void {
    super.open(parent);
    this.rightClickCopyCleanup?.();
    this.rightClickCopyCleanup = installRightClickCopy(this, parent);
  }

  dispose(): void {
    this.rightClickCopyCleanup?.();
    this.rightClickCopyCleanup = undefined;
    super.dispose();
  }

  private async pasteClipboardContents(): Promise<void> {
    try {
      const text = await readTerminalClipboardText();
      if (text) this.paste(text);
    } catch (error: unknown) {
      console.error('[shell-renderer] Paste failed:', error);
    }
  }
}

function isTerminalPasteShortcut(event: KeyboardEvent): boolean {
  const mod = event.ctrlKey || event.metaKey;
  return event.type === 'keydown' && mod && !event.altKey && (event.key === 'v' || event.key === 'V');
}

async function readTerminalClipboardText(): Promise<string> {
  const readTerminalClipboard = window.electronAPI?.readTerminalClipboard;
  if (typeof readTerminalClipboard === 'function') {
    const result = (await readTerminalClipboard()) as TerminalClipboardPaste | null | undefined;
    return typeof result?.text === 'string' ? result.text : '';
  }

  return navigator.clipboard.readText();
}

function installRightClickCopy(term: Terminal, parent: HTMLElement): () => void {
  let rightClickSelection = '';
  let copiedOnMouseDown = false;

  const copySelection = (selection: string): void => {
    void navigator.clipboard.writeText(selection).catch((error: unknown) => {
      console.error('[shell-renderer] Copy failed:', error);
    });
  };

  const captureRightClickSelection = (event: MouseEvent): void => {
    if (event.button !== 2) return;
    rightClickSelection = term.getSelection();
    copiedOnMouseDown = false;
    if (!rightClickSelection) return;

    event.preventDefault();
    event.stopPropagation();
    copiedOnMouseDown = true;
    copySelection(rightClickSelection);
  };

  const copySelectionOnContextMenu = (event: MouseEvent): void => {
    const selection = term.getSelection() || rightClickSelection;
    rightClickSelection = '';
    const alreadyCopied = copiedOnMouseDown;
    copiedOnMouseDown = false;
    if (!selection) return;

    event.preventDefault();
    event.stopPropagation();
    if (!alreadyCopied) copySelection(selection);
  };

  parent.addEventListener('mousedown', captureRightClickSelection, true);
  parent.addEventListener('contextmenu', copySelectionOnContextMenu, true);

  return () => {
    parent.removeEventListener('mousedown', captureRightClickSelection, true);
    parent.removeEventListener('contextmenu', copySelectionOnContextMenu, true);
  };
}

function installReactNextUpList(): void {
  const container = document.getElementById('session-list');
  if (!container) return;

  container.dataset.reactNextUp = 'true';
  let host = document.getElementById('react-next-up-root');
  if (!host) {
    host = document.createElement('div');
    host.id = 'react-next-up-root';
    host.className = 'react-next-up-root';
    container.appendChild(host);
  }

  if (!window.__MULTITASKER_REACT_NEXT_UP_ROOT__) {
    window.__MULTITASKER_REACT_NEXT_UP_ROOT__ = createRoot(host);
  }

  window.__MULTITASKER_REACT_NEXT_UP_ROOT__.render(<NextUpList />);
}

function reinstallRendererPostHooks(): () => void {
  const cleanups = [
    reinstallNextUpDoneFallback(),
    reinstallContextMenuAutoClose(),
  ];
  return () => {
    cleanups.forEach((cleanup) => cleanup());
  };
}

function reinstallContextMenuAutoClose(): () => void {
  window.__MULTITASKER_CONTEXT_MENU_AUTO_CLOSE_CLEANUP__?.();
  const cleanup = installContextMenuAutoClose();
  window.__MULTITASKER_CONTEXT_MENU_AUTO_CLOSE_CLEANUP__ = cleanup;
  return cleanup;
}

function installContextMenuAutoClose(): () => void {
  const closeContextMenuAfterItemClick = (event: MouseEvent): void => {
    if (!(event.target instanceof Element)) return;
    const item = event.target.closest('.context-menu-item');
    if (!(item instanceof HTMLElement)) return;
    if (item instanceof HTMLButtonElement && item.disabled) return;

    const menu = item.closest('.context-menu');
    if (!(menu instanceof HTMLElement)) return;
    window.setTimeout(() => {
      menu.classList.add('hidden');
    }, 0);
  };

  document.addEventListener('click', closeContextMenuAfterItemClick, true);
  return () => {
    document.removeEventListener('click', closeContextMenuAfterItemClick, true);
  };
}

function reinstallNextUpDoneFallback(): () => void {
  window.__MULTITASKER_DONE_FALLBACK_CLEANUP__?.();
  const cleanup = installNextUpDoneFallback();
  window.__MULTITASKER_DONE_FALLBACK_CLEANUP__ = cleanup;
  return cleanup;
}

function installNextUpDoneFallback(): () => void {
  let contextKey = '';
  let contextCard: HTMLElement | null = null;

  void window.electronAPI.getNextUp?.().then(applyServerNextUpOrder).catch((error: unknown) => {
    console.error(error);
  });
  if (!window.__MULTITASKER_NEXT_UP_SUBSCRIBED__) {
    window.__MULTITASKER_NEXT_UP_SUBSCRIBED__ = true;
    window.electronAPI.onNextUpListUpdate?.(applyServerNextUpOrder);
  }

  const rememberContextCard = (event: MouseEvent): void => {
    if (!(event.target instanceof Element)) return;
    const card = event.target.closest('.next-up-card');
    if (!(card instanceof HTMLElement)) return;
    contextKey = card.dataset.nextUpKey || '';
    contextCard = card;
  };

  const handleDoneClick = (event: MouseEvent): void => {
    if (!(event.target instanceof Element)) return;
    if (!event.target.closest('#btn-next-up-done')) return;
    const key = contextKey;
    const card = contextCard;
    if (key.startsWith('calendar:')) {
      void window.electronAPI.markNextUpDone?.(key).catch((error: unknown) => {
        console.error(error);
      });
    }
    window.setTimeout(() => {
      const visibleCard = getVisibleNextUpCard(key, card);
      if (!visibleCard) return;
      void removeNextUpItem(key).catch((error: unknown) => {
        console.error(error);
      });
      visibleCard.remove();
      persistVisibleNextUpOrder();
    }, 0);
  };

  const handleMoveClick = (event: MouseEvent): void => {
    if (!(event.target instanceof Element)) return;
    if (!event.target.closest('#btn-next-up-move-up') && !event.target.closest('#btn-next-up-move-down')) return;
    window.setTimeout(persistVisibleNextUpOrder, 0);
  };

  const handleDrop = (event: DragEvent): void => {
    if (!(event.target instanceof Element)) return;
    if (!event.target.closest('.next-up-card')) return;
    window.setTimeout(persistVisibleNextUpOrder, 0);
  };

  document.addEventListener('contextmenu', rememberContextCard, true);
  document.addEventListener('click', handleDoneClick, true);
  document.addEventListener('click', handleMoveClick, true);
  document.addEventListener('drop', handleDrop, true);
  return () => {
    document.removeEventListener('contextmenu', rememberContextCard, true);
    document.removeEventListener('click', handleDoneClick, true);
    document.removeEventListener('click', handleMoveClick, true);
    document.removeEventListener('drop', handleDrop, true);
  };
}

function getVisibleNextUpCard(key: string, rememberedCard: HTMLElement | null): HTMLElement | null {
  if (!key) return null;
  if (rememberedCard?.isConnected && rememberedCard.dataset.nextUpKey === key) return rememberedCard;
  return [...document.querySelectorAll<HTMLElement>('.next-up-card')]
    .find((card) => card.dataset.nextUpKey === key) ?? null;
}

async function removeNextUpItem(key: string): Promise<void> {
  const api = window.electronAPI;
  if (key.startsWith('slack:')) {
    await api.removeSlackNotification?.(key.slice('slack:'.length));
  } else if (key.startsWith('manual:')) {
    await api.removeManualTask?.(key.slice('manual:'.length));
  } else if (key.startsWith('session:')) {
    await api.removeSession?.(key.slice('session:'.length));
  }
}

function persistVisibleNextUpOrder(): void {
  const keys = [...document.querySelectorAll<HTMLElement>('.next-up-card')]
    .map((card) => card.dataset.nextUpKey || '')
    .filter(Boolean);
  if (keys.length === 0) return;
  void window.electronAPI.setNextUpOrder?.(keys).catch((error: unknown) => {
    console.error(error);
  });
}

function applyServerNextUpOrder(items: Array<{ key?: string }>): void {
  const container = document.getElementById('session-list');
  if (!container || !Array.isArray(items)) return;
  const cardsByKey = new Map(
    [...container.querySelectorAll<HTMLElement>('.next-up-card')]
      .map((card) => [card.dataset.nextUpKey || '', card] as const)
      .filter(([key]) => key)
  );
  for (const item of items) {
    const card = item.key ? cardsByKey.get(item.key) : undefined;
    if (card) container.appendChild(card);
  }
}
