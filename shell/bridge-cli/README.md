# multitasker-shell bridge

A tiny stdio ↔ WebSocket bridge so that any program expecting a "shell" can
attach to a multitasker PTY (managed by the supervisor + gateway) instead of
spawning its own detached process.

Primary use case: register it as a **VS Code terminal profile** so that opening
a terminal in VS Code creates a tracked multitasker session — with shared
scrollback, agent status detection, and ability to view the same terminal in
the multitasker desktop app.

## Build

```powershell
yarn build
```

This emits `dist/shell/bridge-cli/index.js`.

## VS Code integration

Add to your user `settings.json`:

```json
"terminal.integrated.profiles.windows": {
  "Multitasker": {
    "path": "node",
    "args": ["C:\\dev\\multitasker\\dist\\shell\\bridge-cli\\index.js"]
  }
},
"terminal.integrated.defaultProfile.windows": "Multitasker"
```

(For macOS/Linux replace `windows` with `osx` / `linux` and the path
accordingly.)

Open a new terminal → it becomes a multitasker session you can also see in
the desktop app.

## Environment variables

| Var | Default | Meaning |
|-----|---------|---------|
| `MULTITASKER_SHELL_URL`   | `ws://127.0.0.1:4321` | Gateway WebSocket URL. |
| `MULTITASKER_SHELL_TOKEN` | _(empty)_             | Auth token (matches `SHELL_AUTH_TOKEN` on the gateway). |
| `MULTITASKER_SESSION_ID`  | _(empty)_             | If set, attach to an existing session instead of creating one. |
| `MULTITASKER_SHELL_KIND`  | gateway default       | `pwsh` / `bash` / `cmd` — passed as `shell` to `create_session`. |

## How it works

1. Connects to the gateway WS.
2. Sends `hello` (with token if configured).
3. On `ready` / `authenticated`, sends `create_session` (or `attach`) with the
   current terminal's `cols`/`rows`, `cwd`, and (if running inside VS Code) a
   `clientMetadata` block with VS Code env hints (`VSCODE_PID`,
   `VSCODE_IPC_HOOK_CLI`, `TERM_PROGRAM_VERSION`, workspace folder). The
   gateway forwards this to the multitasker backend so the desktop UI can
   offer an **Open in VS Code** action that focuses the originating window.
4. Bridges stdio:
   - `stdin` (raw mode) → `input` messages
   - `output` messages → `stdout`
   - terminal `resize` event → `resize` messages
   - PTY `exit` → process exit with the same code
5. Forwards `SIGINT` (Ctrl-C) into the PTY rather than killing the bridge.
