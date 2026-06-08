export interface SessionInfo {
  sessionId: string;
  pid: number;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: string;
  alive: boolean;
  subscribers: number;
  /** 'pty' (local shell) or 'ssh' (remote shell via ssh2). */
  kind?: 'pty' | 'ssh';
}

/**
 * Metadata about the client (terminal host) that owns a session. Currently
 * only VS Code (and forks like Cursor) report metadata, used by the desktop UI
 * to offer "Open in VS Code" actions that focus the original window/terminal.
 */
export type ClientMetadata = {
  kind: 'vscode';
  /** Workspace folder (typically the terminal's cwd at open time). */
  workspace?: string;
  /** Value of VSCODE_IPC_HOOK_CLI — required to talk back to that VS Code window via the `code` CLI. */
  ipcHook?: string;
  /** Value of VSCODE_PID. */
  pid?: number;
  /** Value of TERM_PROGRAM_VERSION. */
  version?: string;
  /** Raw TERM_PROGRAM value (e.g. 'vscode'); useful for distinguishing forks later. */
  termProgram?: string;
};

export interface SshConnectOptions {
  host: string;
  port?: number;
  username: string;
  /** Path to private key file. If omitted, default key search + agent are tried. */
  privateKeyPath?: string;
  passphrase?: string;
  /** Override ssh-agent socket / pipe path. */
  agent?: string;
  /** Optional shell command to run once the remote shell is ready
   *  (e.g. `cd ~/dev/robot`). Sent as a single line followed by CR. */
  initCommand?: string;
}

export type ClientMessage =
  | { type: 'hello'; id?: string; token?: string }
  | { type: 'ping'; id?: string }
  | { type: 'list_sessions'; id?: string }
  | { type: 'list_desktop_sessions'; id?: string }
  | {
      type: 'create_session';
      id?: string;
      sessionId?: string;
      shell?: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      cols?: number;
      rows?: number;
      attach?: boolean;
      /** If false, the multitasker bridge will NOT register this session as a task. */
      track?: boolean;
      /**
       * Optional metadata about the client (e.g. VS Code) that opened this
       * session. The gateway forwards it to the multitasker backend so the
       * desktop UI can offer client-specific actions (e.g. "Open in VS Code").
       */
      clientMetadata?: ClientMetadata;
    }
  | {
      type: 'create_ssh_session';
      id?: string;
      sessionId?: string;
      ssh: SshConnectOptions;
      cols?: number;
      rows?: number;
      attach?: boolean;
    }
  | { type: 'attach'; id?: string; sessionId: string }
  | { type: 'detach'; id?: string; sessionId: string }
  | { type: 'watch_status'; id?: string; sessionId: string }
  | { type: 'unwatch_status'; id?: string; sessionId: string }
  | { type: 'input'; id?: string; sessionId: string; data: string }
  | { type: 'user_typing'; id?: string; sessionId: string; isTyping: boolean; occurredAt?: number }
  | { type: 'terminal_focus'; id?: string; sessionId: string; focused: boolean; occurredAt?: number }
  | { type: 'resize'; id?: string; sessionId: string; cols: number; rows: number }
  | { type: 'kill'; id?: string; sessionId: string; signal?: string }
  | { type: 'rename_session'; id?: string; sessionId: string; name: string }
  | { type: 'remove_session'; id?: string; sessionId: string }
  | { type: 'touch_session'; id?: string; sessionId: string };

export type ServerMessage =
  | {
      type: 'ready';
      protocolVersion: number;
      serverPid: number;
      requiresAuth: boolean;
      authenticated: boolean;
      defaults: { shell: string; cols: number; rows: number };
    }
  | { type: 'pong'; id?: string }
  | { type: 'authenticated'; id?: string }
  | { type: 'sessions'; id?: string; sessions: SessionInfo[] }
  | {
      type: 'session_created';
      id?: string;
      sessionId: string;
      pid: number;
      shell: string;
      cwd: string;
      cols: number;
      rows: number;
      kind?: 'pty' | 'ssh';
    }
  | { type: 'attached'; id?: string; sessionId: string; pid?: number; shell?: string; cwd?: string; cols?: number; rows?: number; kind?: 'pty' | 'ssh' }
  | { type: 'detached'; id?: string; sessionId: string }
  | { type: 'output'; sessionId: string; data: string; replay?: boolean }
  | {
      type: 'user_typing';
      sessionId: string;
      isTyping: boolean;
      occurredAt: number;
      sourceClientId: string;
    }
  | {
      type: 'terminal_focus';
      sessionId: string;
      focused: boolean;
      occurredAt: number;
      sourceClientId: string;
    }
  | {
      type: 'agent_status';
      sessionId: string;
      status: 'working' | 'needs_input' | 'idle';
      agentKind: 'codex' | 'copilot' | 'claude' | 'gemini' | 'generic';
      reason?: string;
      matchedText?: string;
      occurredAt: number;
    }
  | { type: 'exit'; sessionId: string; exitCode: number; signal: number | null }
  | { type: 'session_created'; id?: string; session: SessionInfo }
  | { type: 'session_updated'; id?: string; session: SessionInfo }
  | { type: 'session_removed'; id?: string; sessionId: string }
  | { type: 'desktop_sessions'; id?: string; sessions: unknown[] }
  | { type: 'desktop_session_created'; id?: string; session: unknown }
  | { type: 'desktop_session_updated'; id?: string; session: unknown }
  | { type: 'desktop_session_removed'; id?: string; sessionId: string }
  | {
      type: 'error';
      id?: string;
      code: ErrorCode;
      message: string;
      sessionId?: string;
    };

export type ErrorCode =
  | 'invalid_message'
  | 'unauthorized'
  | 'unknown_session'
  | 'spawn_failed'
  | 'internal_error';

export function parseClientMessage(raw: string): ClientMessage | { _error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { _error: `invalid json: ${(e as Error).message}` };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { _error: 'message must be a JSON object' };
  }
  const obj = parsed as { type?: unknown };
  if (typeof obj.type !== 'string') {
    return { _error: 'missing string `type`' };
  }
  return parsed as ClientMessage;
}
