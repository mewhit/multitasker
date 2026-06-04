# Multitasker — Shell I/O architecture (état actuel)

But du doc : tracer **chaque hop** que prennent les bytes d'un PTY jusqu'à
l'écran (et inversement, du clavier jusqu'au PTY), pour qu'on puisse voir où
l'archi crisse et ce qu'on pourrait collapse.

---

## 1. Les processus en jeu

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Machine de l'utilisateur                            │
│                                                                             │
│  ┌──────────────────┐   pipe \\.\pipe\multitasker-shell  ┌───────────────┐  │
│  │   Supervisor     │ ◄───────── NDJSON IPC ───────────► │    Gateway    │  │
│  │  (long-lived)    │                                    │  (ws-server)  │  │
│  │                  │                                    │  port 4321    │  │
│  │  - spawn PTY     │                                    │               │  │
│  │  - spawn SSH     │                                    │  - auth WS    │  │
│  │  - scrollback    │                                    │  - analyzer   │  │
│  │    réseau (ssh)  │                                    │  - scrollback │  │
│  │                  │                                    │    par client │  │
│  └──────┬───────────┘                                    └──┬─────────┬──┘  │
│         │ owns                                              │ WS      │ WS  │
│         ▼                                                   │         │     │
│   ┌──────────┐                                              │         │     │
│   │ node-pty │                                              │         │     │
│   │  /  ssh2 │                                              │         │     │
│   └────┬─────┘                                              │         │     │
│        │                                                    │         │     │
│        ▼                                                    │         │     │
│   ┌──────────┐                                              │         │     │
│   │  shell   │ (pwsh/bash/cmd, codex, copilot, …)           │         │     │
│   └──────────┘                                              │         │     │
│                                                             │         │     │
│  ┌──────────────────────────────────────┐                   │         │     │
│  │   Multitasker desktop (Electron)     │ ◄─────────────────┘         │     │
│  │                                      │                             │     │
│  │  main.ts ──► sessionManager (state)  │                             │     │
│  │       │                              │                             │     │
│  │       │ ipc                          │                             │     │
│  │       ▼                              │                             │     │
│  │  renderer (index.html)               │                             │     │
│  │   ├─ liste de sessions               │                             │     │
│  │   ├─ xterm.js (mirror)  ─────────────┼─────────── WS ──────────────┤     │
│  │   └─ HTTP REST (état)                │                             │     │
│  │           │                          │                             │     │
│  │           ▼                          │                             │     │
│  │   http-server interne (port ?)       │                             │     │
│  └──────────────────────────────────────┘                             │     │
│                                                                       │     │
│  ┌──────────────────────────────────────┐                             │     │
│  │   VS Code / Cursor                   │                             │     │
│  │   terminal integrated profile        │                             │     │
│  │   ─► node bridge-cli/index.js  ──────┼─────────── WS ──────────────┘     │
│  │     (stdio  ⇄  WS messages)          │                                   │
│  └──────────────────────────────────────┘                                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

Processus distincts qu'on a aujourd'hui :

| # | Processus | Rôle |
|---|---|---|
| 1 | **Supervisor** (`shell/supervisor`) | Daemon. Spawn node-pty / ssh2. Survit aux crashes des autres. IPC via named pipe. |
| 2 | **Gateway** (`shell/gateway/ws-server`) | Serveur WS port 4321. Multiplexe N clients par session, fait analyzer, traduit clavier, garde scrollback par session. |
| 3 | **Multitasker desktop main** (`desktop/main.ts`, Electron) | UI host. Garde l'état des "tasks". Sert un mini http (REST `/api/session/*`). Lance optionnellement supervisor+gateway en child. |
| 4 | **Multitasker renderer** (`desktop/index.html`) | UI xterm.js, liste, détails. Parle au main via ipcRenderer, et **directement** au gateway via WS pour le mirror. |
| 5 | **bridge-cli** (`shell/bridge-cli/index.ts`) | Process node spawné par VS Code comme terminal profile. Passe stdin → WS, WS → stdout. |
| 6 | **shell enfant** (pwsh, bash, codex, …) | Le vrai. |

---

## 2. Les chemins d'identité (le plus gros problème)

Trois mondes ont chacun leur ID :

- **shellSessionId** : ID du PTY chez supervisor + gateway. Sert de clé dans les logs (`.tmp\session-<id>.log`) et dans les messages WS.
- **multitasker session.id** : ID dans l'UI / sessionManager / http-server.
- **clientId** : ID d'une connexion WS (un par fenêtre attached).

Avant le fix récent on avait deux UUIDs distincts pour la même chose. Maintenant
on **conflate** les deux en passant `requestedId: session.sessionId` à
`http-server.createSession`. Mais c'est patché à 3 endroits différents :

1. `shell/core/multitasker-bridge.ts` (quand le PTY est créé _par bridge-cli_)
2. `desktop/main.ts` ligne 4164 (quand le renderer demande un shell)
3. `desktop/main.ts` ligne 4228 (idem pour SSH)

Si tu rates un seul appel, t'as encore le split.

---

## 3. Flux **OUTPUT** (PTY → écran)

Exemple : codex écrit `Hello\n` dans son TTY.

```
shell child
   │  writes "Hello\n" to its stdout
   ▼
node-pty (in supervisor)               [hop 0]
   │  IPty.onData("Hello\n")
   ▼
PtySession.emit('data', "Hello\n")     shell/core/pty-session.ts:101
   │  + log "pty data" (per chunk!)
   ▼
SessionManager bubble                  shell/core/session-manager.ts
   │  emit('output', sessionId, data)
   ▼
supervisor ipc-server                  shell/supervisor/ipc-server.ts
   │  → JSON line { type:"output", sessionId, data } over pipe
   ▼
─── named pipe \\.\pipe\multitasker-shell ──────────────────────────────
   │
   ▼
gateway SupervisorClient               shell/gateway/supervisor-client.ts
   │  - append to per-session scrollback buffer (256KB ring)
   │  - emit('output', sessionId, data)
   ▼
gateway ws-server.ts                   [hop 1]
   │  - analyzer.ingest(sessionId, data)
   │       └─ output-analyzer.ts: regex on activeTail (last 20 lines)
   │          ↳ may emit status updates → POST http-server /api/session/:id
   │  - for each subscribed clientId in sessionSubscribers[sessionId]:
   │       ws.send({type:"output", sessionId, data:string})
   │
   ├──────► WS to renderer xterm                          ──► hop 2a
   │
   └──────► WS to bridge-cli                              ──► hop 2b


[2a]  renderer xterm.js
        │  msg.type === "output"
        │  term.write(data)                              → DOM canvas

[2b]  bridge-cli (shell/bridge-cli/index.ts:132)
        │  msg.type === "output"
        │  stdout.write(data)
        ▼
      VS Code integrated terminal pty buffer
        │  (VS Code re-parses VT codes)
        ▼
      xterm.js inside VS Code                            → DOM canvas
```

**Compte les conversions** :
- `Buffer → string utf8` chez node-pty (hop 0)
- `string → JSON.stringify` chez supervisor (hop 0/1)
- `JSON.parse → string` chez gateway (hop 1)
- `string → JSON.stringify` chez gateway pour chaque client (hop 1)
- `JSON.parse → string` chez chaque client (hop 2)
- pour bridge-cli : `process.stdout.write` puis **VS Code reparse les VT**
  une 2e fois avant d'envoyer à son propre xterm
- chez renderer : `term.write` → xterm.js parse

Pour un seul redraw de codex (≈10–50 KB) on fait ~5 sérialisations JSON
et 2 parsings VT côté VS Code.

---

## 4. Flux **INPUT** (clavier → PTY)

Exemple : utilisateur tape `a` dans xterm de multitasker.

```
xterm.js renderer
   │  onData("a")
   ▼
WS send {type:"input", sessionId, data:"a"}
   ▼
─── WS ─────────────────────────────────────────────────────────────────
   ▼
gateway ws-server.ts case 'input'      [traduction!]
   │  - if shell non-bash and data === "\x08": rewrite to "\x7F"
   │    (PSReadLine: BS = BackwardKillWord, DEL = BackwardDeleteChar)
   │  - supervisor.write(sessionId, data)
   ▼
─── named pipe ──────────────────────────────────────────────────────────
   ▼
supervisor ipc-server
   ▼
SessionManager.write(sessionId, data)
   ▼
PtySession.write                       shell/core/pty-session.ts:156
   │  + log "pty write"
   ▼
node-pty IPty.write
   ▼
ConPTY / pty pipe
   ▼
shell child stdin
```

Côté bridge-cli c'est presque pareil sauf qu'avant d'envoyer le WS, on
**strippe les replies automatiques de VT** (DA1, DA2, CPR) que VS Code/Windows
Terminal génèrent automatiquement en réponse à des queries du shell. Sinon ces
bytes seraient interprétés comme du texte tapé.

```
VS Code keystroke → bridge-cli stdin (raw mode)
   │  strip /\x1b\[\?[\d;]+c/, /\x1b\[>[\d;]*c/, /\x1b\[\d+;\d+R/, /\x1bP[!>]\|.../
   ▼
WS send {type:"input", sessionId, data}
   ▼ (rest is the same as above)
```

---

## 5. Flux **RESIZE** (corrigé tout à l'heure)

Chaque client `xterm` envoie sa propre taille. Le PTY n'en a qu'une.

```
client A (renderer xterm, 200×50)            client B (bridge-cli VS Code, 120×30)
   │ resize event                                │ resize event
   ▼                                             ▼
   WS {type:"resize", sessionId, cols, rows}     WS {type:"resize", sessionId, cols, rows}
   └─────────────────┬───────────────────────────┘
                     ▼
       gateway ws-server.ts case 'resize'
                     │
                     ▼
       applyClientResize(clientId, sessionId, cols, rows)
                     │  clientDesiredSizes[sessionId][clientId] = {cols,rows}
                     ▼
       recomputeEffectiveSize(sessionId)
                     │  effective = { min(cols), min(rows) }
                     │  if changed: supervisor.resize(sessionId, c, r)
                     ▼
       PtySession.resize → node-pty resize → ConPTY
```

Quand un client disconnect: `forgetClientSize(clientId, sessionId)` →
recompute → la min remonte automatiquement.

---

## 6. Flux **STATUS** (idle / running / needs_input)

Branche séparée qui décore les sessions dans l'UI.

```
gateway analyzer.ingest(sessionId, chunk)
   │  - append to per-session ring buffer (raw output)
   │  - strip ANSI → plain text
   │  - lastLines(plain, ACTIVE_SCREEN_LINES=20)  → activeTail
   │  - run regex passes:
   │       1. specific input prompts (codex "›", claude ">", gemini)
   │       2. generic input prompts on activeTail
   │       3. agent running indicators (bullets + verbs)
   │       4. fall back to idle / generic
   │  - if status changed: POST to http-server /api/session/:id/agent-status
   ▼
http-server (in desktop/main.ts)
   │  updates session row in sessionManager
   ▼
electron broadcasts via ipcMain → renderer
   ▼
renderer redraws the session list badge
```

---

## 7. Les **boucles** et **double-paths** problématiques

1. **Renderer parle aux deux mondes** : il fait du IPC vers `desktop/main.ts`
   pour l'état (créer, renommer, lister), MAIS aussi WS direct au gateway pour
   xterm. Donc deux chemins de vérité (sessionManager vs gateway).

2. **`requestedId` doit être set à 3 endroits** pour que les IDs s'alignent.
   Manqué = log mismatch + "session no longer exists".

3. **`shellPtyIds` localStorage côté renderer** décide si un click ouvre xterm
   ou une summary view. Pas synchronisé avec le serveur — on fait du
   auto-register / auto-sweep défensif partout.

4. **bridge-cli est un passthrough idiot** mais reste un process node spawné
   par VS Code. ~80 ms de startup + 1 WS hop + JSON ser/des + double VT parse
   par chunk. C'est purement de l'overhead.

5. **Le statut analyzer tourne dans le gateway** mais publie via HTTP REST
   vers `desktop/main.ts`. Donc l'analyzer doit connaître l'URL backend et
   faire un POST par changement. Ça pourrait être un event WS interne.

6. **Supervisor + gateway sont deux processus** qui parlent NDJSON sur un pipe
   mais sont systématiquement co-démarrés par main.ts. Le seul gain de la
   séparation : survivre au crash de l'autre (rare). Le coût : 2 ser/des JSON
   par output chunk, 2 process à manager, 2 sets de logs.

---

## 8. Comptage des hops pour 1 chunk d'output

| Hop | Conversion |
|---|---|
| 1 | shell → ConPTY → node-pty Buffer |
| 2 | Buffer → utf8 string (PtySession) |
| 3 | string → JSON.stringify (supervisor ipc) |
| 4 | NDJSON over named pipe |
| 5 | JSON.parse → string (gateway SupervisorClient) |
| 6 | scrollback ring append + analyzer regex passes |
| 7 | string → JSON.stringify (gateway, per WS client) |
| 8a | WS to renderer → JSON.parse → xterm.write |
| 8b | WS to bridge-cli → JSON.parse → stdout.write |
| 9b | VS Code re-parses VT → its own xterm |

Pour input/keystroke c'est symétrique (~6 hops).

---

## 9. Pistes pour radically improve

À discuter, pas tranché :

### a) **Tuer bridge-cli, écrire une extension VS Code**
- VS Code API `vscode.window.registerTerminalProfileProvider` + `Pseudoterminal`
  → on devient le pty directement, sans process node externe.
- L'extension parle WS au gateway in-process. Pas de double VT parse, pas de
  spawn node.
- Bonus : on peut poser des commands "Focus task in Multitasker", "Open
  workspace from task", etc.

### b) **Fusionner supervisor + gateway**
- Aucun bénéfice mesurable de la séparation aujourd'hui.
- Un seul process : node-pty + WS server + analyzer. Plus de NDJSON ni de
  pipe → -2 ser/des par chunk, -1 source de bugs (`unknown_session`).
- Si on veut vraiment survivre au crash : un mini watchdog dans desktop/main
  qui respawn le service unifié.

### c) **Backend authoritative pour l'identité**
- Plus de `requestedId` ping-pong. Une seule API: `POST /sessions` →
  retourne `{id, gatewayWsUrl, attachToken}`. Tout le monde attache via cet
  ID. Le gateway lui-même demande au backend de créer la PTY si pas connue.
- Effet : un seul endroit où le sessionId naît.

### d) **Pousser le statut via WS event au lieu de REST**
- Le gateway sait déjà tout. Au lieu de POST `/agent-status`, émettre
  `{type:"status", sessionId, status}` sur la même socket. Le renderer
  écoute et update sa view. Le desktop/main écoute pour persister.
- Supprime la dépendance gateway → backend HTTP URL.

### e) **xterm.js partagé entre renderer et "VS Code"**
- Si l'extension VS Code fait elle aussi du `Pseudoterminal`, le contenu
  est déjà parsé une fois côté gateway si on voulait — mais en pratique
  chaque client a son propre xterm donc son propre parseur. C'est OK.
- Ce qui aiderait : un format binaire (raw bytes WS) au lieu de JSON-text
  pour les `output`. xterm.js gère les Uint8Array natif.

### f) **Renderer ne parle qu'à main.ts**
- Aujourd'hui le renderer ouvre lui-même un WS au gateway. Si on rendait
  le main.ts proxy (forward des messages WS via ipc), on aurait un seul
  point d'auth + de mapping d'ID. Le coût: + un hop ipc. Le bénéfice:
  pas de duplication de `shellPtyIds`, pas de re-handling des `unknown_session`.

---

## 10. Decision matrix rapide

| Idée | Effort | Gain perf | Gain robustesse | Gain debug |
|------|--------|-----------|-----------------|------------|
| Tuer bridge-cli (extension VS Code) | gros | moyen | gros | gros |
| Fusionner supervisor+gateway | moyen | petit | moyen | gros |
| Backend authoritative pour ID | moyen | nul | gros | gros |
| Status via WS au lieu de REST | petit | petit | petit | moyen |
| Output WS en binaire | petit | moyen (gros si codex) | nul | nul |
| Renderer → main → gateway (proxy) | moyen | négatif | gros | gros |
