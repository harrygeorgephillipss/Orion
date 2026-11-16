/* System test: browser → ORION server → MQTT → device simulator, all real processes.
 * Needs: server at ORION_URL, an account (ORION_EMAIL / ORION_PASSWORD) with member+ role, the simulator running,
 * and ORION_SIM_CTL = path of a FIFO the simulator reads scenario names from. Skipped otherwise.
 * See docs/TESTING.md for the exact commands. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { chromium } = require('playwright');

const URL = process.env.ORION_URL, EMAIL = process.env.ORION_EMAIL, PW = process.env.ORION_PASSWORD, CTL = process.env.ORION_SIM_CTL;
const skip = !(URL && EMAIL && PW && CTL) && 'set ORION_URL, ORION_EMAIL, ORION_PASSWORD, ORION_SIM_CTL';
const scenario = (s) => fs.writeFileSync(CTL, s + '\n');

test('live stack end-to-end', { skip, timeout: 240000 }, async (t) => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  scenario('normal');
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const sys = () => page.evaluate(() => ORION.app.ev && ORION.app.ev.system);
  const waitSys = (want, ms) => page.waitForFunction((w) => ORION.app.ev && ORION.app.ev.system === w, want, { timeout: ms || 30000 });

  await t.test('served page defaults to live mode and asks to sign in', async () => {
    assert.equal(await page.evaluate(() => ORION.app.mode), 'live');
    await page.waitForSelector('[data-action="login-open"]');
  });
  await t.test('sign in → live tiles labelled simulated', async () => {
    await page.click('[data-action="login-open"]');
    await page.fill('#lg-e', EMAIL);
    await page.fill('#lg-p', PW);
    await page.click('#lg-go');
    await page.waitForSelector('.tile', { timeout: 15000 });
    assert.equal(await page.locator('.tile').count(), 5);
    assert.equal(await page.locator('.tile .tag-demo').count(), 5);
    assert.match(await page.locator('#demoTxt').innerText(), /SIMULATED DEVICES/);
    await waitSys('NORMAL', 40000);
  });
  await t.test('flame → EMERGENCY, firmware actions + SMS attempt on the incident', async () => {
    scenario('flame');
    await waitSys('EMERGENCY', 20000);
    await page.waitForSelector('.alert.a-crit');
    await page.waitForFunction(() => { const i = ORION.app.snap.incidents.find((x) => x.type === 'flame' && x.state === 'active'); return i && i.actions.some((a) => /SMS/.test(a.action) && /^sent/.test(a.outcome)); }, null, { timeout: 30000 });
  });
  await t.test('acknowledge keeps the alert active', async () => {
    await page.click('.alert.a-crit button[data-action="ack"]');
    await page.click('#md-ok');
    await page.waitForFunction(() => ORION.app.snap.incidents.some((x) => x.type === 'flame' && x.state === 'active' && x.acknowledged_at));
    assert.equal(await sys(), 'EMERGENCY');
  });
  await t.test('flame ends → clears only after the clear-hold', async () => {
    scenario('normal');
    await page.waitForFunction(() => ORION.app.snap.incidents.some((x) => x.type === 'flame' && x.events.some((e) => /clear-hold started/.test(e.text))), null, { timeout: 15000 });
    assert.ok(await page.evaluate(() => ORION.app.snap.incidents.some((x) => x.type === 'flame' && x.state === 'active')));
    await waitSys('NORMAL', 40000);
  });
  await t.test('fan command: accepted → done · unconfirmed (never "verified")', async () => {
    await page.evaluate(() => { location.hash = 'devices'; });
    await page.waitForSelector('button[data-act="fan:on"]:not([disabled])');
    await page.click('button[data-act="fan:on"]');
    await page.click('#md-ok');
    await page.waitForFunction(() => ORION.app.snap.commands[0] && ORION.app.snap.commands[0].status === 'unknown', null, { timeout: 20000 });
  });
  await t.test('smoke: fan-off command rejected by the (simulated) controller interlock', async () => {
    scenario('smoke_warning');
    await waitSys('ATTENTION', 20000);
    await page.waitForSelector('button[data-act="fan:off"]:not([disabled])', { timeout: 20000 });
    await page.click('button[data-act="fan:off"]');
    await page.click('#md-ok');
    await page.waitForFunction(() => ORION.app.snap.commands[0] && ORION.app.snap.commands[0].status === 'rejected', null, { timeout: 20000 });
    scenario('normal');
  });
  await t.test('UNO link lost → one controller incident, sensors stale (not healthy)', async () => {
    scenario('uno_offline');
    await page.waitForFunction(() => ORION.app.snap.incidents.some((x) => x.type === 'controller' && x.state === 'active' && /uno/.test(x.source_id)), null, { timeout: 60000 });
    assert.notEqual(await sys(), 'NORMAL');
    assert.equal(await page.evaluate(() => ORION.app.snap.incidents.filter((x) => x.type === 'sensor_stale' && x.state === 'active').length), 0);
    scenario('normal');
    await waitSys('NORMAL', 60000);
  });
  assert.deepEqual(errors, []);
  await browser.close();
});
