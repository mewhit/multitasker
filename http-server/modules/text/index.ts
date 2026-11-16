import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { HttpModule } from '../../core/types';
import { writeJsonResponse } from '../../core/body';
import { getErrorMessage } from '../../core/util';
import { isRecord, readStringField } from '../../utils/payload';
import { loadSettings } from '../../../shared/settings';

interface TextContextMessage {
  role: 'user' | 'assistant';
  text: string;
}

interface CodexInvocation {
  executable: string;
  prefixArgs: string[];
}

const CODEX_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_TEXT_INPUT_LENGTH = 100_000;
const MAX_CONTEXT_MESSAGES = 30;
const MAX_CODEX_OUTPUT_BYTES = 200_000;

export const textModule: HttpModule = {
  name: 'text',
  routes() {
    return [{
      method: 'POST',
      path: '/text',
      async handler({ payload, response }) {
        if (!loadSettings().installedPlugins.includes('ai')) {
          writeJsonResponse(response, 403, { ok: false, error: 'Install the AI plugin to use text suggestions.' });
          return;
        }
        if (!isRecord(payload)) {
          writeJsonResponse(response, 400, { ok: false, error: 'invalid_request' });
          return;
        }

        const instruction = readStringField(payload, 'instruction').trim();
        const text = readStringField(payload, 'text');
        if (!instruction) {
          writeJsonResponse(response, 400, { ok: false, error: 'instruction is required' });
          return;
        }
        if (instruction.length > MAX_TEXT_INPUT_LENGTH || text.length > MAX_TEXT_INPUT_LENGTH) {
          writeJsonResponse(response, 400, { ok: false, error: 'instruction or text is too long' });
          return;
        }

        const context = readTextContext(payload['context']);
        try {
          const result = await runCodexText(instruction, text, context);
          writeJsonResponse(response, 200, { ok: true, text: result });
        } catch (error) {
          console.error(`Text rewrite failed: ${getErrorMessage(error)}`);
          writeJsonResponse(response, 500, { ok: false, error: getErrorMessage(error) });
        }
      },
    }];
  },
};

function readTextContext(value: unknown): TextContextMessage[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_CONTEXT_MESSAGES).flatMap((item): TextContextMessage[] => {
    if (!isRecord(item)) return [];
    const role = readStringField(item, 'role').trim();
    const text = readStringField(item, 'text').trim();
    if ((role !== 'user' && role !== 'assistant') || !text) return [];
    return [{ role, text: text.slice(0, MAX_TEXT_INPUT_LENGTH) }];
  });
}

async function runCodexText(instruction: string, text: string, context: TextContextMessage[]): Promise<string> {
  return runCodexPrompt(buildTextPrompt(instruction, text, context));
}

export async function runCodexPrompt(prompt: string, schema?: object): Promise<string> {
  const outputDirectory = path.resolve(process.cwd(), '.tmp', 'text');
  await fs.promises.mkdir(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, `${randomUUID()}.txt`);
  const schemaPath = schema ? `${outputPath}.schema.json` : undefined;
  const invocation = resolveCodexInvocation();

  try {
    if (schemaPath) await fs.promises.writeFile(schemaPath, JSON.stringify(schema));
    await spawnCodex(invocation, outputPath, prompt, schemaPath);
    const stats = await fs.promises.stat(outputPath);
    if (stats.size > MAX_CODEX_OUTPUT_BYTES) throw new Error('Codex returned too much text.');
    const result = (await fs.promises.readFile(outputPath, 'utf8')).trim();
    if (!result) throw new Error('Codex returned an empty response.');
    return result;
  } finally {
    await fs.promises.rm(outputPath, { force: true }).catch(() => undefined);
    if (schemaPath) await fs.promises.rm(schemaPath, { force: true }).catch(() => undefined);
  }
}

function resolveCodexInvocation(): CodexInvocation {
  const configuredPath = process.env['MULTITASKER_CODEX_PATH']?.trim();
  if (configuredPath) {
    if (configuredPath.toLowerCase().endsWith('.js')) return { executable: process.execPath, prefixArgs: [configuredPath] };
    if (process.platform === 'win32' && configuredPath.toLowerCase().endsWith('.cmd')) {
      return { executable: process.env['ComSpec'] || 'cmd.exe', prefixArgs: ['/d', '/s', '/c', configuredPath] };
    }
    return { executable: configuredPath, prefixArgs: [] };
  }

  if (process.platform === 'win32') {
    const candidates = [
      path.join(path.dirname(process.execPath), 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
      path.join(process.env['APPDATA'] || '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    ];
    const scriptPath = candidates.find(candidate => fs.existsSync(candidate));
    if (scriptPath) return { executable: process.execPath, prefixArgs: [scriptPath] };
    return { executable: process.env['ComSpec'] || 'cmd.exe', prefixArgs: ['/d', '/s', '/c', 'codex.cmd'] };
  }
  return { executable: 'codex', prefixArgs: [] };
}

function buildTextPrompt(instruction: string, text: string, context: TextContextMessage[]): string {
  const transcript = context.length > 0
    ? context.map(message => `${message.role === 'user' ? 'User' : 'Assistant'}:\n${message.text}`).join('\n\n')
    : '(none)';
  return [
    'You are a text rewriting assistant.',
    'Return only the finished text, without commentary, labels, or Markdown fences.',
    'Preserve the meaning and factual details unless the instruction explicitly asks you to change them.',
    'If source text is empty, draft text that follows the instruction.',
    '',
    'Conversation so far:',
    transcript,
    '',
    'Current instruction:',
    instruction,
    '',
    'Source text:',
    text || '(empty)',
  ].join('\n');
}

function spawnCodex(invocation: CodexInvocation, outputPath: string, prompt: string, schemaPath?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, [...invocation.prefixArgs,
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--color',
      'never',
      '--output-last-message',
      outputPath,
      ...(schemaPath ? ['--output-schema', schemaPath] : []),
      '-',
    ], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
    });

    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error('Codex timed out while rewriting the text.'));
    }, CODEX_TIMEOUT_MS);
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.once('error', error => finish(new Error(`Could not start Codex: ${getErrorMessage(error)}`)));
    child.once('exit', code => {
      if (code === 0) finish();
      else finish(new Error(`Codex exited with code ${code ?? 'unknown'}${stderr.trim() ? `: ${stderr.trim()}` : '.'}`));
    });
    child.stdin.on('error', error => finish(new Error(`Could not send the rewrite prompt to Codex: ${getErrorMessage(error)}`)));
    child.stdin.end(prompt);
  });
}
