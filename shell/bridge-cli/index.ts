#!/usr/bin/env node
/**
 * multitasker-shell — stdio ↔ gateway WebSocket bridge.
 *
 * Designed to be used as a VS Code terminal profile so that VS Code's
 * integrated terminal attaches to a multitasker PTY (with tracking,
 * scrollback, agent status detection, etc.) instead of spawning its own
 * detached shell.
 *
 * VS Code settings.json example:
 *   "terminal.integrated.profiles.windows": {
 *     "Multitasker": { "path": "node", "args": ["C:\\dev\\multitasker\\dist\\shell\\bridge-cli\\index.js"] }
 *   },
 *   "terminal.integrated.defaultProfile.windows": "Multitasker"
 *
 * Env overrides:
 *   MULTITASKER_SHELL_URL    ws URL (default ws://127.0.0.1:4321)
 *   MULTITASKER_SHELL_TOKEN  auth token if gateway requires one
 *   MULTITASKER_SESSION_ID   if set, attach to existing session instead of creating one
 *   MULTITASKER_SHELL_KIND   'pwsh' | 'bash' | 'cmd' (passed as `shell` to create_session)
 *
 * Note: backspace key translation (BS 0x08 ↔ DEL 0x7F) is now handled by
 * the gateway based on the session's shell kind. bridge-cli forwards bytes
 * unchanged.
 */
import WebSocket from "ws";
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { ClientMetadata } from "../core/protocol";

// Diagnostic: when MULTITASKER_DEBUG_STDIN is set to a truthy value, dump
// every raw stdin chunk (hex + printable form) to a per-PID log file BEFORE
// any stripping. Useful to track down phantom key sequences injected into
// the VS Code integrated terminal.
const DEBUG_STDIN_PATH: string | null = (() => {
  const flag = process.env["MULTITASKER_DEBUG_STDIN"]?.trim();
  if (!flag || flag === "0" || flag.toLowerCase() === "false") return null;
  try {
    const dir = resolvePath(process.cwd(), ".tmp", "bridge-cli");
    mkdirSync(dir, { recursive: true });
    return resolvePath(dir, `stdin-${process.pid}.log`);
  } catch {
    return null;
  }
})();

function debugLogStdin(chunk: Buffer): void {
  if (!DEBUG_STDIN_PATH) return;
  const ts = new Date().toISOString();
  const hex = chunk.toString("hex");
  const printable = chunk
    .toString("utf8")
    .replace(/[\x00-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
  try {
    appendFileSync(
      DEBUG_STDIN_PATH,
      `${ts} len=${chunk.length} hex=${hex} text="${printable}"\n`,
    );
  } catch {
    // ignore — diagnostic only
  }
}

const URL = process.env["MULTITASKER_SHELL_URL"]?.trim() || "ws://127.0.0.1:4321";
const TOKEN = process.env["MULTITASKER_SHELL_TOKEN"]?.trim() || "";
const ATTACH_SESSION_ID = process.env["MULTITASKER_SESSION_ID"]?.trim() || "";
const PREFERRED_SHELL = process.env["MULTITASKER_SHELL_KIND"]?.trim() || "";

function detectClientMetadata(): ClientMetadata | undefined {
  const termProgram = process.env["TERM_PROGRAM"]?.trim() || "";
  // VS Code (and forks like Cursor) set TERM_PROGRAM=vscode and a handful of
  // VSCODE_* env vars in their integrated terminals. We forward what we can
  // so the desktop UI can later focus the originating VS Code window via the
  // `code` CLI (which talks to that specific instance via VSCODE_IPC_HOOK_CLI).
  if (termProgram.toLowerCase() !== "vscode") return undefined;
  const meta: ClientMetadata = { kind: "vscode", termProgram };
  const ipcHook = process.env["VSCODE_IPC_HOOK_CLI"]?.trim();
  if (ipcHook) meta.ipcHook = ipcHook;
  const rawPid = process.env["VSCODE_PID"]?.trim();
  const pid = rawPid ? Number(rawPid) : NaN;
  if (Number.isFinite(pid) && pid > 0) meta.pid = pid;
  const version = process.env["TERM_PROGRAM_VERSION"]?.trim();
  if (version) meta.version = version;
  const cwd = process.cwd();
  if (cwd) meta.workspace = cwd;
  return meta;
}

const CLIENT_METADATA = detectClientMetadata();

const stdin = process.stdin;
const stdout = process.stdout;
const stderr = process.stderr;

function getSize(): { cols: number; rows: number } {
  const cols = (stdout as NodeJS.WriteStream).columns || 120;
  const rows = (stdout as NodeJS.WriteStream).rows || 30;
  return { cols, rows };
}

function logErr(msg: string): void {
  stderr.write(`[multitasker-shell] ${msg}\r\n`);
}

let sessionId: string | null = null;
let exited = false;
let createSent = false;
let stdinSetup = false;
let resizeSetup = false;

const ws = new WebSocket(URL);

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "hello", ...(TOKEN ? { token: TOKEN } : {}) }));
});

function sendCreateOrAttach(): void {
  if (createSent || sessionId) return;
  createSent = true;
  const { cols, rows } = getSize();
  if (ATTACH_SESSION_ID) {
    ws.send(JSON.stringify({ type: "attach", sessionId: ATTACH_SESSION_ID }));
  } else {
    const create: Record<string, unknown> = { type: "create_session", cols, rows, attach: true };
    if (PREFERRED_SHELL) create["shell"] = PREFERRED_SHELL;
    const cwd = process.cwd();
    if (cwd) create["cwd"] = cwd;
    if (CLIENT_METADATA) create["clientMetadata"] = CLIENT_METADATA;
    ws.send(JSON.stringify(create));
  }
}

ws.on("message", (raw) => {
  let msg: { type?: string; [k: string]: unknown };
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }

  switch (msg.type) {
    case "ready": {
      // If the gateway didn't require auth, it sends `authenticated: true`
      // here and we can skip waiting for an `authenticated` reply.
      if (msg["authenticated"] === true || msg["requiresAuth"] === false) {
        sendCreateOrAttach();
      }
      // Otherwise wait for `authenticated` (sent in response to our hello).
      return;
    }
    case "authenticated": {
      sendCreateOrAttach();
      return;
    }
    case "session_created":
    case "attached": {
      sessionId = (msg["sessionId"] as string) ?? null;
      if (!sessionId) {
        logErr("server returned no sessionId; aborting");
        ws.close();
        return;
      }
      setupStdin();
      setupResize();
      return;
    }
    case "output": {
      if (msg["sessionId"] !== sessionId) return;
      const data = msg["data"];
      if (typeof data === "string") stdout.write(data);
      return;
    }
    case "exit": {
      if (msg["sessionId"] !== sessionId) return;
      exited = true;
      const code = typeof msg["exitCode"] === "number" ? (msg["exitCode"] as number) : 0;
      teardown();
      ws.close();
      process.exit(code);
      return;
    }
    case "error": {
      const code = msg["code"];
      const message = msg["message"];
      logErr(`server error: ${code} ${message ?? ""}`);
      if (code === "unknown_session" || code === "unauthorized") {
        teardown();
        ws.close();
        process.exit(1);
      }
      return;
    }
    default:
      return;
  }
});

ws.on("close", () => {
  if (exited) return;
  logErr("connection to gateway closed");
  teardown();
  process.exit(1);
});

ws.on("error", (err) => {
  logErr(`websocket error: ${(err as Error).message}`);
});

function setupStdin(): void {
  if (stdinSetup) return;
  stdinSetup = true;
  if ((stdin as NodeJS.ReadStream).isTTY) {
    (stdin as NodeJS.ReadStream).setRawMode(true);
  }
  stdin.resume();
  stdin.on("data", (chunk: Buffer) => {
    if (!sessionId || ws.readyState !== WebSocket.OPEN) return;
    debugLogStdin(chunk);
    // Strip terminal capability auto-replies that the host terminal emits in
    // response to VT queries from the PTY (DA1/DA2/DSR cursor pos). These
    // bytes are never user input — forwarding them would echo into the
    // remote prompt (e.g. `^[[?61;4c`).
    let data = chunk.toString("utf8");
    data = data
      .replace(/\x1b\[\?[\d;]+c/g, "") // DA1 reply
      .replace(/\x1b\[>[\d;]*c/g, "") // DA2 reply
      .replace(/\x1b\[\d+;\d+R/g, "") // cursor pos reply
      .replace(/\x1bP[!>]\|[\dA-Fa-f]*\x1b\\/g, "") // DECRQSS / tertiary DA
      // Drop non-xterm F-key encodings that some VS Code extensions (or
      // peripheral drivers) inject into the integrated terminal at periodic
      // intervals. xterm.js encodes F1-F4 as SS3 (ESC O P/Q/R/S) and
      // F5-F12 as CSI N~ with N in {15,17,18,19,20,21,23,24}. The patterns
      // below are Linux-console or rxvt-only encodings (double `[[` or
      // `^`/`$`/`@` terminators) that never originate from xterm.js, so
      // dropping them is safe and prevents phantom keystrokes from reaching
      // the PTY. Each pattern allows an optional ESC prefix (Alt-modifier).
      .replace(/\x1b\x1b?\[\[[A-E]/g, "") // Linux console F1-F5
      .replace(/\x1b\x1b?\[\d+[\^$@]/g, "") // rxvt Ctrl/Shift/Ctrl+Shift F-keys
      // F11 in DEC/PuTTY encoding (\x1b[25~) is also seen in the wild from
      // the same injectors. xterm.js uses \x1b[23~ for F11, so \x1b[25~ is
      // not a legitimate VS Code keystroke. Same for \x1b[26~ (Shift+F11
      // alt encoding).
      .replace(/\x1b\x1b?\[(25|26)~/g, "");
    if (!data) return;
    ws.send(JSON.stringify({ type: "input", sessionId, data }));
  });
}

function setupResize(): void {
  if (resizeSetup) return;
  resizeSetup = true;
  if (!(stdout as NodeJS.WriteStream).isTTY) return;
  const send = () => {
    if (!sessionId || ws.readyState !== WebSocket.OPEN) return;
    const { cols, rows } = getSize();
    ws.send(JSON.stringify({ type: "resize", sessionId, cols, rows }));
  };
  (stdout as NodeJS.WriteStream).on("resize", send);
}

function teardown(): void {
  try {
    if ((stdin as NodeJS.ReadStream).isTTY) (stdin as NodeJS.ReadStream).setRawMode(false);
  } catch {
    // ignore
  }
  stdin.pause();
}

process.on("SIGINT", () => {
  // Forward Ctrl-C to the remote PTY rather than killing the bridge.
  if (sessionId && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "input", sessionId, data: "\x03" }));
  }
});

process.on("SIGTERM", () => {
  teardown();
  ws.close();
  process.exit(0);
});
