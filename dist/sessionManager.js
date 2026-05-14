"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionManager = void 0;
const pty = __importStar(require("node-pty"));
const node_events_1 = require("node:events");
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const STATUS_PRIORITY = {
    waiting: 0,
    error: 1,
    running: 2,
    stopped: 3,
};
class SessionManager extends node_events_1.EventEmitter {
    idleTimeout;
    sessions = new Map();
    persistedSessions = new Set();
    constructor(idleTimeout = 800) {
        super();
        this.idleTimeout = idleTimeout;
    }
    markSessionAsPersisted(id) {
        this.persistedSessions.add(id);
    }
    getPersistedSessionIds() {
        return Array.from(this.persistedSessions).filter(id => this.sessions.has(id));
    }
    createSession(name, cmd, cwd, shellType = 'powershell', sshHost = '') {
        const id = (0, node_crypto_1.randomUUID)();
        let shell;
        let shellArgs;
        if (shellType === 'ssh') {
            shell = 'ssh';
            shellArgs = [sshHost];
        }
        else if (shellType === 'bash') {
            shell = 'bash';
            shellArgs = [];
        }
        else {
            shell = 'powershell.exe';
            shellArgs = [];
        }
        const effectiveCwd = cwd || process.env['USERPROFILE'] || process.env['HOME'] || '/';
        const ptyProc = pty.spawn(shell, shellArgs, {
            name: 'xterm-color',
            cols: 80,
            rows: 24,
            cwd: effectiveCwd,
            env: process.env,
        });
        const session = {
            id,
            name,
            cmd,
            cwd: effectiveCwd,
            shellType,
            sshHost,
            status: 'running',
            lastOutput: Date.now(),
            pid: ptyProc.pid,
            gitChanges: false,
        };
        const entry = { session, ptyProc, idleTimer: null };
        this.sessions.set(id, entry);
        ptyProc.onData((data) => {
            session.lastOutput = Date.now();
            if (session.status !== 'running') {
                session.status = 'running';
                this.emit('sessionUpdate', this.getSessions());
            }
            this.resetIdleTimer(entry);
            if (shellType !== 'ssh')
                this.parseCwd(data, session);
            this.emit('output', id, data);
        });
        ptyProc.onExit(({ exitCode }) => {
            if (entry.idleTimer)
                clearTimeout(entry.idleTimer);
            session.status = exitCode === 0 ? 'stopped' : 'error';
            this.emit('sessionUpdate', this.getSessions());
        });
        if (cmd.trim()) {
            ptyProc.write(cmd + '\r');
        }
        this.emit('sessionUpdate', this.getSessions());
        return id;
    }
    resetIdleTimer(entry) {
        if (entry.idleTimer)
            clearTimeout(entry.idleTimer);
        entry.idleTimer = setTimeout(() => {
            if (entry.session.status === 'running') {
                entry.session.status = 'waiting';
                this.emit('sessionUpdate', this.getSessions());
                if (entry.session.shellType !== 'ssh')
                    void this.checkGitChanges(entry);
            }
        }, this.idleTimeout);
    }
    parseCwd(data, session) {
        // Windows PowerShell: PS C:\some\path>
        const psMatch = /PS ([A-Za-z]:[^\r\n>]+)>/.exec(data);
        if (psMatch?.[1]) {
            session.cwd = psMatch[1].trim();
            return;
        }
        // Unix bash/zsh: user@host:/path$ or ~/path$
        const unixMatch = /(?:[\w-]+@[\w-]+:)?([~/][^\r\n$#]*)[$#]/.exec(data);
        if (unixMatch?.[1]) {
            const home = process.env['HOME'] ?? '';
            session.cwd = unixMatch[1].replace('~', home).trim();
        }
    }
    checkGitChanges(entry) {
        return new Promise((resolve) => {
            (0, node_child_process_1.exec)('git status --porcelain', { cwd: entry.session.cwd }, (err, stdout) => {
                entry.session.gitChanges = !err && stdout.trim().length > 0;
                this.emit('sessionUpdate', this.getSessions());
                resolve();
            });
        });
    }
    sendInput(id, data) {
        this.sessions.get(id)?.ptyProc.write(data);
    }
    resizeSession(id, cols, rows) {
        this.sessions.get(id)?.ptyProc.resize(cols, rows);
    }
    killSession(id) {
        const entry = this.sessions.get(id);
        if (!entry)
            return;
        if (entry.idleTimer)
            clearTimeout(entry.idleTimer);
        entry.ptyProc.kill();
        this.sessions.delete(id);
        this.emit('sessionUpdate', this.getSessions());
    }
    getSessions() {
        return [...this.sessions.values()]
            .map(e => ({ ...e.session }))
            .sort((a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status]);
    }
}
exports.SessionManager = SessionManager;
