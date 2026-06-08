const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..');
const debugLogDirectories = [
  path.join(projectRoot, 'debug-log'),
  path.join(projectRoot, '.tmp', 'desktop'),
  path.join(projectRoot, '.tmp', 'http-server'),
];

try {
  for (const debugLogDirectory of debugLogDirectories) {
    fs.rmSync(debugLogDirectory, { recursive: true, force: true });
    fs.mkdirSync(debugLogDirectory, { recursive: true });
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to flush debug logs: ${message}`);
  process.exitCode = 1;
}
