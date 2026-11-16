/* System test for server-side Aura through the real web UI. Needs the same env as live.system.test.js and a server
 * started with AURA_PROVIDER=mock (scripted provider) or a real provider. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const URL = process.env.ORION_URL, EMAIL = process.env.ORION_EMAIL, PW = process.env.ORION_PASSWORD;
const skip = !(URL && EMAIL && PW) && 'set ORION_URL, ORION_EMAIL, ORION_PASSWORD';

test('Aura via the ORION server', { skip, timeout: 120000 }, async (t) => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear()); await page.reload();
  await page.click('[data-action="login-open"]'); await page.fill('#lg-e', EMAIL); await page.fill('#lg-p', PW); await page.click('#lg-go');
  await page.waitForSelector('.tile', { timeout: 15000 });
  await page.waitForFunction(() => ORION.app.source.aura && ORION.app.source.aura.available);
  const ask = async (q) => {
    const n = await page.locator('.m-a').count();
    await page.fill('#au-in', q); await page.press('#au-in', 'Enter');
    await page.waitForFunction((n) => { const m = ORION.app.ui.auraMsgs; const a = m[m.length - 1]; return document.querySelectorAll('.m-a').length > n && a && (a.status === 'done' || a.status === 'error'); }, n, { timeout: 20000 });
    return page.evaluate(() => { const m = ORION.app.ui.auraMsgs; return m[m.length - 1]; });
  };
  await t.test('answer comes from server tools, not basic mode', async () => {
    await page.evaluate(() => { location.hash = 'aura'; }); await page.waitForSelector('#au-in');
    const m = await ask('what is the temperature?');
    assert.equal(m.mode, 'ai'); assert.match(m.text, /temperature_c/); assert.ok(m.steps.length >= 1);
  });
  await t.test('emergency words get the safety preamble first', async () => {
    const m = await ask('there is smoke in the kitchen');
    assert.match(m.text, /^If there is a real fire.*112/);
  });
  await t.test('command suggestion needs explicit confirmation', async () => {
    await ask('please turn on the fan');
    await page.waitForSelector('#md-ok');
    assert.match(await page.locator('#modal').innerText(), /Aura suggests: fan on/);
    await page.click('#md-ok');
    await page.waitForSelector('.toast');
    await page.waitForFunction(() => ORION.app.snap.commands[0] && ORION.app.snap.commands[0].origin === 'aura_proposal', null, { timeout: 15000 });
  });
  assert.deepEqual(errors, []);
  await browser.close();
});
