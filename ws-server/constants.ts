export const MULTITASKER_BACKEND_URL =
  process.env['MULTITASKER_BACKEND_URL'] ?? 'http://127.0.0.1:39017';

export const MULTITASKER_INTEGRATION_ENABLED =
  (process.env['MULTITASKER_INTEGRATION'] ?? '1') !== '0';

export const MULTITASKER_SHELL_NAME_PREFIX =
  process.env['MULTITASKER_SHELL_NAME_PREFIX'] ?? 'shell';
