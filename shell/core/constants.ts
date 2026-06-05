import * as fs from 'fs';
import * as path from 'path';

export const DEFAULT_PORT = 4321;
export const DEFAULT_HOST = '127.0.0.1';
export const PROTOCOL_VERSION = 1;

export const PORT = parseInt(process.env['SHELL_PORT'] ?? '', 10) || DEFAULT_PORT;
export const HOST = process.env['SHELL_HOST'] ?? DEFAULT_HOST;
export const AUTH_TOKEN = process.env['SHELL_AUTH_TOKEN'] ?? '';

export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 30;

function existsFile(p: string | undefined): boolean {
  if (!p) return false;
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

let cachedDefaultShell: string | null = null;

export function defaultShell(): string {
  if (cachedDefaultShell) return cachedDefaultShell;
  const override = process.env['SHELL_COMMAND'];
  if (override && override.trim()) {
    cachedDefaultShell = override.trim();
    return cachedDefaultShell;
  }
  if (process.platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
    const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows';
    // Prefer PowerShell 7+ (pwsh.exe) which has proper ConPTY support.
    // Windows PowerShell 5.1 (powershell.exe) freezes after a few keystrokes
    // inside ConPTY because of PSReadLine bugs.
    const candidates: string[] = [
      path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
      path.join(programFiles, 'PowerShell', '6', 'pwsh.exe'),
      path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      process.env['ComSpec'] ?? path.join(systemRoot, 'System32', 'cmd.exe'),
    ];
    for (const candidate of candidates) {
      if (existsFile(candidate)) {
        cachedDefaultShell = candidate;
        return candidate;
      }
    }
    cachedDefaultShell = 'cmd.exe';
    return cachedDefaultShell;
  }
  cachedDefaultShell = process.env['SHELL'] ?? '/bin/bash';
  return cachedDefaultShell;
}

/** Default args for a given shell, mainly to suppress logos / banners. */
export function defaultShellArgs(shell: string): string[] {
  if (process.env['SHELL_ARGS']) {
    // Allow override; split on whitespace, no quote handling (advanced users only).
    return process.env['SHELL_ARGS'].split(/\s+/).filter(Boolean);
  }
  const base = shell.toLowerCase();
  if (base.endsWith('pwsh.exe') || base.endsWith('pwsh')) return ['-NoLogo'];
  if (base.endsWith('powershell.exe')) {
    // Windows PowerShell 5.1's PSReadLine freezes inside ConPTY after a
    // few keystrokes (input handler deadlocks). Removing PSReadLine on
    // start avoids the freeze; the user loses syntax highlighting and
    // history search but the prompt stays responsive.
    return ['-NoLogo', '-NoProfile', '-NoExit', '-Command', 'Remove-Module PSReadLine -ErrorAction SilentlyContinue'];
  }
  return [];
}
