"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionManager = void 0;
const node_events_1 = require("node:events");
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const terminalEvents_1 = require("./terminalEvents");
const SESSION_UPDATE_DEBOUNCE_MS = 250;
const GIT_CHANGE_CHECK_DEBOUNCE_MS = 1000;
const INITIAL_SESSION_STATUS = 'needs_attention';
class SessionManager extends node_events_1.EventEmitter {
    sessions = new Map();
    updateTimeout = null;
    terminalEventParser = new terminalEvents_1.TerminalEventParser();
    createSession(name, cmd, cwd, shellType = 'powershell', requestedId = '', sshCommand = '', terminalRef = '', terminalPid, sshOptions) {
        const id = requestedId.trim() || (0, node_crypto_1.randomUUID)();
        const trimmedSshCommand = sshCommand.trim();
        const trimmedTerminalRef = terminalRef.trim();
        const effectiveCwd = shellType === 'ssh'
            ? cwd.trim()
            : cwd || process.env['USERPROFILE'] || process.env['HOME'] || '/';
        const now = Date.now();
        const existingEntry = this.sessions.get(id);
        if (existingEntry) {
            existingEntry.session.name = name;
            existingEntry.session.cmd = cmd;
            existingEntry.session.cwd = effectiveCwd;
            existingEntry.session.shellType = shellType;
            if (trimmedSshCommand) {
                existingEntry.session.sshCommand = trimmedSshCommand;
            }
            else {
                delete existingEntry.session.sshCommand;
            }
            if (sshOptions) {
                existingEntry.session.sshOptions = sshOptions;
            }
            else if (shellType !== 'ssh') {
                delete existingEntry.session.sshOptions;
            }
            if (trimmedTerminalRef)
                existingEntry.session.terminalRef = trimmedTerminalRef;
            if (terminalPid !== undefined)
                existingEntry.session.terminalPid = terminalPid;
            if (existingEntry.session.status !== INITIAL_SESSION_STATUS)
                existingEntry.statusChangedAt = now;
            existingEntry.session.status = INITIAL_SESSION_STATUS;
            existingEntry.session.lastActivity = now;
            delete existingEntry.session.terminalExitCode;
            delete existingEntry.session.terminalExitReason;
            delete existingEntry.session.terminalCaptureState;
            delete existingEntry.session.terminalCaptureReason;
            existingEntry.lastEffectiveUpdateAt = now;
            existingEntry.lastTerminalUpdateAt = 0;
            this.terminalEventParser.reset(id);
            this.emit('sessionUpdate', this.getSessions());
            this.checkGitChangesNow(existingEntry);
            return { ...existingEntry.session };
        }
        const session = {
            id,
            name,
            cmd,
            cwd: effectiveCwd,
            shellType,
            status: INITIAL_SESSION_STATUS,
            lastActivity: now,
            gitChanges: false,
        };
        if (trimmedSshCommand)
            session.sshCommand = trimmedSshCommand;
        if (sshOptions)
            session.sshOptions = sshOptions;
        if (trimmedTerminalRef)
            session.terminalRef = trimmedTerminalRef;
        if (terminalPid !== undefined)
            session.terminalPid = terminalPid;
        const entry = {
            session,
            createdAt: now,
            lastEffectiveUpdateAt: now,
            lastTerminalUpdateAt: 0,
            statusChangedAt: now,
            gitCheckTimeout: null,
        };
        this.sessions.set(id, entry);
        this.emit('sessionUpdate', this.getSessions());
        this.checkGitChangesNow(entry);
        return { ...session };
    }
    touchSession(id) {
        const entry = this.sessions.get(id);
        if (!entry)
            return null;
        const now = Date.now();
        entry.session.lastActivity = now;
        entry.lastEffectiveUpdateAt = now;
        this.emit('sessionUpdate', this.getSessions());
        this.scheduleGitChangesCheck(entry);
        return { ...entry.session };
    }
    updateTerminalState(update) {
        const entry = this.sessions.get(update.id);
        if (!entry)
            return null;
        if (entry.session.status === 'detached')
            return { ...entry.session };
        if (entry.session.status === 'paused' && update.status !== 'running')
            return { ...entry.session };
        if (update.occurredAt < entry.lastTerminalUpdateAt)
            return { ...entry.session };
        return this.applyTerminalUpdate(entry, update);
    }
    updateTerminalEvent(event) {
        return this.updateTerminalEventWithDetails(event)?.session ?? null;
    }
    updateTerminalEventWithDetails(event) {
        const entry = this.sessions.get(event.id);
        if (!entry)
            return null;
        if (entry.session.status === 'detached' && !this.restoreDetachedSessionFromTerminalEvent(entry, event)) {
            return { session: { ...entry.session } };
        }
        if (event.occurredAt < entry.lastTerminalUpdateAt)
            return { session: { ...entry.session } };
        const terminalBinding = {};
        if (event.terminalRef)
            terminalBinding.terminalRef = event.terminalRef;
        if (event.terminalPid !== undefined)
            terminalBinding.terminalPid = event.terminalPid;
        if (event.captureState)
            terminalBinding.terminalCaptureState = event.captureState;
        if (event.captureReason)
            terminalBinding.terminalCaptureReason = event.captureReason;
        const bindingChanged = this.updateSessionTerminalBinding(entry, terminalBinding);
        const update = this.terminalEventParser.toTerminalUpdate(event, entry.session.status);
        if (!update) {
            entry.lastTerminalUpdateAt = event.occurredAt;
            if (bindingChanged)
                this.emitUpdateDebounced();
            return { session: { ...entry.session } };
        }
        if (entry.session.status === 'paused' && update.status !== 'running') {
            entry.lastTerminalUpdateAt = event.occurredAt;
            if (bindingChanged)
                this.emitUpdateDebounced();
            return { session: { ...entry.session } };
        }
        const session = this.applyTerminalUpdate(entry, update);
        if (bindingChanged)
            this.emitUpdateDebounced();
        return { session, statusUpdate: update };
    }
    pauseSession(id) {
        const entry = this.sessions.get(id);
        if (!entry)
            return null;
        if (entry.session.status === 'paused')
            return { ...entry.session };
        if (entry.session.status === 'error' ||
            entry.session.status === 'stopped' ||
            entry.session.status === 'detached') {
            return { ...entry.session };
        }
        const now = Date.now();
        entry.session.status = 'paused';
        entry.session.lastActivity = now;
        entry.statusChangedAt = now;
        entry.lastEffectiveUpdateAt = now;
        this.emit('sessionUpdate', this.getSessions());
        return { ...entry.session };
    }
    bindSessionToTerminal(id, binding) {
        const entry = this.sessions.get(id);
        if (!entry)
            return null;
        const bindingChanged = this.updateSessionTerminalBinding(entry, binding);
        if (entry.session.status === 'detached') {
            entry.session.status = INITIAL_SESSION_STATUS;
            entry.statusChangedAt = Date.now();
            delete entry.session.terminalExitCode;
            delete entry.session.terminalExitReason;
            this.terminalEventParser.reset(id);
            this.emit('sessionUpdate', this.getSessions());
            return { ...entry.session };
        }
        if (bindingChanged)
            this.emitUpdateDebounced();
        return { ...entry.session };
    }
    renameSession(id, name) {
        const entry = this.sessions.get(id);
        if (!entry)
            return null;
        const nextName = name.trim();
        if (!nextName)
            return null;
        if (entry.session.name !== nextName) {
            entry.session.name = nextName;
            this.emit('sessionUpdate', this.getSessions());
        }
        return { ...entry.session };
    }
    setClientMetadata(id, metadata) {
        const entry = this.sessions.get(id);
        if (!entry)
            return null;
        if (metadata === null) {
            if (entry.session.clientMetadata !== undefined) {
                delete entry.session.clientMetadata;
                this.emit('sessionUpdate', this.getSessions());
            }
            return { ...entry.session };
        }
        const prev = entry.session.clientMetadata;
        const changed = !prev ||
            prev.kind !== metadata.kind ||
            prev.workspace !== metadata.workspace ||
            prev.ipcHook !== metadata.ipcHook ||
            prev.pid !== metadata.pid ||
            prev.version !== metadata.version ||
            prev.termProgram !== metadata.termProgram;
        if (changed) {
            entry.session.clientMetadata = { ...metadata };
            this.emit('sessionUpdate', this.getSessions());
        }
        return { ...entry.session };
    }
    restoreDetachedSessionFromTerminalEvent(entry, event) {
        if (event.type === 'terminal_closed' || event.type === 'terminal_disconnected')
            return false;
        const eventTerminalRef = event.terminalRef?.trim();
        const sessionTerminalRef = entry.session.terminalRef?.trim();
        const terminalMatches = Boolean(eventTerminalRef && sessionTerminalRef && eventTerminalRef === sessionTerminalRef);
        if (!terminalMatches)
            return false;
        entry.session.status = INITIAL_SESSION_STATUS;
        entry.statusChangedAt = event.occurredAt;
        delete entry.session.terminalExitCode;
        delete entry.session.terminalExitReason;
        this.terminalEventParser.reset(event.id);
        return true;
    }
    updateSessionTerminalBinding(entry, binding) {
        let changed = false;
        const normalizedTerminalRef = binding.terminalRef?.trim();
        if (normalizedTerminalRef && entry.session.terminalRef !== normalizedTerminalRef) {
            entry.session.terminalRef = normalizedTerminalRef;
            changed = true;
        }
        if (binding.terminalPid !== undefined && entry.session.terminalPid !== binding.terminalPid) {
            entry.session.terminalPid = binding.terminalPid;
            changed = true;
        }
        if (binding.terminalCaptureState) {
            const captureReason = binding.terminalCaptureReason?.trim();
            if (entry.session.terminalCaptureState !== binding.terminalCaptureState ||
                entry.session.terminalCaptureReason !== captureReason) {
                entry.session.terminalCaptureState = binding.terminalCaptureState;
                if (captureReason) {
                    entry.session.terminalCaptureReason = captureReason;
                }
                else {
                    delete entry.session.terminalCaptureReason;
                }
                changed = true;
            }
        }
        if (changed)
            entry.lastEffectiveUpdateAt = Math.max(entry.lastEffectiveUpdateAt, Date.now());
        return changed;
    }
    applyTerminalUpdate(entry, update) {
        const previousStatus = entry.session.status;
        const previousExitCode = entry.session.terminalExitCode;
        const previousExitReason = entry.session.terminalExitReason;
        entry.lastTerminalUpdateAt = update.occurredAt;
        entry.lastEffectiveUpdateAt = Math.max(entry.lastEffectiveUpdateAt, update.occurredAt, Date.now());
        if (previousStatus !== update.status)
            entry.statusChangedAt = update.occurredAt;
        entry.session.status = update.status;
        entry.session.lastActivity = update.occurredAt;
        if (update.exitCode !== undefined) {
            entry.session.terminalExitCode = update.exitCode;
        }
        else if (update.status !== 'error' && update.status !== 'stopped') {
            delete entry.session.terminalExitCode;
        }
        if (update.exitReason !== undefined) {
            entry.session.terminalExitReason = update.exitReason;
        }
        else if (update.status !== 'error' && update.status !== 'stopped') {
            delete entry.session.terminalExitReason;
        }
        if (update.status === 'error' || update.status === 'stopped' || update.status === 'detached') {
            delete entry.session.terminalCaptureState;
            delete entry.session.terminalCaptureReason;
        }
        if (previousStatus !== entry.session.status ||
            previousExitCode !== entry.session.terminalExitCode ||
            previousExitReason !== entry.session.terminalExitReason) {
            this.emit('sessionUpdate', this.getSessions());
        }
        else {
            this.emitUpdateDebounced();
        }
        this.scheduleGitChangesCheck(entry);
        return { ...entry.session };
    }
    refreshGitChanges() {
        this.sessions.forEach(entry => {
            this.checkGitChangesNow(entry);
        });
    }
    emitUpdateDebounced() {
        if (this.updateTimeout)
            clearTimeout(this.updateTimeout);
        this.updateTimeout = setTimeout(() => {
            this.emit('sessionUpdate', this.getSessions());
            this.updateTimeout = null;
        }, SESSION_UPDATE_DEBOUNCE_MS);
    }
    scheduleGitChangesCheck(entry) {
        if (entry.gitCheckTimeout)
            clearTimeout(entry.gitCheckTimeout);
        entry.gitCheckTimeout = setTimeout(() => {
            entry.gitCheckTimeout = null;
            void this.checkGitChanges(entry);
        }, GIT_CHANGE_CHECK_DEBOUNCE_MS);
    }
    checkGitChangesNow(entry) {
        this.clearScheduledGitChangesCheck(entry);
        void this.checkGitChanges(entry);
    }
    clearScheduledGitChangesCheck(entry) {
        if (!entry.gitCheckTimeout)
            return;
        clearTimeout(entry.gitCheckTimeout);
        entry.gitCheckTimeout = null;
    }
    checkGitChanges(entry) {
        if (entry.session.shellType === 'ssh') {
            if (entry.session.gitChanges) {
                entry.session.gitChanges = false;
                this.emitUpdateDebounced();
            }
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            (0, node_child_process_1.exec)('git status --porcelain', { cwd: entry.session.cwd }, (err, stdout) => {
                const newGitChanges = !err && stdout.trim().length > 0;
                if (entry.session.gitChanges !== newGitChanges) {
                    entry.session.gitChanges = newGitChanges;
                    this.emitUpdateDebounced();
                }
                resolve();
            });
        });
    }
    removeSession(id) {
        const entry = this.sessions.get(id);
        if (!entry)
            return;
        this.clearScheduledGitChangesCheck(entry);
        this.sessions.delete(id);
        this.terminalEventParser.reset(id);
        this.emit('sessionUpdate', this.getSessions());
    }
    detachSession(id) {
        const entry = this.sessions.get(id);
        if (!entry)
            return null;
        const now = Date.now();
        if (entry.session.status !== 'detached')
            entry.statusChangedAt = now;
        entry.session.status = 'detached';
        entry.session.lastActivity = now;
        delete entry.session.terminalExitCode;
        delete entry.session.terminalExitReason;
        delete entry.session.terminalCaptureState;
        delete entry.session.terminalCaptureReason;
        entry.lastEffectiveUpdateAt = now;
        entry.lastTerminalUpdateAt = now;
        this.terminalEventParser.reset(id);
        this.emit('sessionUpdate', this.getSessions());
        this.scheduleGitChangesCheck(entry);
        return { ...entry.session };
    }
    getSession(id) {
        const entry = this.sessions.get(id);
        return entry ? { ...entry.session } : null;
    }
    getSessions() {
        return [...this.sessions.values()]
            .sort((a, b) => {
            const byNeedInput = sessionStatusPriority(a.session.status) - sessionStatusPriority(b.session.status);
            if (byNeedInput !== 0)
                return byNeedInput;
            const byStatusChangedAt = a.statusChangedAt - b.statusChangedAt;
            if (byStatusChangedAt !== 0)
                return byStatusChangedAt;
            return a.createdAt - b.createdAt;
        })
            .map(e => ({ ...e.session }));
    }
}
exports.SessionManager = SessionManager;
function sessionStatusPriority(status) {
    return status === 'needs_attention' ? 0 : 1;
}
