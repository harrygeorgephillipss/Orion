/* Aura voice conversation ("talk back"): a scripted microphone (fake Web Speech recognition) and a recording
 * speaker (speechSynthesis.speak captured). Checks the full loop in the real app: speech → question → answer spoken
 * → mic open again. It cannot check real audio quality or a phone's installed voices. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { chromium } = require('playwright');

const URL = 'file://' + path.join(__dirname, '..', '..', 'index.html');

function fakeVoice() {
  window.__spoken = []; window.__recStarts = 0; window.__say = null;
  class FakeRec {
    constructor() { this.lang = ''; }
    start() {
      window.__recStarts++; window.__recLang = this.lang; const self = this;
      window.__say = (text) => { self.onresult && self.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] }); };
      setTimeout(() => self.onstart && self.onstart(), 20);
    }
    stop() { setTimeout(() => this.onend && this.onend(), 10); }
    abort() { this.stop(); }
  }
  window.SpeechRecognition = FakeRec; window.webkitSpeechRecognition = FakeRec;
  // Record what Aura says; finish each utterance quickly so the conversation continues.
  const ss = window.speechSynthesis;
  ss.speak = (u) => { if (String(u.text).trim()) window.__spoken.push({ text: u.text, lang: u.lang }); setTimeout(() => u.onend && u.onend({}), 30); };  // ignore the silent unlock utterance
  ss.cancel = () => {};
}

const open_browsers = [];
test.afterEach(async () => { while (open_browsers.length) await open_browsers.pop().close().catch(() => {}); });
async function open(init) {
  const browser = await chromium.launch();
  open_browsers.push(browser);
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(fakeVoice);
  if (init) await init(page);
  await page.goto(URL);
  await page.waitForFunction(() => window.ORION && ORION.app && ORION.app.ev && ORION.auraAI.cap.ready);
  return { browser, page, errors };
}

async function talk(page, words) {
  await page.waitForFunction(() => typeof window.__say === 'function');
  await page.evaluate((w) => window.__say(w), words);
}

test('voice mode (simulation, basic Aura): spoken question → spoken answer → listening again', async () => {
  const { browser, page, errors } = await open();
  assert.equal(await page.evaluate(() => ORION.auraAI.cap.dict && ORION.auraAI.cap.dict.kind), 'browser');
  await page.evaluate(() => { location.hash = 'aura'; });
  await page.click('#au-voice');
  await page.waitForSelector('#voiceOverlay');
  await talk(page, 'what is the temperature');
  await page.waitForFunction(() => window.__spoken.length > 0, null, { timeout: 15000 });
  const spoken = await page.evaluate(() => window.__spoken.map((s) => s.text).join(' '));
  assert.match(spoken, /Temperature/i);
  assert.match(spoken, /SIMULATED/, 'simulated data must be said out loud too');
  // after speaking, the mic is listening again for the next question
  await page.waitForFunction(() => document.getElementById('voiceOverlay').dataset.state === 'listening', null, { timeout: 10000 });
  const transcript = await page.evaluate(() => ORION.app.ui.auraMsgs.filter((m) => m.role === 'user').map((m) => m.text));
  assert.deepEqual(transcript, ['what is the temperature']);
  assert.deepEqual(errors, []);
  await browser.close();
});

test('voice mode with server Aura: the streamed answer is spoken sentence by sentence', async () => {
  const SERVER = 'http://orion.test';
  const { browser, page, errors } = await open(async (p) => {
    await p.addInitScript((s) => { localStorage.setItem('orion.server', JSON.stringify(s)); localStorage.setItem('orion.mode', JSON.stringify('live')); }, SERVER);
    await p.route(SERVER + '/**', (route) => {
      const u = new globalThis.URL(route.request().url()).pathname;
      const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
      if (u === '/api/v1/auth/refresh') return json({ access_token: 'a', user: { id: 'u', name: 'Asha', email: 'a@example.com', role: 'member' } });
      if (u === '/api/v1/overview') return json({ status: 'empty', at: Date.now() });
      if (u === '/api/v1/aura/status') return json({ available: true, provider: 'mock' });
      if (u === '/api/v1/aura/chat') {
        const ev = [{ type: 'step', kind: 'get_sensor_readings', text: 'Checked sensor readings' }, { type: 'text', delta: 'The living room is 29.4 °C right now. ' }, { type: 'text', delta: 'Humidity is 71 percent.' }, { type: 'done', conversation_id: 'c1', text: '' }];
        return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ev.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join('') });
      }
      return json({});
    });
  });
  await page.waitForFunction(() => ORION.app.source.aura && ORION.app.source.aura.available);
  await page.evaluate(() => { location.hash = 'aura'; });
  await page.click('#au-voice');
  await page.waitForSelector('#voiceOverlay');
  await talk(page, 'how warm is it');
  await page.waitForFunction(() => window.__spoken.length >= 2, null, { timeout: 15000 });
  const spoken = await page.evaluate(() => window.__spoken.map((s) => s.text));
  assert.ok(spoken.some((t) => /29\.4/.test(t)) && spoken.some((t) => /Humidity/.test(t)), JSON.stringify(spoken));
  const last = await page.evaluate(() => { const m = ORION.app.ui.auraMsgs; return m[m.length - 1]; });
  assert.equal(last.mode, 'ai');
  await page.waitForFunction(() => document.getElementById('voiceOverlay').dataset.state === 'listening', null, { timeout: 10000 });
  assert.deepEqual(errors, []);
  await browser.close();
});

test('voice mode in Malayalam: the mic listens in ml-IN and the answer is spoken with a Malayalam voice', async () => {
  const SERVER = 'http://orion.test';
  let asked = null;
  const { page } = await open(async (p) => {
    await p.addInitScript((s) => { localStorage.setItem('orion.server', JSON.stringify(s)); localStorage.setItem('orion.mode', JSON.stringify('live')); localStorage.setItem('orion.aura.lang', JSON.stringify('ml')); }, SERVER);
    await p.route(SERVER + '/**', (route) => {
      const u = new globalThis.URL(route.request().url()).pathname;
      const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
      if (u === '/api/v1/auth/refresh') return json({ access_token: 'a', user: { id: 'u', name: 'Asha', email: 'a@example.com', role: 'member' } });
      if (u === '/api/v1/overview') return json({ status: 'empty', at: Date.now() });
      if (u === '/api/v1/aura/status') return json({ available: true, provider: 'mock' });
      if (u === '/api/v1/aura/chat') {
        asked = JSON.parse(route.request().postData());
        const ev = [{ type: 'text', delta: 'ലിവിംഗ് റൂമിൽ ഇപ്പോൾ 29.4 °C ആണ്.' }, { type: 'done', conversation_id: 'c1', text: '' }];
        return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ev.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join('') });
      }
      return json({});
    });
  });
  await page.waitForFunction(() => ORION.app.source.aura && ORION.app.source.aura.available);
  await page.evaluate(() => { location.hash = 'aura'; });
  await page.click('#au-voice');
  await talk(page, 'താപനില എത്ര');
  await page.waitForFunction(() => window.__spoken.length > 0, null, { timeout: 15000 });
  assert.equal(await page.evaluate(() => window.__recLang), 'ml-IN');
  assert.equal(asked.language, 'ml');
  assert.equal(asked.voice, true);
  const sp = await page.evaluate(() => window.__spoken[0]);
  assert.match(sp.text, /29\.4/);
  assert.equal(sp.lang, 'ml-IN');
});
