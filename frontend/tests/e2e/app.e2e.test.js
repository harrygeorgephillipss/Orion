/* End-to-end checks of the built single-file app in headless Chromium.
 * Run: npm run test:e2e  (needs Playwright; uses the Chromium it ships with) */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { chromium } = require('playwright');

const URL = 'file://' + path.join(__dirname, '..', '..', 'index.html');
const VIEWPORTS = [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1280, height: 900 }];
const ROUTES = ['home', 'history', 'alerts', 'devices', 'aura', 'config'];

let browser;
test.before(async () => { browser = await chromium.launch(); });
test.after(async () => { await browser.close(); });

async function open(vp, init) {
  const page = await browser.newPage({ viewport: vp || VIEWPORTS[2] });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.googleapis|ERR_NAME_NOT_RESOLVED|ERR_TUNNEL|net::/.test(m.text())) errors.push('console: ' + m.text()); });
  if (init) await page.addInitScript(init);
  await page.goto(URL);
  await page.waitForFunction(() => window.ORION && ORION.app && ORION.app.ev);
  return { page, errors };
}
const go = (page, r) => page.evaluate((r) => { location.hash = r; }, r).then(() => page.waitForTimeout(250));

for (const vp of VIEWPORTS) {
  test(`all routes render without errors or horizontal overflow at ${vp.width}px`, async () => {
    const { page, errors } = await open(vp);
    for (const r of ROUTES) {
      await go(page, r);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, `${r} overflows by ${overflow}px`);
      const failed = await page.locator('.sp-error').count();
      assert.equal(failed, 0, `${r} shows an error panel`);
    }
    assert.deepEqual(errors, []);
    await page.close();
  });
}

test('simulation mode is unmistakable: banner + every tile tagged simulated', async () => {
  const { page } = await open();
  assert.equal(await page.locator('#demoBar').isVisible(), true);
  assert.match(await page.locator('#demoBar').innerText(), /SIMULATION/);
  const tiles = await page.locator('.tile').count();
  assert.equal(tiles, 5);
  assert.equal(await page.locator('.tile .tag-demo').count(), tiles);
  await page.close();
});

test('every scenario reaches its expected state', async () => {
  const { page, errors } = await open();
  const expect = { normal: 'NORMAL', smoke_critical: 'EMERGENCY', flame: 'EMERGENCY', water: 'ATTENTION', dht_fault: 'DEGRADED', gsm_outage: 'DEGRADED', backend_error: 'OFFLINE', no_data: 'OFFLINE', loading: 'LOADING' };
  for (const [sc, want] of Object.entries(expect)) {
    // Fresh page per scenario so earlier incidents (and their clear-hold) don't leak into the next one.
    const p = sc === 'normal' ? page : (await open()).page;
    await p.evaluate((s) => ORION.app.source.setScenario(s), sc);
    await p.waitForFunction((w) => ORION.app.ev.system === w, want, { timeout: 15000 });
    if (p !== page) await p.close();
  }
  assert.deepEqual(errors, []);
  await page.close();
});

test('gateway offline → OFFLINE with last-known values, never NORMAL', async () => {
  const { page } = await open();
  await page.evaluate(() => { ORION.app.config.freshness.heartbeat_s = 5; ORION.app.config.freshness.sensor_s = 5; ORION.app.source.setScenario('gateway_offline'); });
  await page.waitForFunction(() => ORION.app.ev.system === 'OFFLINE', null, { timeout: 15000 });
  await go(page, 'home');
  assert.ok(await page.locator('.tile.is-stale').count() >= 1);
  await page.close();
});

test('live mode with no server shows no values and refuses commands', async () => {
  const { page, errors } = await open();
  await page.evaluate(() => ORION.app.setSource('live'));
  await go(page, 'home');
  assert.equal(await page.locator('.tile').count(), 0);
  assert.equal(await page.locator('#demoBar').isVisible(), false);
  const r = await page.evaluate(() => ORION.app.source.command({ actuator: 'fan', action: 'on', actor: 'x' }));
  assert.equal(r.ok, false);
  assert.deepEqual(errors, []);
  await page.close();
});

test('simulated command: confirm → toast → lifecycle visible on Devices', async () => {
  const { page } = await open();
  await go(page, 'devices');
  await page.click('button[data-act="fan:on"]');
  assert.match(await page.locator('#modal').innerText(), /Simulation/);
  await page.click('#md-ok');
  await page.waitForSelector('.toast');
  assert.match(await page.locator('.toast').first().innerText(), /queued/i);
  await page.waitForFunction(() => ORION.app.snap.commands[0] && ORION.app.snap.commands[0].status === 'unknown', null, { timeout: 15000 });
  await page.close();
});

test('history: series pills come from the registry and CSV is labelled SIMULATION', async () => {
  const { page } = await open();
  await go(page, 'history');
  assert.equal(await page.locator('#hi-pills .pill').count(), 5);
  await page.click('#hi-pills .pill:nth-child(4)');
  assert.match(await page.evaluate(() => ORION.app.ui.histSeries), /:temp$/);
  const csv = await page.evaluate(() => ORION.views._.buildCSV(ORION.app.ui.histSeries, Date.now() - 3600e3, Date.now()));
  const lines = csv.split('\n');
  assert.ok(lines.length > 10);
  assert.match(lines[1], /,simulation$/);
  await page.close();
});

test('saved settings from an older version are migrated, not discarded', async () => {
  const { page } = await open(null, () => localStorage.setItem('orion.config.v1', JSON.stringify({ version: 1, tempUnit: 'F', rooms: { 'mq2-hall': 'Lounge' }, freshness: { sensor_s: 9999 } })));
  const c = await page.evaluate(() => ORION.app.config);
  assert.equal(c.tempUnit, 'F');
  assert.equal(c.rooms['mq2-hall'], 'Lounge');
  assert.equal(c.freshness.sensor_s, 30, 'invalid value falls back to default');
  await page.close();
});

test('Aura basic mode answers from data and links to a real route', async () => {
  const { page, errors } = await open();
  await page.evaluate(() => ORION.app.source.setScenario('water'));
  await page.waitForTimeout(2500);
  await go(page, 'aura');
  await page.fill('#au-in', 'why did ORION raise an alert?');
  await page.press('#au-in', 'Enter');
  await page.waitForSelector('.m-a .m-body');
  const txt = await page.locator('.m-a').last().innerText();
  assert.match(txt, /SIMULATED/);
  const r = await page.evaluate(() => ORION.aura.answer('why alert', ORION.app.snap, ORION.app.ev, ORION.app.config));
  for (const l of r.links) assert.ok(ROUTES.includes(l.href.slice(1)), 'bad link ' + l.href);
  const emer = await page.evaluate(() => ORION.aura.answer('there is a real fire help', ORION.app.snap, ORION.app.ev, ORION.app.config));
  assert.match(emer.interp, /112/);
  assert.deepEqual(errors, []);
  await page.close();
});

test('an exception inside a view shows an error panel instead of a blank page', async () => {
  const { page } = await open();
  await page.evaluate(() => { ORION.views.devices.mount = () => { throw new Error('boom'); }; location.hash = 'devices'; });
  await page.waitForSelector('.sp-error');
  await go(page, 'home');
  assert.equal(await page.locator('.tile').count(), 5);
  await page.close();
});
