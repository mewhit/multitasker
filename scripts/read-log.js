#!/usr/bin/env node
// Usage: node scripts/read-log.js <log-file> [--tail] [--session <sessionId>]
//
// Reads a session log file and outputs it with ANSI colour highlights so that
// status transitions are easy to spot at a glance.
//
// Flags:
//   --tail          Follow the file (like tail -f), useful for live sessions.
//   --session <id>  Only show lines for a specific sessionId (prefix match).

'use strict';

const fs   = require('node:fs');
const path = require('node:path');

// Enable ANSI virtual terminal processing on Windows (no-op on other platforms).
if (process.platform === 'win32') {
  try {
    const { execSync } = require('node:child_process');
    // PowerShell one-liner to enable VT mode on stdout handle
    execSync(
      'powershell -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $h = (Get-Process -Id $pid).MainWindowHandle; if ($h) { $null }"',
      { stdio: 'ignore' }
    );
  } catch { /* ignore – terminal may already support ANSI */ }
  // Node.js built-in flag: forces colour even when piped
  process.env['FORCE_COLOR'] = '1';
}

// ── ANSI helpers ────────────────────────────────────────────────────────────

const R  = '\x1b[0m';   // reset
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

const C = {
  ts:         '\x1b[2m',          // dim  – timestamps / clientId noise
  bracket:    '\x1b[2m',          // dim  – [ws] [info] etc.
  noise:      '\x1b[2m',          // dim  – terminal_focus / user_typing
  info:       '\x1b[32m',         // green
  ws:         '\x1b[36m',         // cyan – ws attached / detached
  working:    '\x1b[32m',         // green
  needsInput: '\x1b[33m',         // yellow
  idle:       '\x1b[2m\x1b[33m', // dim-yellow
  error:      '\x1b[31m',         // red
  transition: '\x1b[1m\x1b[93m', // bold bright-yellow  ← the important ones
  warn:       '\x1b[33m',         // yellow
  errLevel:   '\x1b[31m',         // red
};

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

// ── Arg parsing ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let filePath  = null;
let tailMode  = false;
let sessionFilter = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--tail') { tailMode = true; }
  else if (args[i] === '--session' && args[i + 1]) { sessionFilter = args[++i]; }
  else if (!args[i].startsWith('--')) { filePath = args[i]; }
}

if (!filePath) {
  const name = path.basename(process.argv[1]);
  console.error(`Usage: node scripts/${name} <log-file> [--tail] [--session <id>]`);
  process.exit(1);
}

if (!path.isAbsolute(filePath)) {
  filePath = path.join(process.cwd(), filePath);
}

// ── Line colouring ──────────────────────────────────────────────────────────

function colourLine(raw) {
  const line = raw.replace(ANSI_RE, '').trimEnd();
  if (!line) return '';

  // Optional session filter
  if (sessionFilter && !line.includes(sessionFilter)) return null;

  // Parse header from: [timestamp] [component] [level] message...
  const headerMatch = line.match(/^(\[[^\]]+\])\s+(\[[^\]]+\])\s+(\[[^\]]+\])\s+(.*)$/s);
  if (!headerMatch) return DIM + line + R;

  const [, ts, comp, lvl, rawBody] = headerMatch;
  const level = lvl.slice(1, -1); // strip brackets
  const body = rawBody.trim();

  const formattedStatus = colourFormattedSessionLine(ts, comp, lvl, body);
  if (formattedStatus) return formattedStatus;

  const bodyMatch = body.match(/^(.*?)\s+(\{.*\})$/s);
  const msg = bodyMatch ? bodyMatch[1].trim() : body;
  const rest = bodyMatch ? bodyMatch[2] : '';

  // Parse JSON meta if present.
  let meta = null;
  if (rest) {
    try { meta = JSON.parse(rest); } catch { /* not JSON, fine */ }
  }

  // ── Choose a colour based on message type ──────────────────────────────

  // Status transitions are the most important — bold yellow
  if (msg === 'agent_status_transition') {
    const from  = meta?.fromStatus ?? '?';
    const to    = meta?.toStatus   ?? '?';
    const why   = meta?.reason     ?? '';
    const sid   = shortId(meta?.sessionId);
    return (
      C.transition +
      `${ts} ${comp} ${lvl}  ▶▶ STATUS CHANGE  ${from} → ${to}` +
      R + C.ts + `  (${why})${sid ? '  [' + sid + ']' : ''}` + R
    );
  }

  // Working heartbeats – green but compact (strip repetitive boilerplate)
  if (msg === 'agent_status') {
    const status = meta?.status;
    if (status === 'working') {
      const reason = meta?.reason ?? '';
      const isHb   = reason.includes('heartbeat');
      const sid    = shortId(meta?.sessionId);
      const label  = isHb ? '♦ working (hb)' : '♦ working';
      return C.working + `${ts} ${comp} ${lvl}  ${label}` + R
           + C.ts + `${sid ? '  [' + sid + ']' : ''}  ${reason}` + R;
    }
    if (status === 'needs_input') {
      return C.needsInput + `${ts} ${comp} ${lvl}  ◆ needs_input` + R
           + C.ts + `  ${meta?.reason ?? ''}` + R;
    }
    if (status === 'idle') {
      return C.idle + `${ts} ${comp} ${lvl}  ◇ idle  ${meta?.reason ?? ''}` + R;
    }
    if (status === 'error') {
      return C.error + `${ts} ${comp} ${lvl}  ✗ error  ${rest}` + R;
    }
  }

  // New WS client attached – cyan
  if (msg === 'ws attached' || msg === 'ws detached') {
    const sid = shortId(meta?.sessionId);
    const cid = meta?.clientId ? meta.clientId.slice(0, 8) : '';
    return C.ws + `${ts} ${comp} ${lvl}  ◈ ${msg}` + R
         + C.ts + `  client=${cid}${sid ? '  session=[' + sid + ']' : ''}` + R;
  }

  // Low-signal noise – dim
  if (msg === 'terminal_focus' || msg === 'user_typing') {
    const focused  = meta?.focused  !== undefined ? `focused=${meta.focused}` : '';
    const typing   = meta?.isTyping !== undefined ? `isTyping=${meta.isTyping}` : '';
    const detail   = focused || typing;
    return C.noise + `${ts} ${comp} ${lvl}  · ${msg}  ${detail}` + R;
  }

  // Log level colouring fallback
  if (level === 'error') return C.errLevel + line + R;
  if (level === 'warn')  return C.warn     + line + R;
  if (level === 'info')  return DIM + `${ts} ${comp} ` + R + C.info + lvl + R + `  ${msg}` + (rest ? C.ts + `  ${rest}` + R : '');

  return DIM + `${ts} ${comp} ${lvl}` + R + `  ${msg}` + (rest ? C.ts + `  ${rest}` + R : '');
}

function colourFormattedSessionLine(ts, comp, lvl, body) {
  const transition = body.match(/STATUS CHANGE:\s+(.+?)\s+-->\s+([^\s=]+)/);
  if (transition) {
    const to = transition[2];
    return colourForStatus(to) + `${ts} ${comp} ${lvl}  ${body}` + R;
  }

  if (body.includes('[WORKING]') || body.includes('[working hb]')) {
    return C.working + `${ts} ${comp} ${lvl}  ${body}` + R;
  }
  if (body.includes('[NEEDS_INPUT]')) {
    return C.needsInput + `${ts} ${comp} ${lvl}  ${body}` + R;
  }
  if (body.includes('[IDLE]')) {
    return C.idle + `${ts} ${comp} ${lvl}  ${body}` + R;
  }
  if (body.includes('[ERROR]')) {
    return C.error + `${ts} ${comp} ${lvl}  ${body}` + R;
  }

  return null;
}

function colourForStatus(status) {
  if (status === 'working') return C.working;
  if (status === 'needs_input') return C.needsInput;
  if (status === 'idle') return C.idle;
  if (status === 'error') return C.error;
  return C.transition;
}

function shortId(id) {
  if (!id || typeof id !== 'string') return '';
  return id.slice(0, 8);
}

// ── File reading ─────────────────────────────────────────────────────────────

function processChunk(chunk, buf) {
  buf.text += chunk;
  const lines = buf.text.split('\n');
  buf.text = lines.pop(); // keep incomplete last line
  for (const line of lines) {
    const coloured = colourLine(line);
    if (coloured !== null) console.log(coloured);
  }
}

function readFile() {
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const buf = { text: '' };

  if (!tailMode) {
    // One-shot read
    const content = fs.readFileSync(filePath, 'utf8');
    processChunk(content, buf);
    if (buf.text.trim()) {
      const coloured = colourLine(buf.text);
      if (coloured !== null) console.log(coloured);
    }
    return;
  }

  // Tail mode: read existing content then watch for appends
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  stream.on('data', (chunk) => processChunk(chunk, buf));
  stream.on('end', () => {
    // Flush anything remaining
    if (buf.text.trim()) {
      const coloured = colourLine(buf.text);
      if (coloured !== null) console.log(coloured);
      buf.text = '';
    }
    // Now watch for new content
    let pos = fs.statSync(filePath).size;
    fs.watchFile(filePath, { interval: 300 }, () => {
      const stat = fs.statSync(filePath);
      if (stat.size <= pos) return;
      const follow = fs.createReadStream(filePath, { start: pos, encoding: 'utf8' });
      follow.on('data', (chunk) => processChunk(chunk, buf));
      follow.on('end', () => { pos = fs.statSync(filePath).size; });
    });
    console.log(DIM + '--- following ' + filePath + ' (Ctrl+C to stop) ---' + R);
  });
}

readFile();
