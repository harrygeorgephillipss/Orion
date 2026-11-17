/* Home screen when no hardware is connected: the "Connect your ESP32" guide and the server's simulated home
 * (start, change scenario, remove), against a fake ORION server. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { chromium } = require('playwright');

const URL = 'file://' + path.join(__dirname, '..', '..', 'index.html');
const SERVER = 'http://orion.test';

test('connect guide → simulated home → scenario → remove', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const seen = [], demo = { running: false, scenario: null, scenarios: ['normal', 'flame'], gateway_id: 'esp32-sim' };
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.route(SERVER + '/**', async (route) => {
      const req = route.request(), u = new globalThis.URL(req.url()), body = req.postData() ? JSON.parse(req.postData()) : null;
      seen.push(req.method() + ' ' + u.pathname);
      const json = (o, s) => route.fulfill({ status: s || 200, contentType: 'application/json', body: JSON.stringify(o) });
      if (u.pathname === '/api/v1/auth/refresh') return json({ detail: 'no' }, 401);
      if (u.pathname === '/api/v1/auth/login') return json({ access_token: 'a', user: { id: 'u1', email: 'o@example.com', name: 'Owner', role: 'owner' } });
      if (u.pathname === '/api/v1/overview') return json({ status: 'empty', at: Date.now(), message: 'No devices are registered yet.' });
      if (u.pathname === '/api/v1/devices/demo' && req.method() === 'GET') return json(demo);
      if (u.pathname === '/api/v1/devices/demo') { Object.assign(demo, { running: true, scenario: 'normal' }); return json({ running: true }, 201); }
      if (u.pathname === '/api/v1/devices/demo/scenario') { demo.scenario = body.scenario; return json({ running: true, scenario: body.scenario }); }
      if (u.pathname === '/api/v1/devices/esp32-sim' && req.method() === 'DELETE') { Object.assign(demo, { running: false, scenario: null }); return json({ ok: true }); }
      if (u.pathname === '/api/v1/aura/status') return json({ available: false });
      return json({});
    });
    await page.addInitScript((s) => { localStorage.setItem('orion.server', JSON.stringify(s)); localStorage.setItem('orion.mode', JSON.stringify('live')); }, SERVER);
    await page.goto(URL);
    await page.waitForFunction(() => window.ORION && ORION.app && ORION.app.snap.status === 'auth');
    await page.evaluate(() => ORION.app.source.login('o@example.com', 'pw'));
    await page.waitForSelector('.connect >> text=Connect your ORION hardware');
    assert.match(await page.textContent('.connect'), /ORION-Setup-/);
    await page.click('button[data-action="demo-start"]');
    await page.waitForSelector('.sim-ctl');
    assert.ok(seen.includes('POST /api/v1/devices/demo'));
    await page.click('.sim-ctl button[data-s="flame"]');
    await page.waitForSelector('.sim-ctl button[data-s="flame"].on');
    await page.click('button[data-action="demo-stop"]');
    await page.click('.md-a button:has-text("Remove")');
    await page.waitForFunction(() => !document.querySelector('.sim-ctl'));
    assert.ok(seen.includes('DELETE /api/v1/devices/esp32-sim'));
    await page.click('button[data-action="connect-esp"]');
    await page.waitForFunction(() => location.hash === '#config');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
