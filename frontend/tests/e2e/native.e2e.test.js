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
  const calls = (window.__calls = []);
  const listeners = (window.__listeners = {});
  const mk = (name, methods) => new Proxy(methods, { get: (t, k) => t[k] || (async (...a) => { calls.push([name, k, a]); return {}; }) });
  const on = (name) => (ev, cb) => { (listeners[name + ':' + ev] = listeners[name + ':' + ev] || []).push(cb); return Promise.resolve({ remove() {} }); };
  const plugins = {
    // App-private storage lives in the test runner (like Android's, it survives an app restart).
    Preferences: mk('Preferences', {
      get: async ({ key }) => ({ value: (await window.__prefs('get', key)) ?? null }),
      set: async ({ key, value }) => { await window.__prefs('set', key, value); },
      remove: async ({ key }) => { await window.__prefs('remove', key); },
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
  const tokens = { current: null, n: 0 };
  const prefs = {};
  await page.exposeFunction('__prefs', (op, key, value) => { if (op === 'set') prefs[key] = value; else if (op === 'remove') delete prefs[key]; return prefs[key] ?? null; });
  await page.route(SERVER + '/**', async (route) => {
    const req = route.request(), u = new globalThis.URL(req.url()), body = req.postData() ? JSON.parse(req.postData()) : null;
    seen.push({ path: u.pathname, body });
    const json = (o, s) => route.fulfill({ status: s || 200, contentType: 'application/json', body: JSON.stringify(o) });
    const user = { id: 'u1', email: 'a@example.com', name: 'Asha', role: 'member' };
    if (u.pathname === '/api/v1/auth/refresh') {
      // Like the real server: the current token is accepted once and replaced by the next one.
      if (!body || body.refresh_token !== tokens.current) return json({ detail: 'Invalid refresh token' }, 401);
      tokens.current = 'rt-' + (++tokens.n);
      return json({ access_token: 'acc-' + tokens.n, refresh_token: tokens.current, user });
    }
    if (u.pathname === '/api/v1/auth/login') { tokens.current = 'rt-1'; tokens.n = 1; return json({ access_token: 'acc-1', refresh_token: body.client === 'mobile' ? 'rt-1' : undefined, user }); }
    if (u.pathname === '/api/v1/overview') return json({ status: 'empty', at: Date.now(), message: 'No devices are registered yet.' });
    if (u.pathname === '/api/v1/config') return json({});
    if (u.pathname === '/api/v1/aura/status') return json({ available: false, reason: 'test' });
    return json({ ok: true });
  });
  await page.addInitScript(fakeCapacitor);
  if (saveServer) await page.addInitScript((s) => localStorage.setItem('orion.server', JSON.stringify(s)), SERVER);
  await page.goto(URL);
  await page.waitForFunction(() => window.ORION && ORION.app && ORION.app.ev);
  return { browser, page, seen, tokens, prefs };
}

test('native: without a saved server the app does not treat its own origin as the server', async () => {
  const { browser, page } = await open(false);
  assert.equal(await page.evaluate(() => ORION.app.mode), 'live');
  assert.equal(await page.evaluate(() => ORION.app.source.base), '');
  assert.equal(await page.evaluate(() => ORION.app.snap.status), 'unconfigured');
  // first launch: the home screen asks for the server address and connecting switches the app to it
  await page.fill('#c-server', SERVER);
  await page.click('button[data-action="server-save"]');
  await page.waitForFunction((s) => ORION.app.source.base === s && ORION.app.snap.status === 'auth', SERVER);
  await browser.close();
});

test('native: mobile sign-in, token storage, push, network, speech, restart', async () => {
  const { browser, page, seen, tokens, prefs } = await open(true);
  await page.waitForFunction(() => ORION.app.snap.status === 'auth');
  const r = await page.evaluate(() => ORION.app.source.login('a@example.com', 'pw'));
  assert.equal(r.ok, true);
  const login = seen.find((x) => x.path === '/api/v1/auth/login');
  assert.equal(login.body.client, 'mobile');
  assert.equal(prefs['orion.refresh'], 'rt-1');
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
  const stored = prefs['orion.refresh'];
  assert.equal(stored, tokens.current);
  await page.reload();
  await page.waitForFunction(() => ORION.app.source.user && ORION.app.source.user.name === 'Asha');
  const ref = seen.filter((x) => x.path === '/api/v1/auth/refresh').pop();
  assert.deepEqual(ref.body, { refresh_token: stored, client: 'mobile' });
  assert.equal(prefs['orion.refresh'], tokens.current);
  assert.notEqual(tokens.current, stored);
  // sign-out unregisters push and forgets the token
  await page.evaluate(() => ORION.app.source.logout());
  assert.ok(seen.some((x) => x.path === '/api/v1/push/unregister'));
  assert.equal(prefs['orion.refresh'], undefined);
  await browser.close();
});

test('native voice loop: Android speech plugin events → Aura → Android text-to-speech → listening again', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.exposeFunction('__prefs', () => null);
    await page.addInitScript(fakeCapacitor);
    await page.addInitScript(() => localStorage.setItem('orion.mode', JSON.stringify('demo')));
    await page.goto(URL);
    await page.waitForFunction(() => window.ORION && ORION.auraAI && ORION.auraAI.cap.ready);
    assert.equal(await page.evaluate(() => ORION.auraAI.cap.dict.kind), 'native');
    await page.evaluate(() => { location.hash = 'aura'; });
    await page.click('#au-voice');
    await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'SpeechRecognition' && c[1] === 'start'));
    // what the real plugin does: start() already resolved; words arrive as events; then "stopped"
    await page.evaluate(() => {
      const fire = (ev, d) => (window.__listeners['Speech:' + ev] || []).forEach((cb) => cb(d));
      fire('partialResults', { matches: ['what is the'] });
      fire('partialResults', { matches: ['what is the temperature'] });
      fire('listeningState', { status: 'stopped' });
    });
    await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'TextToSpeech' && c[1] === 'speak'), null, { timeout: 15000 });
    const said = await page.evaluate(() => window.__calls.filter((c) => c[0] === 'TextToSpeech' && c[1] === 'speak').map((c) => c[2][0]));
    assert.match(said.map((x) => x.text).join(' '), /Temperature/);
    assert.equal(said[0].lang, 'en-IN');
    const q = await page.evaluate(() => ORION.app.ui.auraMsgs.filter((m) => m.role === 'user').map((m) => m.text));
    assert.deepEqual(q, ['what is the temperature']);
    // the mic is opened again for the next question
    await page.waitForFunction(() => window.__calls.filter((c) => c[0] === 'SpeechRecognition' && c[1] === 'start').length >= 2, null, { timeout: 10000 });
  } finally { await browser.close(); }
});
