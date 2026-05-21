const fs = require('node:fs');
const path = require('node:path');

const debugLogDirectory = path.join(__dirname, '..', 'debug-log');

try {
  fs.rmSync(debugLogDirectory, { recursive: true, force: true });
  fs.mkdirSync(debugLogDirectory, { recursive: true });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to flush debug logs at ${debugLogDirectory}: ${message}`);
  process.exitCode = 1;
}
