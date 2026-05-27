import path from 'node:path';

export function normalizePathForCompare(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return path.normalize(trimmed).replace(/[\\/]+$/g, '').toLowerCase();
}

export function getLegacyAttachedTerminalPid(sessionId: string): number | undefined {
  const match = /^attached:(\d+):/.exec(sessionId);
  if (!match?.[1]) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}
