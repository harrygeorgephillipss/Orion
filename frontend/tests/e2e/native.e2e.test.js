/* Android bridge (native.js) tested in Chromium with a fake Capacitor runtime and a fake ORION server.
 * Covers the app's own logic; it does not replace testing on a real phone. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { chromium } = require('playwright');

const URL = 'file://' + path.join(__dirname, '..', '..', 'index.html');
const SERVER = 'http://orion.test';

function fakeCapacitor() {
  const store = JSON.parse(sessionStorage.getItem('fakePrefs') || '{}');
  const calls = (window.__calls = []);
  const listeners = (window.__listeners = {});
  const mk = (name, methods) => new Proxy(methods, { get: (t, k) => t[k] || (async (...a) => { calls.push([name, k, a]); return {}; }) });
  const on = (name) => (ev, cb) => { (listeners[name + ':' + ev] = listeners[name + ':' + ev] || []).push(cb); return Promise.resolve({ remove() {} }); };
  const plugins = {
    Preferences: mk('Preferences', {
      get: async ({ key }) => ({ value: store[key] ?? null }),
      set: async ({ key, value }) => { store[key] = value; sessionStorage.setItem('fakePrefs', JSON.stringify(store)); },
      remove: async ({ key }) => { delete store[key]; sessionStorage.setItem('fakePrefs', JSON.stringify(store)); },
    }),
    PushNotifications: mk('PushNotifications', {
      addListener: on('Push'),
      checkPermissions: async () => ({ receive: 'prompt' }),
      requestPermissions: async () => ({ receive: 'granted' }),
      register: async () => { calls.push(['Push', 'register']); setTimeout(() => (listeners['Push:registration'] || []).forEach((cb) => cb({ value: 'fcm-token-' + 'x'.repeat(30) })), 10); },
      createChannel: async (c) => { calls.push(['Push', 'createChannel', c]); },
    }),
    Network: mk('Network', { addListener: on('Network') }),
    SpeechRecognition: mk('SpeechRecognition', { addListener: on('Speech'), available: async () => ({ available: true }), requestPermissions: async () => ({ speechRecognition: 'granted' }) }),
    TextToSpeech: mk('TextToSpeech', {}),
  };
  window.Capacitor = { isNativePlatform: () => true, registerPlugin: (n) => plugins[n] };
}

async function open(saveServer) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const seen = [];
  await page.route(SERVER + '/**', async (route) => {
    const req = route.request(), u = new globalThis.URL(req.url()), body = req.postData() ? JSON.parse(req.postData()) : null;
    seen.push({ path: u.pathname, body });
    const json = (o, s) => route.fulfill({ status: s || 200, contentType: 'application/json', body: JSON.stringify(o) });
    const user = { id: 'u1', email: 'a@example.com', name: 'Asha', role: 'member' };
    if (u.pathname === '/api/v1/auth/refresh') return body && body.refresh_token === 'rt-1' ? json({ access_token: 'acc-2', refresh_token: 'rt-2', user }) : json({ detail: 'No refresh token' }, 401);
    if (u.pathname === '/api/v1/auth/login') return json({ access_token: 'acc-1', refresh_token: body.client === 'mobile' ? 'rt-1' : undefined, user });
    if (u.pathname === '/api/v1/overview') return json({ status: 'empty', at: Date.now(), message: 'No devices are registered yet.' });
    if (u.pathname === '/api/v1/config') return json({});
    if (u.pathname === '/api/v1/aura/status') return json({ available: false, reason: 'test' });
    return json({ ok: true });
  });
  await page.addInitScript(fakeCapacitor);
  if (saveServer) await page.addInitScript((s) => localStorage.setItem('orion.server', JSON.stringify(s)), SERVER);
  await page.goto(URL);
  await page.waitForFunction(() => window.ORION && ORION.app && ORION.app.ev);
  return { browser, page, seen };
}

test('native: without a saved server the app does not treat its own origin as the server', async () => {
  const { browser, page } = await open(false);
  assert.equal(await page.evaluate(() => ORION.app.mode), 'live');
  assert.equal(await page.evaluate(() => ORION.app.source.base), '');
  assert.equal(await page.evaluate(() => ORION.app.snap.status), 'unconfigured');
  await browser.close();
});

test('native: mobile sign-in, token storage, push, network, speech, restart', async () => {
  const { browser, page, seen } = await open(true);
  await page.waitForFunction(() => ORION.app.snap.status === 'auth');
  const r = await page.evaluate(() => ORION.app.source.login('a@example.com', 'pw'));
  assert.equal(r.ok, true);
  const login = seen.find((x) => x.path === '/api/v1/auth/login');
  assert.equal(login.body.client, 'mobile');
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('fakePrefs'))['orion.refresh']), 'rt-1');
  await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'Push' && c[1] === 'register'));
  await page.waitForTimeout(200);
  const reg = seen.find((x) => x.path === '/api/v1/push/register');
  assert.ok(reg && reg.body.token.startsWith('fcm-token-') && reg.body.platform === 'android');
  const chans = await page.evaluate(() => window.__calls.filter((c) => c[1] === 'createChannel').map((c) => c[2]));
  assert.deepEqual(chans.map((c) => [c.id, c.importance]), [['orion_emergency', 5], ['orion_alerts', 4]]);
  assert.ok(await page.evaluate(() => (window.__listeners['Network:networkStatusChange'] || []).length === 1));
  assert.equal(await page.evaluate(() => ORION.auraAI.cap.host), 'android');
  assert.equal(await page.evaluate(() => ORION.auraAI.cap.dict && ORION.auraAI.cap.dict.kind), 'native');
  // app restart: the stored refresh token signs in again and is rotated
  await page.reload();
  await page.waitForFunction(() => ORION.app.source.user && ORION.app.source.user.name === 'Asha');
  const ref = seen.filter((x) => x.path === '/api/v1/auth/refresh').pop();
  assert.deepEqual(ref.body, { refresh_token: 'rt-1', client: 'mobile' });
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('fakePrefs'))['orion.refresh']), 'rt-2');
  // sign-out unregisters push and forgets the token
  await page.evaluate(() => ORION.app.source.logout());
  assert.ok(seen.some((x) => x.path === '/api/v1/push/unregister'));
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('fakePrefs'))['orion.refresh']), undefined);
  await browser.close();
});
