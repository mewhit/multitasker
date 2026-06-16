import { useEffect } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { legacyMarkup } from './legacyMarkup';
import { legacyScript } from './legacyScript';

declare global {
  interface Window {
    electronAPI: any;
    __MULTITASKER_RENDERER_INITIALIZED__?: boolean;
    __MULTITASKER_DONE_FALLBACK_CLEANUP__?: () => void;
    FitAddon?: { FitAddon: typeof FitAddon };
    WebglAddon?: { WebglAddon: typeof WebglAddon };
    Unicode11Addon?: { Unicode11Addon: typeof Unicode11Addon };
  }
}

export function App() {
  useEffect(() => {
    if (window.__MULTITASKER_RENDERER_INITIALIZED__) return reinstallNextUpDoneFallback();
    window.__MULTITASKER_RENDERER_INITIALIZED__ = true;
    window.FitAddon = { FitAddon };
    window.WebglAddon = { WebglAddon };
    window.Unicode11Addon = { Unicode11Addon };

    const runLegacyRenderer = new Function('Terminal', legacyScript);
    runLegacyRenderer(Terminal);

    return reinstallNextUpDoneFallback();
  }, []);

  return <div style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: legacyMarkup }} />;
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
    window.setTimeout(() => {
      const visibleCard = getVisibleNextUpCard(key, card);
      if (!visibleCard) return;
      void removeNextUpItem(key).catch((error: unknown) => {
        console.error(error);
      });
      visibleCard.remove();
    }, 0);
  };

  document.addEventListener('contextmenu', rememberContextCard, true);
  document.addEventListener('click', handleDoneClick, true);
  return () => {
    document.removeEventListener('contextmenu', rememberContextCard, true);
    document.removeEventListener('click', handleDoneClick, true);
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
