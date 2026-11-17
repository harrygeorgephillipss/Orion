/* When the server's Claude call fails (rejected key, no credit, network), Aura still answers from its built-in
 * offline mode with the real readings, and says why. Fake ORION server. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { chromium } = require('playwright');

const URL = 'file://' + path.join(__dirname, '..', '..', 'index.html');
const SERVER = 'http://orion.test';

test('Claude rejected → offline answer with the reason', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route(SERVER + '/**', async (route) => {
      const u = new globalThis.URL(route.request().url()).pathname;
      const json = (o, s) => route.fulfill({ status: s || 200, contentType: 'application/json', body: JSON.stringify(o) });
      if (u.endsWith('/auth/refresh')) return json({ access_token: 'a', user: { id: 'u', name: 'Owner', email: 'o@example.com', role: 'owner' } });
      if (u.endsWith('/overview')) return json({ status: 'empty', at: Date.now() });
      if (u.endsWith('/aura/status')) return json({ available: true, provider: 'anthropic' });
      if (u.endsWith('/aura/chat')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"step","kind":"status","text":"Checking"}\n\ndata: {"type":"error","code":"auth","message":"The AI provider rejected the server\'s API key."}\n\n' });
      return json({});
    });
    await page.addInitScript((s) => { localStorage.setItem('orion.server', JSON.stringify(s)); localStorage.setItem('orion.mode', JSON.stringify('live')); }, SERVER);
    await page.goto(URL);
    await page.waitForFunction(() => window.ORION && ORION.auraAI && ORION.auraAI.serverOn && ORION.app.source.user);
    await page.evaluate(() => { location.hash = 'aura'; });
    await page.fill('#au-in', 'is everything ok?');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => { const m = ORION.app.ui.auraMsgs.filter((x) => x.role !== 'user').pop(); return m && m.status === 'done'; }, null, { timeout: 15000 });
    const m = await page.evaluate(() => ORION.app.ui.auraMsgs.filter((x) => x.role !== 'user').pop());
    assert.equal(m.mode, 'basic');
    assert.match(m.text, /API key was rejected/);
    assert.match(m.text, /offline mode/);
  } finally { await browser.close(); }
});
