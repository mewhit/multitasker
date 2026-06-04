# shell

A small PTY host that wraps `pwsh` / `bash` / `cmd` via [`node-pty`](https://github.com/microsoft/node-pty)
and exposes a structured JSON protocol over a local WebSocket.

It runs as its own process so multiple clients (Electron renderer, tests,
extensions) can attach to the same PTY session and observe identical output.

## Run

```powershell
yarn build
node dist\shell\server.js
# or
npm run shell

# Dev with hot reload (tsc -w + auto-restart on dist\shell change)
npm run shell:dev
```

Environment variables:

| Var | Default | Meaning |
|-----|---------|---------|
| `SHELL_HOST` | `127.0.0.1` | Bind address. Loopback only by default. |
| `SHELL_PORT` | `4321` | TCP port for the WebSocket server. |
| `SHELL_AUTH_TOKEN` | _(empty)_ | If set, clients must send `{type:"hello",token:"..."}` before any other message. |
| `SHELL_DEBUG` | _(unset)_ | When set, emits debug logs on stderr. |
| `MULTITASKER_BACKEND_URL` | `http://127.0.0.1:39017` | Base URL of the multitasker http-server. |
| `MULTITASKER_INTEGRATION` | `1` | Set to `0` to disable auto-registering shells as multitasker tasks. |
| `MULTITASKER_SHELL_NAME_PREFIX` | `shell` | Prefix for the task name in multitasker (e.g. `shell 5d142691`). |

## Multitasker integration

When enabled, every PTY session created by this server is automatically
registered with the multitasker http-server as a new task:

- On `session_created` → `POST /api/session/create` with `{ name, cmd: '', cwd, shellType }`.
- On PTY exit / session removal → `POST /api/session/remove` with the
  multitasker session id returned earlier.

Failures (backend down, non-2xx response) are logged on stderr but never
crash the shell server.

## Protocol (v1)

All messages are JSON objects with a `type` field. Optional `id` lets the
client correlate responses.

### Client → server

| `type` | Payload | Notes |
|---|---|---|
| `hello` | `{ token? }` | Required first message when `SHELL_AUTH_TOKEN` is set. |
| `ping` | — | Server replies with `pong`. |
| `list_sessions` | — | Server replies with `sessions`. |
| `create_session` | `{ sessionId?, shell?, args?, cwd?, env?, cols?, rows?, attach? }` | `attach` defaults to `true`. |
| `attach` | `{ sessionId }` | Subscribe to a session's output stream. |
| `detach` | `{ sessionId }` | Stop receiving output for a session. |
| `input` | `{ sessionId, data }` | Write raw bytes to the PTY (e.g. `"ls\r"`). |
| `resize` | `{ sessionId, cols, rows }` | Resize the PTY. |
| `kill` | `{ sessionId, signal? }` | Kill the underlying process. |

### Server → client

| `type` | Payload |
|---|---|
| `ready` | `{ protocolVersion, serverPid, requiresAuth, authenticated, defaults }` (sent on connect) |
| `authenticated` | — |
| `pong` | — |
| `sessions` | `{ sessions: SessionInfo[] }` |
| `session_created` | `{ sessionId, pid, shell, cwd, cols, rows }` |
| `attached` / `detached` | `{ sessionId }` |
| `output` | `{ sessionId, data }` (only sent to attached subscribers) |
| `exit` | `{ sessionId, exitCode, signal }` |
| `error` | `{ code, message, sessionId?, id? }` |

`code` values: `invalid_message`, `unauthorized`, `unknown_session`,
`spawn_failed`, `internal_error`.

## Example client (Node)

```js
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:4321');

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'ready') {
    ws.send(JSON.stringify({ type: 'create_session', cols: 120, rows: 30 }));
  } else if (msg.type === 'session_created') {
    ws.send(JSON.stringify({ type: 'input', sessionId: msg.sessionId, data: 'echo hi\r' }));
  } else if (msg.type === 'output') {
    process.stdout.write(msg.data);
  }
});
```

## Why a separate process?

- A single PTY can be observed by multiple consumers (UI + tests + automation)
  without fighting over stdout.
- Native modules (`node-pty`) don't need to be rebuilt against Electron's ABI.
- Crashing a PTY (or the host) doesn't crash the desktop app.
