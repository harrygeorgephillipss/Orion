/* Aura's server voice engine (Google Cloud speech via the ORION server) in the real app, with a fake microphone
 * (getUserMedia + MediaRecorder), a fake speaker (Audio) and a fake ORION server. Checks the app's logic only —
 * not real audio, recognition accuracy or voice quality (see docs/VOICE.md). */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { chromium } = require('playwright');

const URL = 'file://' + path.join(__dirname, '..', '..', 'index.html');
const SERVER = 'http://orion.test';

function fakeMedia(deny) {
  window.__played = []; window.__paused = 0; window.__spoken = [];
  delete window.AudioContext; delete window.webkitAudioContext;  // no level meter → finish by stop()
  navigator.mediaDevices.getUserMedia = async () => {
    if (deny) { const e = new Error('denied'); e.name = 'NotAllowedError'; throw e; }
    return { getTracks: () => [{ stop() {} }] };
  };
  window.MediaRecorder = class {
    static isTypeSupported(m) { return m.startsWith('audio/webm'); }
    constructor(s, o) { this.mimeType = (o && o.mimeType) || 'audio/webm'; this.state = 'inactive'; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable({ data: new Blob(['\x1aE\xdf\xa3 TEXT:' + (window.__words || 'what is the status')]) });
      setTimeout(() => this.onstop(), 5);
    }
  };
  window.Audio = class {
    constructor(src) { this.src = src; }
    play() { window.__played.push(this.src); setTimeout(() => this.onended && this.onended(), 40); return Promise.resolve(); }
    pause() { window.__paused++; this.onended = null; }
  };
  const ss = window.speechSynthesis;
  ss.speak = (u) => { if (String(u.text).trim()) window.__spoken.push(u.text); setTimeout(() => u.onend && u.onend({}), 20); };
  ss.cancel = () => {};
}

const open_browsers = [];
test.afterEach(async () => { while (open_browsers.length) await open_browsers.pop().close().catch(() => {}); });
async function open({ deny = false, stt = 200, tts = 200 } = {}) {
  const browser = await chromium.launch(); open_browsers.push(browser);
  const page = await browser.newPage();
  const seen = [];
  await page.route(SERVER + '/**', async (route) => {
    const req = route.request(), u = new globalThis.URL(req.url());
    seen.push({ path: u.pathname, query: u.search, type: req.headers()['content-type'], body: u.pathname.endsWith('/speak') ? JSON.parse(req.postData()) : null });
    const json = (o, s) => route.fulfill({ status: s || 200, contentType: 'application/json', body: JSON.stringify(o) });
    const user = { id: 'u1', email: 'a@example.com', name: 'Asha', role: 'member' };
    if (u.pathname === '/api/v1/auth/refresh') return json({ detail: 'no session' }, 401);
    if (u.pathname === '/api/v1/auth/login') return json({ access_token: 'acc-1', user });
    if (u.pathname === '/api/v1/overview') return json({ status: 'empty', at: Date.now(), message: 'No devices are registered yet.' });
    if (u.pathname === '/api/v1/aura/status') return json({ available: false, reason: 'test' });
    if (u.pathname === '/api/v1/aura/voice/config') return json({ stt: { available: true, provider: 'google' }, tts: { available: true, provider: 'google' }, voices: { en: [{ name: '', label: 'Default' }, { name: 'en-IN-Neural2-A', label: 'Neural2 A' }], ml: [], hi: [] } });
    if (u.pathname === '/api/v1/aura/voice/transcribe') return stt === 200 ? json({ text: 'what is the status', language: 'en' }) : json({ detail: { code: 'upstream_error', message: 'speech service unavailable' } }, stt);
    if (u.pathname === '/api/v1/aura/voice/speak') return tts === 200 ? route.fulfill({ status: 200, contentType: 'audio/mpeg', body: 'ID3MOCK' }) : json({ detail: { code: 'not_configured', message: 'off' } }, tts);
    return json({});
  });
  await page.addInitScript(fakeMedia, deny);
  await page.addInitScript((s) => { localStorage.setItem('orion.server', JSON.stringify(s)); localStorage.setItem('orion.mode', JSON.stringify('live')); }, SERVER);
  await page.goto(URL);
  await page.waitForFunction(() => window.ORION && ORION.app && ORION.app.snap.status === 'auth');
  await page.evaluate(() => ORION.app.source.login('a@example.com', 'pw'));
  await page.waitForFunction(() => ORION.auraAI.cap.dict && ORION.auraAI.cap.dict.kind === 'server' && ORION.auraAI.cap.serverTts);
  await page.evaluate(() => { location.hash = 'aura'; });
  return { page, seen };
}
const speak = async (page) => {
  await page.click('#au-voice');
  await page.waitForFunction(() => ORION.auraAI.cap.dict.active());
  await page.evaluate(() => ORION.auraAI.cap.dict.stop());  // = tapping the orb ("I'm done")
};

test('server voice: recording → server transcription → answer spoken with server audio; stop interrupts', async () => {
  const { page, seen } = await open();
  await speak(page);
  await page.waitForFunction(() => window.__played.length > 0, null, { timeout: 15000 });
  const tr = seen.find((x) => x.path.endsWith('/transcribe'));
  assert.equal(tr.query, '?language=en'); assert.equal(tr.type, 'audio/webm');
  assert.deepEqual(await page.evaluate(() => ORION.app.ui.auraMsgs.filter((m) => m.role === 'user').map((m) => m.text)), ['what is the status']);
  const sp = seen.filter((x) => x.path.endsWith('/speak')).map((x) => x.body);
  assert.ok(sp.length >= 1 && sp.every((b) => b.language === 'en' && b.text.length > 0 && b.rate >= 0.5 && b.rate <= 2));
  assert.equal(await page.evaluate(() => window.__spoken.length), 0);  // no device voice needed
  // interruption: stop() pauses what plays and drops what is queued
  await page.evaluate(() => { ORION.auraAI.deviceSay('One. Two. Three.', 'en', 1); ORION.auraAI.deviceSay('Four.', 'en', 1); });
  await page.waitForFunction(() => ORION.auraAI.serverVoice.audio);
  const before = await page.evaluate(() => { ORION.auraAI.stopBrowser(); return window.__played.length; });
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__played.length), before);
  assert.ok(await page.evaluate(() => window.__paused) >= 1);
});

test('server voice: speech-service failure falls back to the device voice', async () => {
  const { page } = await open({ tts: 503 });
  await speak(page);
  await page.waitForFunction(() => window.__spoken.length > 0, null, { timeout: 15000 });
  assert.equal(await page.evaluate(() => window.__played.length), 0);
});

test('server voice: transcription failure and mic denial leave typing available', async () => {
  const { page } = await open({ stt: 502 });
  await speak(page);
  await page.waitForFunction(() => /Voice input failed/.test(document.body.innerText), null, { timeout: 10000 });
  assert.deepEqual(await page.evaluate(() => ORION.app.ui.auraMsgs.filter((m) => m.role === 'user').length), 0);
  const d = await open({ deny: true });
  const err = await d.page.evaluate(() => ORION.auraAI.cap.dict.start({ language: 'en' }).then(() => null, (e) => e.code));
  assert.equal(err, 'not_granted');
  await d.page.waitForSelector('#au-in');  // typing still works
});
