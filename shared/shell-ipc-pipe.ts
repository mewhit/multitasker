import * as os from 'os';
import * as path from 'path';

/**
 * Returns the OS-specific pipe / socket path used between the supervisor
 * and the gateway WS server. Can be overridden via `MULTITASKER_SHELL_PIPE`.
 *
 * On Windows we use a named pipe: `\\.\pipe\<name>`.
 * On *nix we use a Unix domain socket under the OS temp dir.
 */
export function ipcPipePath(): string {
  const override = process.env['MULTITASKER_SHELL_PIPE'];
  if (override && override.trim()) return override.trim();
  const name = 'multitasker-shell-supervisor';
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\${name}`;
  }
  return path.join(os.tmpdir(), `${name}.sock`);
}
