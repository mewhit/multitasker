const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildConfig, applyConfig } = require('./slack-config.cjs');

test('package only Slack application settings and preserve installed overrides', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multitasker-slack-test-'));
  const local = path.join(directory, '.env');
  const absent = path.join(directory, 'absent.env');
  try {
    fs.writeFileSync(local, 'SLACK_CLIENT_ID="local-id"\nSLACK_CLIENT_SECRET=local-secret\nSLACK_USER_TOKEN=private-token\nSLACK_TEAM_ID=private-team\n');
    const config = buildConfig(local, {});
    assert.deepEqual(config, { SLACK_CLIENT_ID: 'local-id', SLACK_CLIENT_SECRET: 'local-secret' });
    assert.equal(buildConfig(local, { SLACK_CLIENT_SECRET: 'build-secret' }).SLACK_CLIENT_SECRET, 'build-secret');
    assert.throws(() => buildConfig(absent, {}), /SLACK_CLIENT_ID and SLACK_CLIENT_SECRET/);
    const fresh = {};
    applyConfig(config, absent, fresh);
    assert.deepEqual(fresh, config);
    const existing = { SLACK_CLIENT_ID: 'environment-id' };
    applyConfig(config, local, existing);
    assert.deepEqual(existing, { SLACK_CLIENT_ID: 'environment-id' });
    assert(fs.readFileSync(local, 'utf8').includes('SLACK_USER_TOKEN=private-token'));
  } finally {
    fs.unlinkSync(local);
    fs.rmdirSync(directory);
  }
});
