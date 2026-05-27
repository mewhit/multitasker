import fs from 'node:fs';
import path from 'node:path';
import { SERVER_ENV_FILE_NAMES } from './constants';

export function getServerEnvValue(key: string): string {
  const processValue = process.env[key];
  if (typeof processValue === 'string' && processValue.trim()) return processValue.trim();
  const fileValue = readServerEnvFromDisk()[key];
  return typeof fileValue === 'string' ? fileValue.trim() : '';
}

export function readServerEnvFromDisk(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const fileName of SERVER_ENV_FILE_NAMES) {
    const candidates = [
      path.join(process.cwd(), fileName),
      path.join(__dirname, '..', fileName),
    ];
    const envPath = candidates.find(candidate => fs.existsSync(candidate));
    if (envPath) Object.assign(env, readEnvFile(envPath));
  }
  return env;
}

export function readEnvFile(envPath: string): Record<string, string> {
  return parseEnvContent(fs.readFileSync(envPath, 'utf8'));
}

export function parseEnvContent(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('#')) continue;

    const equalsIndex = trimmedLine.indexOf('=');
    if (equalsIndex <= 0) continue;

    const key = trimmedLine.slice(0, equalsIndex).trim();
    const value = unquoteEnvValue(trimmedLine.slice(equalsIndex + 1).trim());
    if (key) env[key] = value;
  }
  return env;
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
