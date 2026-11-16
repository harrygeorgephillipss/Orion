/* Aura AI — conversational assistant grounded in live ORION data.
 * Uses the artifact platform's `sample` (Claude), `dictation` (speech → text) and `tts` (text → speech).
 * Falls back to the rule-based basic mode (aura.js) when Claude isn't available in this view. */
'use strict';
(function () {
  const F = ORION.fmt;

  /* Language list.
   * bench: benchmarked by Anthropic (Global-MMLU, % of English score) — reliable.
   * other: Claude handles it, but it is not in Anthropic's published benchmark — answers may be less accurate. */
  const LANGS = [
    { code: 'auto', name: 'Auto', native: 'Reply in my language', tier: 'auto' },
    { code: 'en', name: 'English', native: 'English', tier: 'bench' },
    { code: 'ml', name: 'Malayalam', native: 'മലയാളം', tier: 'other' },
    { code: 'hi', name: 'Hindi', native: 'हिन्दी', tier: 'bench' },
    { code: 'bn', name: 'Bengali', native: 'বাংলা', tier: 'bench' },
    { code: 'ta', name: 'Tamil', native: 'தமிழ்', tier: 'other' },
    { code: 'te', name: 'Telugu', native: 'తెలుగు', tier: 'other' },
    { code: 'kn', name: 'Kannada', native: 'ಕನ್ನಡ', tier: 'other' },
    { code: 'mr', name: 'Marathi', native: 'मराठी', tier: 'other' },
    { code: 'gu', name: 'Gujarati', native: 'ગુજરાતી', tier: 'other' },
    { code: 'pa', name: 'Punjabi', native: 'ਪੰਜਾਬੀ', tier: 'other' },
    { code: 'or', name: 'Odia', native: 'ଓଡ଼ିଆ', tier: 'other' },
    { code: 'ur', name: 'Urdu', native: 'اردو', tier: 'other' },
    { code: 'as', name: 'Assamese', native: 'অসমীয়া', tier: 'other' },
  ];
  const byCode = (c) => LANGS.find((l) => l.code === c) || LANGS[0];

  /* Which device are we on? Used to give the right voice instructions. */
  const PLATFORM = (() => {
    const ua = navigator.userAgent || '';
    const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const android = /Android/.test(ua);
    let coarse = false; try { coarse = matchMedia('(pointer: coarse)').matches; } catch (e) { /* none */ }
    return { ios, android, mobile: ios || android || coarse, name: ios ? 'iPhone / iPad' : android ? 'Android' : 'computer' };
  })();
  const cap = { ready: false, sample: null, tts: null, dict: null, ttsLangs: undefined, aiBlocked: false, tools: false, browserTts: false, lastError: null };
  const subs = [];
  const emit = () => subs.forEach((f) => { try { f(); } catch (e) { console.error(e); } });

  async function init() {
    const fallbackVoice = () => {
      cap.browserTts = !cap.tts && typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance !== 'undefined';
      if (cap.browserTts) {
        try { window.speechSynthesis.getVoices(); window.speechSynthesis.addEventListener('voiceschanged', emit); } catch (e) { /* none */ }
        /* iPhone/iPad (and some Android browsers) only allow speech that starts from a tap.
           Speak a silent line on the first tap so later replies can be read aloud. */
        const unlock = () => { try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; window.speechSynthesis.speak(u); } catch (e) { /* none */ } cap.speechUnlocked = true; };
        document.addEventListener('pointerdown', unlock, { once: true, capture: true });
        document.addEventListener('keydown', unlock, { once: true, capture: true });
      }
    };
    cap.host = window.claude && typeof window.claude.use === 'function' ? 'claude' : ORION.native && ORION.native.isNative ? 'android' : 'browser';
    if (cap.host !== 'claude') { cap.dict = browserDictation(); fallbackVoice(); if (cap.host === 'android') ORION.native.attachAura(ORION.auraAI); cap.ready = true; emit(); return; }
    const get = (n) => Promise.resolve().then(() => window.claude.use(n)).catch(() => null);
    const [s, t, d] = await Promise.all([get('sample'), get('tts'), get('dictation')]);
    cap.sample = s; cap.tts = t; cap.dict = d || browserDictation();
    if (t && typeof t.languages === 'function') cap.ttsLangs = await t.languages().catch(() => undefined);
    if (s && typeof s.limits === 'function') { const lim = await s.limits().catch(() => null); cap.tools = !!(lim && lim.tools); }
    fallbackVoice();
    cap.ready = true; emit();
  }

  /* Browser speech recognition (Web Speech API), exposing the same interface Aura's voice code already uses:
     start({language}) / stop() / active() / onPartial / onFinal / onState({state, reason}).
     Chrome and Edge send the audio to their vendor's speech service; availability and languages depend on the browser. */
  function browserDictation() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    let rec = null, on = false, stopping = false;
    const L = { partial: [], final: [], state: [] };
    const fire = (k, v) => L[k].forEach((f) => { try { f(v); } catch (e) { console.error(e); } });
    const ERR = { 'not-allowed': 'not_granted', 'service-not-allowed': 'not_granted', 'language-not-supported': 'unavailable', 'audio-capture': 'unavailable', 'no-speech': 'stopped', aborted: 'stopped', network: 'upstream_error' };
    return {
      kind: 'browser',
      active: () => on,
      onPartial: (f) => L.partial.push(f), onFinal: (f) => L.final.push(f), onState: (f) => L.state.push(f),
      start(opts) {
        return new Promise((resolve, reject) => {
          if (on) return resolve();
          let started = false, reason = 'stopped';
          try {
            rec = new SR(); rec.continuous = true; rec.interimResults = true;
            const code = opts && opts.language;
            rec.lang = (code && BCP[code]) || navigator.language || 'en-IN';
          } catch (e) { reject({ code: 'unavailable' }); return; }
          rec.onstart = () => { started = true; on = true; fire('state', { state: 'listening' }); resolve(); };
          rec.onresult = (e) => {
            let interim = '';
            for (let i = e.resultIndex; i < e.results.length; i++) {
              const r = e.results[i], txt = (r[0] && r[0].transcript) || '';
              if (r.isFinal) fire('final', { text: txt.trim() + ' ' }); else interim += txt;
            }
            fire('partial', { text: interim.trim() });
          };
          rec.onerror = (e) => { reason = ERR[e.error] || 'upstream_error'; if (!started) reject({ code: reason }); };
          rec.onend = () => { on = false; rec = null; fire('state', { state: 'idle', reason: stopping ? 'stopped' : reason }); stopping = false; };
          fire('state', { state: 'starting' });
          try { rec.start(); } catch (e) { reject({ code: 'upstream_error' }); }
        });
      },
      stop() { stopping = true; try { if (rec) rec.stop(); } catch (e) { /* already stopped */ } return Promise.resolve(); },
    };
  }


  /* ---------- Server voice engine (Phase 4b): speech-to-text and text-to-speech through the ORION server ----------
     Providers (Google Cloud by default) and their keys live on the server. The page records audio (MediaRecorder),
     uploads it for transcription, and plays server-generated speech sentence by sentence as the answer streams.
     Any failure falls back to the device's own voice, and text chat always keeps working. */
  const SV = { cfg: null, app: null, orig: null, queue: Promise.resolve(), gen: 0, audio: null, prevDict: null };
  const SV_LANGS = ['en', 'ml', 'hi'];
  const svLang = (code) => (SV_LANGS.includes(code) ? code : 'en');
  function serverDictation(app) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof window.MediaRecorder === 'undefined') return null;
    const L = { partial: [], final: [], state: [] };
    const fire = (k, v) => L[k].forEach((f) => { try { f(v); } catch (e) { console.error(e); } });
    const types = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm'];
    const mime = types.find((m) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';
    let on = false, rec = null, stream = null, chunks = [], vad = null, maxT = null, ctx = null;
    const d = {
      kind: 'server', active: () => on,
      onPartial: (f) => L.partial.push(f), onFinal: (f) => L.final.push(f), onState: (f) => L.state.push(f),
      async start(opts) {
        try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
        catch (e) { throw { code: e && (e.name === 'NotAllowedError' || e.name === 'SecurityError') ? 'not_granted' : 'unavailable' }; }
        const lang = svLang(opts && opts.language);
        chunks = [];
        rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
        rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        rec.onstop = async () => {
          clearTimeout(maxT); clearInterval(vad); try { if (ctx) ctx.close(); } catch (e) { /* closed */ }
          if (stream) stream.getTracks().forEach((t) => t.stop());
          on = false;
          const blob = new Blob(chunks, { type: (rec.mimeType || mime || 'audio/webm').split(';')[0] });
          fire('state', { state: 'processing' });
          const r = await app.source.voiceTranscribe(blob, lang);
          if (r.ok && r.text) fire('final', { text: r.text + ' ' });
          else if (!r.ok && r.code !== 'no_speech' && ORION.app) ORION.app.toast('Voice input failed: ' + r.error + ' — you can type instead.', 'bad');
          fire('state', { state: 'idle', reason: r.ok || r.code === 'no_speech' ? 'stopped' : 'error' });
        };
        rec.start(250); on = true; fire('state', { state: 'listening' });
        maxT = setTimeout(() => d.stop(), 15000);
        try {  // end of speech: ~1.2 s of quiet after speaking
          ctx = new (window.AudioContext || window.webkitAudioContext)();
          const an = ctx.createAnalyser(); ctx.createMediaStreamSource(stream).connect(an);
          const buf = new Uint8Array(an.fftSize); let spoke = false, quiet = Date.now();
          vad = setInterval(() => {
            an.getByteTimeDomainData(buf); let s = 0; for (const v of buf) s += (v - 128) * (v - 128);
            if (Math.sqrt(s / buf.length) > 8) { spoke = true; quiet = Date.now(); } else if (spoke && Date.now() - quiet > 1200) d.stop();
          }, 100);
        } catch (e) { /* no level meter: tap the orb to finish, or 15 s */ }
      },
      async stop() { if (rec && rec.state !== 'inactive') rec.stop(); },
    };
    return d;
  }
  function serverSay(text, code, rate) {
    const gen = SV.gen, app = SV.app;
    const lang = svLang(code);
    if (!SV_LANGS.includes(code) && code !== 'auto' && SV.orig) return SV.orig.deviceSay(text, code, rate);  // other languages: device voice
    const voices = ORION.util.store.get('orion.aura.svoice', {}) || {};
    const audio = app.source.voiceSpeak({ text: String(text).slice(0, 1500), language: lang, voice: voices[lang] || '', rate: Math.min(2, Math.max(0.5, rate || 1)) });  // fetched now (progressive)
    const play = () => audio.then((r) => new Promise((resolve) => {
      if (gen !== SV.gen) return resolve();
      if (!r.ok) { cap.lastSpeechError = r.code; return (SV.orig ? SV.orig.deviceSay(text, code, rate) : Promise.resolve()).then(resolve); }
      const url = URL.createObjectURL(r.blob), a = new Audio(url);
      SV.audio = a;
      const done = () => { URL.revokeObjectURL(url); if (SV.audio === a) SV.audio = null; resolve(); };
      a.onended = done; a.onerror = done;
      Promise.resolve(a.play()).catch(() => { cap.lastSpeechError = 'play_blocked'; done(); });
    }));
    SV.queue = SV.queue.then(play, play);
    return SV.queue;
  }
  function useServerVoice(app, cfg) {
    SV.cfg = cfg; SV.app = app;
    if (!cfg) return;
    if (cfg.stt && cfg.stt.available) { const d = serverDictation(app); if (d) { SV.prevDict = cap.dict; cap.dict = d; } }
    if (cfg.tts && cfg.tts.available && !SV.orig) {
      const A2 = ORION.auraAI;
      SV.orig = { deviceSay: A2.deviceSay, speakBrowser: A2.speakBrowser, stopBrowser: A2.stopBrowser };
      A2.deviceSay = (t, code, rate) => serverSay(t, code, rate);
      A2.speakBrowser = (t, code, onEnd, rate) => { serverSay(t, code, rate).then(() => onEnd && onEnd()); return true; };
      A2.stopBrowser = () => { SV.gen++; SV.queue = Promise.resolve(); if (SV.audio) { try { SV.audio.pause(); } catch (e) { /* gone */ } SV.audio = null; } SV.orig.stopBrowser(); };
      cap.browserTts = true; cap.serverTts = true;
    }
    emit();
  }

  /* Device (browser) voice — used only where Claude's own voice isn't offered in this view. */
  const BCP = { en: 'en-IN', ml: 'ml-IN', hi: 'hi-IN', bn: 'bn-IN', ta: 'ta-IN', te: 'te-IN', kn: 'kn-IN', mr: 'mr-IN', gu: 'gu-IN', pa: 'pa-IN', or: 'or-IN', ur: 'ur-IN', as: 'as-IN' };
  const browserVoices = () => { try { return window.speechSynthesis ? window.speechSynthesis.getVoices() : []; } catch (e) { return []; } };
  function browserVoiceFor(code) {
    const vs = browserVoices(); if (!vs.length) return null;
    if (!code || code === 'auto' || code === 'en') return vs.find((v) => /^en-IN/i.test(v.lang)) || vs.find((v) => /^en/i.test(v.lang)) || vs[0];
    return vs.find((v) => v.lang.toLowerCase().startsWith(code)) || null;
  }
  /* Device voice, made robust for known browser quirks:
     - keep a reference to every utterance (Chrome drops speech if it is garbage-collected),
     - speak in short sentence chunks (Chrome cuts off long utterances after ~15 s),
     - don't cancel() right before speak() unless something is playing (can silence Chrome),
     - resume() if the engine got stuck paused (Android/iOS). */
  const live = [];
  function speakBrowser(text, code, onEnd, rate) {
    try {
      const ss = window.speechSynthesis;
      if (ss.speaking || ss.pending) ss.cancel();
      const v = browserVoiceFor(code);
      const parts = String(text).match(/[^.!?।\n]+[.!?।]?/g) || [String(text)];
      const chunks = []; let cur = '';
      for (const p of parts) { if ((cur + p).length > 180 && cur) { chunks.push(cur); cur = p; } else cur += (cur && !/\s$/.test(cur) ? " " : "") + p; }
      if (cur.trim()) chunks.push(cur);
      live.length = 0;
      let left = chunks.length, ended = false;
      const finish = () => { if (!ended) { ended = true; live.length = 0; onEnd && onEnd(); } };
      chunks.forEach((c) => {
        const u = new SpeechSynthesisUtterance(c.trim());
        if (v) { u.voice = v; u.lang = v.lang; } else u.lang = BCP[code] || 'en-IN';
        if (rate) u.rate = rate;
        u.volume = 1;
        u.onend = () => { if (--left <= 0) finish(); };
        u.onerror = (e) => { cap.lastSpeechError = e && e.error; if (e && e.error !== 'interrupted' && e.error !== 'canceled') finish(); else if (--left <= 0) finish(); };
        live.push(u);
      });
      setTimeout(() => { try { live.forEach((u) => ss.speak(u)); if (ss.paused) ss.resume(); } catch (e) { finish(); } }, 60);
      setTimeout(() => { if (!ss.speaking && !ss.pending && !ended) { cap.lastSpeechError = cap.lastSpeechError || 'did_not_start'; } }, 2500);
      return true;
    } catch (e) { cap.lastSpeechError = 'exception'; onEnd && onEnd(); return false; }
  }
  const stopBrowser = () => { try { window.speechSynthesis.cancel(); } catch (e) { /* none */ } live.length = 0; };
  /* Queue one sentence on the device voice without interrupting what is already playing.
     Resolves when that sentence has been spoken (or failed). Used to speak a reply while it is still being written. */
  function deviceSay(text, code, rate) {
    return new Promise((resolve) => {
      try {
        const ss = window.speechSynthesis;
        const u = new SpeechSynthesisUtterance(String(text).trim());
        const v = browserVoiceFor(code);
        if (v) { u.voice = v; u.lang = v.lang; } else u.lang = BCP[code] || 'en-IN';
        if (rate) u.rate = rate;
        u.volume = 1;
        u.onend = () => resolve();
        u.onerror = (e) => { cap.lastSpeechError = e && e.error; resolve(); };
        live.push(u); if (live.length > 60) live.splice(0, live.length - 60);
        ss.speak(u); if (ss.paused) ss.resume();
      } catch (e) { cap.lastSpeechError = 'exception'; resolve(); }
    });
  }
  /* Guess the reply's language from its script (for Auto mode). */
  function detectLang(text) {
    const t = String(text || '');
    const R = [['ml', /[ഀ-ൿ]/], ['ta', /[஀-௿]/], ['te', /[ఀ-౿]/], ['kn', /[ಀ-೿]/], ['bn', /[ঀ-৿]/], ['gu', /[઀-૿]/], ['pa', /[਀-੿]/], ['or', /[଀-୿]/], ['ur', /[؀-ۿ]/], ['hi', /[ऀ-ॿ]/]];
    for (const [c, re] of R) if (re.test(t)) return c;
    return 'en';
  }
  const canSpeak = (code) => {
    if (cap.tts) return true; // Claude's voice reads any text; it picks the language itself when it can't use ours
    if (cap.browserTts) return code === 'auto' || !browserVoices().length || !!browserVoiceFor(code);
    return false;
  };
  const speechAvailable = () => !!cap.tts || !!cap.browserTts;

  /* ---------- compact, honest snapshot of ORION for the model ---------- */
  function context(app) {
    const snap = app.snap, ev = app.ev, cfg = app.config, now = Date.now();
    if (!snap || snap.status !== 'ok') return { data_status: snap ? snap.status : 'loading', note: ev && ev.reasons ? ev.reasons.join(' ') : 'No data available.' };
    const R = ORION.registry;
    const fresh = (id) => {
      const st = ev.sensors[id];
      if (!st) return 'unknown';
      return st.status === 'live' ? 'fresh' : st.status === 'stale' ? (st.age === Infinity ? 'NO READING RECEIVED' : `STALE — no reading for ${Math.round(st.age / 1000)} s (last-known value)`) : st.status;
    };
    const room = (s) => R.roomOf(cfg, s);
    const stats = (metric, conv) => {
      const key = R.seriesForMetric(snap, metric);
      if (!key) return 'no sensor';
      const pts = (app.source.history(key, now - 86400e3, now) || []).filter((p) => p.v != null);
      if (!pts.length) return 'no data';
      let mn = Infinity, mx = -Infinity, sum = 0;
      for (const p of pts) { mn = Math.min(mn, p.v); mx = Math.max(mx, p.v); sum += p.v; }
      const c = conv || ((x) => x);
      return { min: +c(mn).toFixed(1), max: +c(mx).toFixed(1), avg: +c(sum / pts.length).toFixed(1) };
    };
    const tC = cfg.tempUnit === 'F' ? (c) => c * 9 / 5 + 32 : (c) => c;
    const A = snap.actuators || null;
    const incs = snap.incidents.slice().sort((a, b) => b.opened_at - a.opened_at);
    const incOut = (i) => ({
      what: ORION.ui.incidentSentence(i), severity: i.severity, state: i.state === 'cleared' ? 'resolved' : 'ACTIVE',
      acknowledged: !!i.acknowledged_at, opened: F.dt(i.opened_at), resolved: i.cleared_at ? F.dt(i.cleared_at) : null,
      reading_at_open: `${i.snapshot.value} ${i.snapshot.unit || ''}`.trim(), threshold: i.snapshot.threshold,
      device_reported_actions: i.actions.map((a) => `${a.action} → ${a.outcome}`).slice(0, 6),
    });
    return {
      now: F.dt(now), timezone: cfg.timezone, home: cfg.home.name,
      data_source: app.mode === 'demo' ? 'SIMULATION — invented test data, not real hardware readings'
        : snap.simulated ? 'SIMULATED DEVICES on the live server — device-simulator data, not real hardware readings'
          : snap.contains_simulated ? 'live server; sensors marked simulated:true are simulator data, not hardware readings' : 'live hardware telemetry',
      overall_state: ev.system, state_reasons: ev.reasons, also: ev.notes,
      sensors: R.sensorList(snap).map((s) => {
        const f = s.fields || {};
        const base = { id: s.id, type: s.type, room: room(s), freshness: fresh(s.id), quality: s.quality, recorded: s.recorded_at == null ? 'never' : F.dt(s.recorded_at), simulated: !!s.simulated };
        if (s.type === 'mq2') return Object.assign(base, { raw_adc: f.raw_adc, note: 'raw ADC count, NOT ppm, uncalibrated', device_state: s.state, firmware_thresholds: s.fw_threshold || 'not reported' });
        if (s.type === 'flame') return Object.assign(base, { detected: f.detected, note: 'polarity unverified' });
        if (s.type === 'water') return Object.assign(base, { wet: f.wet, raw_adc: f.raw_adc, note: 'cannot estimate leak volume' });
        if (s.type === 'dht22') return Object.assign(base, { temperature: f.temperature_c == null ? 'no valid reading' : `${F.temp(f.temperature_c)} ${F.tempUnit()}`, humidity: f.humidity_percent == null ? 'no valid reading' : `${f.humidity_percent} %RH`, fault: s.fault || null, advisory_thresholds: 'not set' });
        return Object.assign(base, { fields: f });
      }),
      last_24h: { smoke_raw: stats('mq2'), temperature: stats('temp', tC), humidity_pct: stats('hum'), water_raw: stats('water') },
      controllers: Object.entries(snap.controllers || {}).map(([k, c]) => ({ name: c.name, online: ev.controllers[k].online, gateway: !!c.is_gateway, last_seen: c.last_seen_at == null ? 'never' : F.ago(c.last_seen_at, now), firmware: c.firmware_version, role: c.role })),
      gsm_SIM800C: snap.gsm ? { status_reported: ev.gsm.reported, network_registered: ev.gsm.registered, signal_csq: snap.gsm.csq, recent_attempts: (snap.gsmAttempts || []).slice(0, 4).map((a) => `${a.type.toUpperCase()} ${a.status} at ${F.dt(a.updated_at)} (${a.note})`), note: '"sent" = modem accepted, delivery not confirmed' } : 'not registered with ORION',
      outputs_as_commanded_no_feedback: A && A.fan ? {
        exhaust_fan: A.fan.commanded + (A.fan.cooldown_remaining_s ? ` (cooldown ${A.fan.cooldown_remaining_s}s left)` : ''),
        buzzer: A.buzzer.commanded, model_door_servo_MG995: `target ${A.mg995.target_angle}° (position not sensed)`,
        mist_maker: 'not installed (placeholder only)', SG90_servo: 'disabled — purpose undefined',
        leds: A.leds.items.map((l) => `${l.name.split(' — ')[0]} ${l.commanded}`).join(', '),
      } : 'no outputs reported',
      active_incidents: incs.filter((i) => i.state !== 'cleared').map(incOut),
      recent_incidents: incs.filter((i) => i.state === 'cleared').slice(0, 5).map(incOut),
      undecided_by_owner: ORION.pending.map((p) => p.title),
    };
  }

  function langRule(langCode) {
    const L = byCode(langCode);
    return L.code === 'auto'
      ? 'Reply in the same language the user writes or speaks in. If they write an Indian language in Latin letters (for example Manglish or Hinglish), reply in that language in its native script. If unsure, use English.'
      : L.code === 'en' ? 'Always reply in English, whatever language the user writes in.'
        : `Always reply in ${L.name} (${L.native}) using its native script and natural, idiomatic, everyday wording as a native speaker would — whatever language the user writes in. Keep numbers as digits, keep units (°C, %RH) and keep the names ORION, Aura, MQ-2, DHT22, ESP32, UNO and SIM800C in Latin letters.`;
  }
  const CORE = [
    'You are Aura, the calm, friendly assistant inside ORION, a prototype smart-home safety system built by a student on a model house (Arduino UNO + ESP32, MQ-2 smoke/gas, flame, water and DHT22 temperature/humidity sensors, exhaust fan, buzzer, LEDs, servo door, SIM800C GSM for SMS/calls). You work like a careful AI assistant: understand what the person really needs, check the data, then answer clearly.',
    'TRUTH: For anything about this home, rely only on ORION data (given below or returned by your tools). Never invent or estimate readings, calibration, sensor health, SMS delivery or whether a device physically did something. If a value is STALE, missing or faulty, say so plainly. When the data source is a SIMULATION, say so whenever you report readings — simulated values are not measurements.',
    'FACTS vs OPINION: When you report readings or events, put up to 3 short fact lines first, each starting with "• " and including the value and its time (and "stale" if stale). Then a blank line, then your explanation or advice. For greetings, thanks or general questions, skip the fact lines.',
    'LIMITS: You cannot switch devices, change thresholds, silence alarms or open doors yourself. ORION is a prototype, not a certified fire alarm or gas detector — never claim the home is "safe"; say what the sensors report.',
    'EMERGENCY: If the user says there is a real fire, smoke, gas leak or danger, FIRST tell them to get everyone out and call 112 (emergency) or 101 (fire) in India. Do not tell them to wait for ORION.',
    'STYLE: Warm, calm, simple and conversational, for a non-technical family member. Usually 2–5 sentences; more only if asked. Plain text only — no markdown headings, bold or tables. Replies may be read aloud. You may answer general questions about how the sensors or the project work.',
  ];
  const TOOLS_RULE = 'TOOLS: The current readings, devices, texts/calls, 24-hour summaries and recent alerts are already in ORION DATA below — answer from that directly whenever you can, so you reply fast. Only call get_history for detail beyond those 24-hour summaries (exact times, a specific hour, more than a day, comparisons), and get_alerts only for older alerts not listed below. Use open_page when the user asks to see or show something, or when a chart would clearly help. Use propose_command only when the user asks to switch the fan or test the buzzer — it only shows them a confirmation; they decide, so never say it was done. Do not narrate your tool use ("let me check…"); just give the answer.';

  function pageContext(app) {
    const u = app.ui, names = { home: 'Home', history: 'History', alerts: 'Alerts', devices: 'Devices', aura: 'Aura chat', config: 'Settings' };
    let s = `The user is currently on the ${names[app.route] || app.route} page`;
    if (app.route === 'history') { const si = ORION.registry.seriesInfo(u.histSeries); s += ` (${si ? si.name : 'no sensor'}, last ${u.histRange})`; }
    return s + '.';
  }


  const SENSOR_SERIES = { smoke: 'mq2', flame: 'flame', water: 'water', temperature: 'temp', humidity: 'hum' }; // Aura name → metric
  function tools(app, step) {
    const need = () => { if (!app.snap || app.snap.status !== 'ok') throw new Error('ORION data unavailable: ' + (app.ev && app.ev.reasons ? app.ev.reasons.join(' ') : 'no data')); };
    return [
      { name: 'get_status', description: 'Current ORION state: overall state and reasons, every sensor reading with freshness and time, board and GSM connectivity, outputs as commanded, active alerts. Call for any question about the home right now.',
        execute() { step('status', 'Checked the current readings'); need(); const c = context(app); delete c.recent_incidents; delete c.last_24h; return c; } },
      { name: 'get_history', description: 'Stored readings of one sensor over the last N hours (1-168): min, max, average, up to 36 evenly spaced averaged points with local times, data gaps and alerts in that window.',
        inputSchema: { type: 'object', properties: { sensor: { type: 'string', enum: Object.keys(SENSOR_SERIES) }, hours: { type: 'number', description: '1 to 168' } }, required: ['sensor'] },
        execute(i) {
          need();
          const key = String(i.sensor || ''), metric = SENSOR_SERIES[key]; if (!metric) throw new Error('Unknown sensor ' + key);
          const series = ORION.registry.seriesForMetric(app.snap, metric); if (!series) return { sensor: key, note: 'no such sensor is registered' };
          const hours = Math.max(1, Math.min(168, Number(i.hours) || 24));
          step('history', `Looked at ${key} history · ${hours >= 24 ? Math.round(hours / 24) + ' day' + (hours >= 48 ? 's' : '') : hours + ' h'}`);
          const to = Date.now(), from = to - hours * 3600e3;
          let pts = (app.source.history(series, from, to) || []).filter((p) => p.v != null);
          const conv = metric === 'temp' && app.config.tempUnit === 'F' ? (v) => v * 9 / 5 + 32 : (v) => v;
          if (!pts.length) return { sensor: key, hours, note: 'no readings stored in this window' };
          let mn = Infinity, mx = -Infinity, sum = 0, tmx = 0, tmn = 0;
          for (const p of pts) { const v = conv(p.v); if (v > mx) { mx = v; tmx = p.t; } if (v < mn) { mn = v; tmn = p.t; } sum += v; }
          const N = 36, w = (to - from) / N, buckets = [];
          for (let b = 0; b < N; b++) { const a = from + b * w, z = a + w; const ch = pts.filter((p) => p.t >= a && p.t < z); buckets.push({ time: F.dt(a + w / 2), value: ch.length ? +(ch.reduce((s, p) => s + conv(p.v), 0) / ch.length).toFixed(1) : null }); }
          const gaps = buckets.filter((b) => b.value == null).length;
          const unit = metric === 'temp' ? F.tempUnit() : metric === 'hum' ? '%RH' : metric === 'flame' ? '1 = flame detected' : 'raw ADC (not ppm)';
          const alerts = app.snap.incidents.filter((x) => x.source_id === ORION.registry.parseSeries(series).sensorId && x.opened_at >= from).map((x) => ({ what: ORION.ui.incidentSentence(x), severity: x.severity, opened: F.dt(x.opened_at), resolved: x.cleared_at ? F.dt(x.cleared_at) : 'still active' }));
          return { sensor: key, unit, window: `${F.dt(from)} → ${F.dt(to)}`, data_source: app.mode === 'demo' || (app.snap.sensors[ORION.registry.parseSeries(series).sensorId] || {}).simulated ? 'SIMULATION' : 'live hardware', max: { value: +mx.toFixed(1), at: F.dt(tmx) }, min: { value: +mn.toFixed(1), at: F.dt(tmn) }, average: +(sum / pts.length).toFixed(1), points: buckets, buckets_with_no_data: gaps, alerts };
        } },
      { name: 'get_alerts', description: 'Alert records: what happened, severity, start/end times, sensor reading, what the devices reported doing (with outcomes), and whether the owner marked it as seen. filter "active" or "recent".',
        inputSchema: { type: 'object', properties: { filter: { type: 'string', enum: ['active', 'recent'] }, limit: { type: 'number' } } },
        execute(i) {
          need(); step('alerts', i.filter === 'active' ? 'Checked active alerts' : 'Looked through recent alerts');
          const c = context(app);
          const all = (i.filter === 'active' ? c.active_incidents : c.active_incidents.concat(c.recent_incidents));
          return { alerts: all.slice(0, Math.max(1, Math.min(10, Number(i.limit) || 6))) };
        } },
      { name: 'get_devices', description: 'All outputs (fan, buzzer, model door servo, LEDs, relay, mist maker, SG90) as commanded — none report feedback — plus recent commands with their lifecycle and recent SMS/call attempts.',
        execute() {
          need(); step('devices', 'Checked devices, texts and calls');
          const c = context(app), snap = app.snap;
          return { outputs: c.outputs_as_commanded_no_feedback, recent_commands: (snap.commands || []).slice(0, 5).map((x) => `${x.actuator} ${x.action}: ${x.status} (${x.history[x.history.length - 1].note})`), gsm: c.gsm_SIM800C, boards: c.controllers };
        } },
      { name: 'open_page', description: 'Show the user a page of the ORION app. page: home, history, alerts, devices or settings. For history you may pick sensor and range (1h, 6h, 24h, 7d).',
        inputSchema: { type: 'object', properties: { page: { type: 'string', enum: ['home', 'history', 'alerts', 'devices', 'settings'] }, sensor: { type: 'string', enum: Object.keys(SENSOR_SERIES) }, range: { type: 'string', enum: ['1h', '6h', '24h', '7d'] } }, required: ['page'] },
        execute(i) {
          const page = String(i.page), map = { settings: 'config' };
          if (!['home', 'history', 'alerts', 'devices', 'settings'].includes(page)) throw new Error('Unknown page');
          if (page === 'history') { if (SENSOR_SERIES[i.sensor]) app.ui.histSeries = ORION.registry.seriesForMetric(app.snap, SENSOR_SERIES[i.sensor]) || app.ui.histSeries; if (['1h', '6h', '24h', '7d'].includes(i.range)) app.ui.histRange = i.range; }
          step('open', `Opened ${page}${page === 'history' && i.sensor ? ' · ' + i.sensor : ''}`);
          app.go(map[page] || page);
          return 'The page is now shown to the user.';
        } },
      { name: 'propose_command', description: 'Show the user a confirmation dialog for a SIMULATED command. Allowed only: fan on, fan off, buzzer test. It does not run anything by itself — the user decides, and the device may still refuse (e.g. fan held on during smoke).',
        inputSchema: { type: 'object', properties: { device: { type: 'string', enum: ['fan', 'buzzer'] }, action: { type: 'string', enum: ['on', 'off', 'test'] } }, required: ['device', 'action'] },
        execute(i) {
          const key = `${i.device}:${i.action}`;
          if (!['fan:on', 'fan:off', 'buzzer:test'].includes(key)) throw new Error('Not allowed. Only fan on/off and buzzer test can be proposed; the door, mist maker and SG90 are disabled pending safety decisions.');
          if (!app.canCommand()) throw new Error('Your ORION role is not allowed to send device commands.');
          step('propose', `Asked you to confirm: ${i.device} ${i.action}`);
          app.confirmCommand(key);
          return 'A confirmation dialog is now shown. The user decides; nothing has run yet. Tell them to confirm or cancel.';
        } },
    ];
  }

  /* Aura on the ORION server (Phase 4): the provider, its key, the tools and the permission checks all live on the
     server; this page only streams the answer. */
  const serverOn = (app) => !!(app && app.mode === 'live' && app.source && app.source.aura && app.source.aura.available && !cap.serverBlocked);
  async function askServer(app, turns, langCode, opts) {
    const last = turns[turns.length - 1];
    const body = { message: String(last && last.content || ''), conversation_id: app.ui.auraConv || null, language: langCode || 'auto', voice: !!opts.voice, page: app.route };
    let full = '', err = null;
    await app.source.auraChat(body, (e) => {
      if (e.type === 'safety') { full = e.text + '\n\n' + full; opts.onText && opts.onText({ text: full }); }
      else if (e.type === 'text') { full += e.delta; opts.onText && opts.onText({ text: full }); }
      else if (e.type === 'step') { opts.onStep && opts.onStep(STEP_KIND[e.kind] || 'status', e.text); }
      else if (e.type === 'action' && e.kind === 'open_page') {
        if (e.page === 'history') { const m = { smoke: 'mq2', flame: 'flame', water: 'water', temperature: 'temp', humidity: 'hum' }[e.sensor]; if (m) app.ui.histSeries = ORION.registry.seriesForMetric(app.snap, m) || app.ui.histSeries; if (e.range) app.ui.histRange = e.range; }
        app.go({ settings: 'config' }[e.page] || e.page);
      } else if (e.type === 'action' && e.kind === 'proposal') { app.confirmProposal(e); }
      else if (e.type === 'done') { app.ui.auraConv = e.conversation_id; if (e.text && !full) full = e.text; }
      else if (e.type === 'unavailable') { app.ui.auraConv = e.conversation_id; err = { code: 'capability_disabled', text: full }; cap.serverBlocked = true; }
      else if (e.type === 'error') { err = { code: e.code === 'rate_limited' ? 'rate_limited' : e.code === 'refused' ? 'refused' : 'upstream_error', text: full }; }
    }, opts.signal);
    if (err && !full.trim()) throw err;
    return { text: full, truncated: !!(err && err.code === 'truncated') };
  }
  const STEP_KIND = { get_system_status: 'status', get_sensor_readings: 'status', get_sensor_history: 'history', get_alerts: 'alerts', get_incident_history: 'alerts', get_device_status: 'devices', get_gsm_status: 'devices', get_controller_health: 'devices', open_dashboard_page: 'open', propose_device_command: 'propose' };

  async function ask(app, turns, langCode, opts) {
    if (serverOn(app)) return askServer(app, turns, langCode, opts);
    const useTools = cap.tools && opts.tools !== false;
    const VOICE_RULE = 'VOICE CONVERSATION: The user is talking to you out loud and will hear your reply spoken. Answer in 1–3 short, natural spoken sentences, like a calm voice assistant. Do NOT use "• " fact lines or lists; mention the reading time and that it is demo data briefly in the sentence. Keep emergency advice first if relevant.';
    const head = [CORE[0], `LANGUAGE: ${langRule(langCode)}`].concat(CORE.slice(1), useTools ? [TOOLS_RULE] : [], opts.voice ? [VOICE_RULE] : [], [pageContext(app)]).join('\n\n');
    // Everything Aura usually needs goes in one message, so most answers take a single round (fast on phones).
    const ctx = context(app);
    if (opts.voice) { delete ctx.undecided_by_owner; ctx.recent_incidents = ctx.recent_incidents.slice(0, 2); } // voice: smaller prompt → first words sooner
    const data = 'ORION DATA (current):\n' + JSON.stringify(ctx);
    const input = [{ role: 'user', content: head + '\n\n' + data }].concat(turns.slice(-8));
    const o = { cache: false, modelTier: opts.tier || 'quick', onText: opts.onText, signal: opts.signal };
    // Voice keeps only the action tools (open a page, propose a command) so answers stay single-round.
    const drop = opts.voice ? ['get_status', 'get_devices', 'get_history', 'get_alerts'] : ['get_status', 'get_devices'];
    if (useTools) o.tools = tools(app, opts.onStep || (() => {})).filter((t) => !drop.includes(t.name));
    return cap.sample(input, o);
  }

  /* Split a reply into fact lines and the rest. */
  function split(text) {
    const lines = String(text || '').split('\n');
    const facts = [], rest = [];
    for (const l of lines) { if (/^\s*[•\-*]\s+/.test(l) && !rest.join('').trim()) facts.push(l.replace(/^\s*[•\-*]\s+/, '')); else rest.push(l); }
    return { facts, body: rest.join('\n').trim() };
  }
  // Each displayed line becomes its own spoken sentence (a pause between facts instead of running them together).
  const plainForSpeech = (text) => String(text).replace(/^\s*[•\-*]\s+/gm, '').replace(/[*_#`]/g, '').trim()
    .replace(/([^.!?।\s])[ \t]*\n+/g, '$1. ').replace(/\s*\n+\s*/g, ' ');

  const ERR = {
    not_granted: 'Aura needs your permission to use Claude. Basic mode is on for now.',
    sampling_disabled: 'Claude isn’t available for this account. Basic mode is on.',
    rate_limited: 'Aura is getting too many questions right now. Please try again in a moment.',
    session_expired: 'Your Claude session expired — please sign in again.',
    refused: 'Aura couldn’t answer that. Try asking in a different way.',
    empty_completion: 'Aura had nothing to say — try rephrasing.',
    prompt_too_large: 'That conversation got too long. Start a new chat.',
    upstream_error: 'Connection problem. Please try again.',
  };

    /* Device voice usable alongside Claude's mic (Claude's own voice can't speak while its mic is on). */
  const deviceVoiceFor = (code) => { if (typeof window.speechSynthesis === 'undefined') return null; return browserVoiceFor(code); };
  ORION.auraAI = { serverOn, notify: emit, useServerVoice, serverVoice: SV, deviceSay, deviceVoiceFor, PLATFORM, LANGS, byCode, cap, init, onChange: (f) => subs.push(f), canSpeak, speechAvailable, speakBrowser, stopBrowser, browserVoiceFor, detectLang, context, ask, split, plainForSpeech, ERR };
})();
