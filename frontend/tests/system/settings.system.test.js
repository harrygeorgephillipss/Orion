/* System test of the server-backed Settings screens (needs the same env as live.system.test.js, owner account). */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { chromium } = require('playwright');

const URL = process.env.ORION_URL, EMAIL = process.env.ORION_EMAIL, PW = process.env.ORION_PASSWORD, CTL = process.env.ORION_SIM_CTL;
const skip = !(URL && EMAIL && PW && CTL) && 'set ORION_URL, ORION_EMAIL, ORION_PASSWORD, ORION_SIM_CTL';

test('settings: contacts reach the gateway, people, notifications, devices, audit', { skip, timeout: 180000 }, async (t) => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(URL); await page.evaluate(() => localStorage.clear()); await page.reload();
  await page.click('[data-action="login-open"]'); await page.fill('#lg-e', EMAIL); await page.fill('#lg-p', PW); await page.click('#lg-go');
  await page.waitForSelector('.tile', { timeout: 15000 });
  await page.evaluate(() => { location.hash = 'config'; });
  await page.waitForSelector('[data-sec="contacts"]', { timeout: 15000 });
  const stamp = String(Date.now()).slice(-6);

  await t.test('all sections render for the owner', async () => {
    for (const s of ['account', 'contacts', 'people', 'devices', 'audit']) assert.equal(await page.locator(`[data-sec="${s}"]`).count(), 1, s);
  });
  await t.test('contact added in the app is used by the gateway for flame SMS', async () => {
    const f = page.locator('form[data-la="add-contact"]');
    await f.locator('[name=name]').fill('Test contact ' + stamp);
    await f.locator('[name=phone]').fill('+9198123456' + stamp.slice(-2));
    await f.locator('[name=call]').check();
    await f.locator('button[type=submit]').click();
    await page.waitForSelector(`text=Test contact ${stamp}`);
    await page.waitForTimeout(1500);
    fs.writeFileSync(CTL, 'flame\n');
    await page.waitForFunction((d) => (ORION.app.snap.gsmAttempts || []).some((a) => a.destination.endsWith(d) && a.type === 'sms'), stamp.slice(-2), { timeout: 30000 });
    fs.writeFileSync(CTL, 'normal\n');
  });
  await t.test('add a person and change their role', async () => {
    const f = page.locator('form[data-la="add-user"]');
    await f.locator('[name=name]').fill('Helper ' + stamp);
    await f.locator('[name=email]').fill(`helper${stamp}@example.com`);
    await f.locator('[name=password]').fill('Helper-Pass-' + stamp);
    await f.locator('button[type=submit]').click();
    const row = page.locator('tr', { hasText: `helper${stamp}@example.com` });
    await row.waitFor();
    await row.locator('select[name=role]').selectOption('viewer');
    await row.locator('[data-la="save-user"]').click();
    await page.waitForFunction((e) => [...document.querySelectorAll('tr')].some((r) => r.textContent.includes(e) && r.querySelector('select') && r.querySelector('select').value === 'viewer'), `helper${stamp}@example.com`);
  });
  await t.test('notification preferences save', async () => {
    const f = page.locator('form[data-la="push"]');
    await f.locator('[name=degraded]').uncheck();
    await f.locator('button[type=submit]').click();
    await f.locator('.ls-msg', { hasText: 'Saved.' }).waitFor();
    await f.locator('[name=degraded]').check(); await f.locator('button[type=submit]').click();
  });
  await t.test('register a gateway shows the broker password once, then remove it', async () => {
    await page.locator('[data-sec="devices"] summary').click();
    const f = page.locator('form[data-la="register"]');
    for (const [n, v] of [['gw', 'gw' + stamp], ['ctrl', 'ct' + stamp], ['gsm', 'gs' + stamp], ['mq2', 'mq' + stamp], ['flame', 'fl' + stamp], ['water', 'wa' + stamp], ['dht', 'dh' + stamp]]) await f.locator(`[name=${n}]`).fill(v);
    await f.locator('[name=sim]').check();
    await f.locator('button[type=submit]').click();
    await page.waitForSelector('[data-sc="code"]');
    await page.fill('[data-sc="host"]', '192.168.1.10');
    const decode = (c) => Buffer.from(c, 'base64url').toString().split('|');
    const f1 = decode(await page.inputValue('[data-sc="code"]'));
    assert.deepEqual([f1[0], f1[1], f1[2], f1[4], f1[6]], ['ORION1', '192.168.1.10', '1883', 'gw' + stamp, 'ct' + stamp]);
    assert.ok(f1[5].length >= 24, 'password inside the code');
    await page.locator(`[data-la="rotate"][data-id="gw${stamp}"]`).click();
    await page.waitForSelector('text=New setup code for gw' + stamp);
    await page.fill('[data-sc="host"]', '192.168.1.10');
    const f2 = decode(await page.inputValue('[data-sc="code"]'));
    assert.notEqual(f2[5], f1[5], 'new setup code has a new password');
    await page.locator(`[data-la="del-device"][data-id="gw${stamp}"]`).click();
    await page.waitForFunction((id) => !document.querySelector(`[data-la="del-device"][data-id="${id}"]`), 'gw' + stamp);
  });
  await t.test('activity log lists what we just did; remove the test contact', async () => {
    await page.evaluate(() => ORION.app.mountView());
    await page.waitForSelector('[data-sec="audit"]');
    const txt = await page.locator('[data-sec="audit"]').textContent();
    for (const a of ['contact.create', 'user.create', 'device.register', 'device.delete']) assert.ok(txt.includes(a), a);
    const row = page.locator('[data-sec="contacts"] tr', { hasText: 'Test contact ' + stamp });
    await row.locator('[data-la="del-contact"]').click();
    await page.waitForFunction((n) => !document.querySelector('[data-sec="contacts"]').textContent.includes(n), 'Test contact ' + stamp);
  });
  assert.deepEqual(errors, []);
  await browser.close();
});
