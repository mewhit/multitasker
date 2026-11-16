import { useEffect } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { NextUpList } from "./components/NextUpList";

declare global {
  interface Window {
    electronAPI: any;
    __MULTITASKER_RENDERER_INITIALIZED__?: boolean;
    __MULTITASKER_DONE_FALLBACK_CLEANUP__?: () => void;
    __MULTITASKER_NEXT_UP_SUBSCRIBED__?: boolean;
    FitAddon?: { FitAddon: typeof FitAddon };
    WebglAddon?: { WebglAddon: typeof WebglAddon };
    Unicode11Addon?: { Unicode11Addon: typeof Unicode11Addon };
  }
}

/**
 * NEW REACT-BASED APP COMPONENT
 * This version uses React components for the next-up list instead of legacy scripts.
 * To use this, replace the old App.tsx with this file.
 */
export function App() {
  useEffect(() => {
    if (window.__MULTITASKER_RENDERER_INITIALIZED__) return;
    window.__MULTITASKER_RENDERER_INITIALIZED__ = true;
    window.FitAddon = { FitAddon };
    window.WebglAddon = { WebglAddon };
    window.Unicode11Addon = { Unicode11Addon };

    console.log("[App] React-based renderer initialized (legacy scripts removed)");
  }, []);

  return <NextUpList />;
}
