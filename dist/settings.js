"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadSettings = loadSettings;
exports.saveSettings = saveSettings;
exports.loadSessions = loadSessions;
exports.saveSessions = saveSessions;
const electron_1 = require("electron");
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const DEFAULT_SETTINGS = {
    reviewTool: 'code {path}',
    idleTimeout: 800,
    defaultShell: process.platform === 'win32' ? 'powershell' : 'bash',
};
function getSettingsPath() {
    return node_path_1.default.join(electron_1.app.getPath('userData'), 'settings.json');
}
function getSessionsPath() {
    return node_path_1.default.join(electron_1.app.getPath('userData'), 'sessions.json');
}
function loadSettings() {
    try {
        const raw = node_fs_1.default.readFileSync(getSettingsPath(), 'utf-8');
        return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    }
    catch {
        return { ...DEFAULT_SETTINGS };
    }
}
function saveSettings(settings) {
    node_fs_1.default.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2));
}
function loadSessions() {
    try {
        const raw = node_fs_1.default.readFileSync(getSessionsPath(), 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return [];
    }
}
function saveSessions(sessions) {
    node_fs_1.default.writeFileSync(getSessionsPath(), JSON.stringify(sessions, null, 2));
}
