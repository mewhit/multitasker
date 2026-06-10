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
    FitAddon?: { FitAddon: typeof FitAddon };
    WebglAddon?: { WebglAddon: typeof WebglAddon };
    Unicode11Addon?: { Unicode11Addon: typeof Unicode11Addon };
  }
}

export function App() {
  useEffect(() => {
    if (window.__MULTITASKER_RENDERER_INITIALIZED__) return;
    window.__MULTITASKER_RENDERER_INITIALIZED__ = true;
    window.FitAddon = { FitAddon };
    window.WebglAddon = { WebglAddon };
    window.Unicode11Addon = { Unicode11Addon };

    const runLegacyRenderer = new Function('Terminal', legacyScript);
    runLegacyRenderer(Terminal);
  }, []);

  return <div style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: legacyMarkup }} />;
}
