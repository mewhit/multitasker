import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const raw = fs.readFileSync(new URL('./legacyScript.ts', import.meta.url), 'utf8');
const script = JSON.parse(raw.slice(raw.indexOf('=') + 1).trim().replace(/;$/, ''));
const start = script.indexOf('document.getElementById("btn-settings").addEventListener');
const handler = script.slice(start, script.indexOf('document.getElementById("btn-cancel-settings")', start));

for (const failure of ['pending', 'rejected']) {
  test(`settings opens even with ${failure} Calendar status`, async () => {
    const elements = new Map();
    let click;
    let hidden = true;
    const document = {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, {
          addEventListener: (_, callback) => { click = callback; },
          classList: { remove: name => { if (id === 'settings-modal' && name === 'hidden') hidden = false; } },
        });
        return elements.get(id);
      },
    };
    const api = {
      getSettings: async () => ({ reviewTool: 'code {path}', annoyingNotifications: true }),
      getGoogleCalendarStatus: () => failure === 'pending' ? new Promise(() => {}) : Promise.reject(new Error('offline')),
    };
    new Function('document', 'api', 'setShellSelector', 'applyGoogleCalendarStatus', 'console', handler)(
      document, api, () => {}, () => {}, { error() {} },
    );
    await Promise.race([click(), new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Settings waited for Calendar')), 100);
      timer.unref();
    })]);
    assert.equal(hidden, false);
    assert.equal(elements.get('settings-annoying-notifications').checked, true);
    await new Promise(resolve => setImmediate(resolve));
    if (failure === 'rejected') assert.match(elements.get('google-calendar-status').textContent, /unavailable/);
  });
}
