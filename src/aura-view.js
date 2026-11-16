/* Aura chat — mounts either as the Aura page or as the side panel available on every page.
 * Works like an AI assistant: understands the question, uses ORION tools (shown as steps), answers, and
 * proposes actions only through a confirmation the user controls. Voice in (dictation) and out (tts). */
'use strict';
(function () {
  const U = ORION.util, F = ORION.fmt, esc = U.esc, C = ORION.ui, I = C.icon;
  const AI = ORION.auraAI;
  const A = () => ORION.app;
  const ui = () => A().ui;

  let ctl = null, dictBase = '', dictWired = false, ttsWired = false;
  const el = (id) => document.getElementById(id);
  const lang = () => AI.byCode(ui().auraLang);
  const aiOn = () => !!AI.cap.sample && !AI.cap.aiBlocked;

  /* Conversations live only for this visit — nothing old is carried over (like a fresh voice session). */
  function save() { /* intentionally not persisted */ }
  try { localStorage.removeItem('orion.aura.chat'); } catch (e) { /* none */ }

  /* ---------- voice mode state (Claude-style: tap, talk, hear the answer) ---------- */
  const V = { open: false, state: 'ready', heard: '', partial: '', reply: '', timer: null, idle: null, idx: null, streamer: null };
  const END_PAUSE_MS = 1000;   // a pause this long after a phrase = you're done → Aura answers
  const QUICK_END_MS = 600;    // phrase clearly finished (ends with . ? ! or is a known short command) → answer even sooner
  const HOLD_MS = 15000;       // you stopped mid-sentence ("turn on the…") → wait up to 15 s for the rest
  const IDLE_MS = 15000;       // 15 s of silence while listening → back to “Tap to talk”
  const VLABEL = { ready: 'Tap to talk', await: 'Listening…', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking…' };
  const ARTIFACT_URL = 'https://claude.ai/artifact/QpasxJr9n6dezKp6KcjTF7#aura';

  /* ---------- suggestions that fit what's on screen ---------- */
  function suggestions() {
    const app = A(), snap = app.snap;
    const active = snap && snap.incidents ? snap.incidents.filter((i) => i.state !== 'cleared' && i.severity !== 'info') : [];
    if (active.length) return ['What should I do right now?', 'Explain this alert simply', 'What did the devices do?'];
    if (app.route === 'history') return ['Summarise this chart for me', 'When was it highest today?', 'Compare with yesterday'];
    if (app.route === 'devices') return ['Did the last text message go through?', 'Turn on the fan', 'Why can’t I control the door?'];
    return ['Is everything okay at home?', 'Show me today’s temperature', 'Any alerts this week?', 'എന്താണ് ഇപ്പോഴത്തെ താപനില?'];
  }
  const STEP_ICON = { status: 'home', history: 'chart', alerts: 'alert', devices: 'sliders', open: 'chevron', propose: 'check' };

  /* ---------- rendering ---------- */
  function header() {
    const L = lang();
    const mode = !AI.cap.ready ? '' : aiOn() ? '' : '<span class="tag-demo">basic</span>';
    return `<span class="orb lg" aria-hidden="true"></span><div class="au-ti"><h1>Aura ${mode}</h1><span>${aiOn() || !AI.cap.ready ? 'Ask, check, explain — in your language' : 'Simple answers in English'}</span></div>
      <button class="lang-btn" data-action="aura-lang" aria-label="Reply language: ${esc(L.name)}">${I('globe')}<span>${esc(L.code === 'auto' ? 'Auto' : L.native)}</span></button>
      <button class="round sm" data-action="aura-status" aria-label="Aura status" title="What’s working">${I('info')}</button>
      <button class="round sm au-new" data-action="aura-clear" aria-label="New chat" title="New chat">${I('plus')}</button>`;
  }
  function footNote() {
    const L = lang(), notes = [];
    if (AI.cap.ready && !aiOn()) notes.push('Open ORION inside Claude and allow Aura to use Claude for full conversation in your language.');
    else if (L.tier === 'other') notes.push(`${L.name} isn’t in Anthropic’s published language benchmark — double-check important answers.`);
    if (AI.cap.ready && !AI.speechAvailable()) notes.push(AI.PLATFORM.android ? 'The Claude Android app can’t play voices from web pages — Aura answers in text here. For voice, open ORION in Chrome.' : 'Voice replies aren’t available in this app — Aura answers in text.');
    if (ui().auraSpeak && AI.speechAvailable() && !AI.canSpeak(L.code)) notes.push(`Spoken replies aren’t available in ${L.name} here — text only.`);
    return notes.map((n) => `<p class="au-note">${I('info')}${esc(n)}</p>`).join('');
  }
  function stepsHTML(m) {
    if (!m.steps || !m.steps.length) return '';
    return `<ul class="m-steps">${m.steps.map((s) => `<li>${I(STEP_ICON[s.kind] || 'check')}${esc(s.text)}</li>`).join('')}</ul>`;
  }
  function msgHTML(m, idx, last) {
    if (m.role === 'user') return `<div class="m-u" dir="auto">${esc(m.text)}</div>`;
    let inner = stepsHTML(m);
    if (m.status === 'thinking') {
      inner += `<div class="typing" aria-label="Aura is thinking"><i></i><i></i><i></i>${m.steps && m.steps.length ? '' : '<span>Thinking…</span>'}</div>`;
      if (m.waitHint) inner += `<p class="au-note">${I('info')}<span>Still waiting for Claude. If Claude asked whether Aura may use it, choose <b>Allow</b>. You can also tap Stop and try again.</span></p>`;
    }
    else {
      const { facts, body } = AI.split(m.text);
      inner += (facts.length ? `<div class="m-facts"><span>From ORION data</span><ul>${facts.map((f) => `<li dir="auto">${esc(f)}</li>`).join('')}</ul></div>` : '') +
        (body ? `<div class="m-body" dir="auto">${esc(body).replace(/\n/g, '<br>')}</div>` : '');
      if (m.status === 'error') inner += `<div class="m-err">${I('info')}<span>${esc(m.err)}</span><button class="mini" data-action="aura-retry" data-i="${idx}">Try again</button></div>`;
    }
    const busy = m.status === 'streaming' || m.status === 'thinking';
    const speaking = ui().speakingIdx === idx;
    const tools = busy ? `<button class="mini" data-action="aura-stop">${I('stop')}Stop</button>`
      : m.status === 'done' && m.text ? `${AI.speechAvailable() ? `<button class="mini${speaking ? ' on' : ''}" data-action="aura-say" data-i="${idx}">${I(speaking ? 'stop' : 'speaker')}${speaking ? 'Stop' : 'Listen'}</button>` : ''}<button class="mini" data-action="aura-copy" data-i="${idx}">${I('check')}Copy</button>` : '';
    const follow = last && m.status === 'done' ? `<div class="follow">${suggestions().slice(0, 3).map((s) => `<button class="sug sm" data-action="aura-ask" data-q="${esc(s)}" dir="auto">${esc(s)}</button>`).join('')}</div>` : '';
    return `<div class="m-a${m.emergency ? ' em' : ''}" id="msg-${idx}"><div class="m-from"><span class="orb sm" aria-hidden="true"></span>Aura${m.mode === 'basic' ? ' <span class="tag-demo">basic</span>' : ''}</div>${inner}<div class="m-tools">${tools}</div>${follow}</div>`;
  }
  function renderLog() {
    const log = el('au-log'); if (!log) return;
    const msgs = ui().auraMsgs;
    if (!msgs.length) {
      log.innerHTML = `<div class="au-hello"><span class="orb xl" aria-hidden="true"></span><h2>Hi, I’m Aura.</h2><p>I can check your sensors, look back through history, explain alerts and open the right page for you. Type or tap the mic — in English or your own language.</p>
        <div class="sugs">${suggestions().map((s) => `<button class="sug" data-action="aura-ask" data-q="${esc(s)}" dir="auto">${esc(s)}</button>`).join('')}</div></div>`;
      return;
    }
    log.innerHTML = msgs.map((m, i) => msgHTML(m, i, i === msgs.length - 1)).join('');
    log.scrollTop = log.scrollHeight;
  }
  function renderMsg(idx) {
    const n = el('msg-' + idx); if (!n) { renderLog(); return vSync(idx); }
    const msgs = ui().auraMsgs;
    n.outerHTML = msgHTML(msgs[idx], idx, idx === msgs.length - 1);
    const log = el('au-log'); if (log) log.scrollTop = log.scrollHeight;
    vSync(idx);
  }
  function renderChrome() {
    const h = el('au-head'); if (h) h.innerHTML = header();
    const f = el('au-foot'); if (f) f.innerHTML = footNote();
    const mic = el('au-mic'); if (mic) mic.hidden = !AI.cap.dict;
    const vb = el('au-voice'); if (vb) vb.hidden = false;
    const sp = el('au-speak'); if (sp) { sp.hidden = !AI.speechAvailable(); sp.setAttribute('aria-pressed', String(!!ui().auraSpeak)); sp.classList.toggle('on', !!ui().auraSpeak); sp.innerHTML = I('speaker') + (ui().auraSpeak ? 'Speaking replies' : 'Read replies aloud'); }
  }

  /* ---------- asking ---------- */
  async function send(text, viaVoice) {
    text = String(text || '').trim();
    if (!text) return;
    if (ctl) { A().toast('Aura is still answering — tap Stop to ask something else.'); return; }
    const u = ui();
    if (viaVoice && AI.cap.tts && !u.auraSpeakSet) { u.auraSpeak = true; renderChrome(); }
    u.auraMsgs.push({ role: 'user', text, at: Date.now() });
    const msg = { role: 'assistant', text: '', status: 'thinking', at: Date.now(), lang: u.auraLang, steps: [], voice: V.open };
    u.auraMsgs.push(msg);
    const idx = u.auraMsgs.length - 1;
    renderLog();
    const inp = el('au-in'); if (inp) inp.value = '';
    if (!AI.cap.ready) { msg.steps.push({ kind: 'status', text: 'Connecting to Claude…' }); renderMsg(idx); await AI.ready; msg.steps = []; }
    if (!aiOn()) return basic(msg, idx, text);
    msg.mode = 'ai';
    await run(msg, idx, true);
  }

  async function run(msg, idx, allowTools) {
    const u = ui();
    ctl = new AbortController();
    const turns = u.auraMsgs.slice(0, idx).filter((m) => m.role === 'user' || (m.status === 'done' && m.mode === 'ai' && m.text)).map((m) => ({ role: m.role, content: m.text }));
    while (turns.length && turns[0].role !== 'user') turns.shift();
    let retry = false;
    const hintT = setTimeout(() => { if (msg.status === 'thinking') { msg.waitHint = true; renderMsg(idx); } }, 8000);
    // Speak each sentence the moment it is written, instead of waiting for the whole answer.
    const S = u.auraSpeak && AI.speechAvailable() ? makeStreamer(msg, idx) : null;
    if (S) msg.streamed = true;
    try {
      const { text: out, truncated } = await AI.ask(A(), turns, u.auraLang, {
        tier: msg.voice ? 'quick' : u.auraTier, signal: ctl.signal, tools: allowTools, voice: !!msg.voice,
        onStep: (kind, t) => { msg.steps.push({ kind, text: t }); if (msg.status === 'thinking') renderMsg(idx); },
        onText: ({ text: t }) => { msg.text = t; msg.status = 'streaming'; renderMsg(idx); if (S) S.push(t); },
      });
      msg.text = out + (truncated ? '\n\n(Reply cut short.)' : ''); msg.status = 'done'; AI.cap.lastError = null;
      msg.emergency = /\b112\b|\b101\b/.test(out);
      if (S) S.finish(out);
    } catch (e) {
      const code = (e && e.code) || 'upstream_error';
      if (code !== 'cancelled') { AI.cap.lastError = code; console.warn('Aura sample failed', e); }
      msg.text = (e && e.text) || '';
      if (S) { if (code === 'cancelled') S.cancel(); else S.finish(msg.text); }
      if (code === 'cancelled') { msg.status = 'done'; if (!msg.text) msg.text = '(Stopped.)'; }
      else if (code === 'tools_unavailable') { AI.cap.tools = false; retry = true; if (S) S.cancel(); msg.streamed = false; }
      else if (['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'].includes(code)) {
        AI.cap.aiBlocked = true; ctl = null; renderChrome(); return basic(msg, idx, u.auraMsgs[idx - 1].text);
      } else { msg.status = 'error'; msg.err = AI.ERR[code] || AI.ERR.upstream_error; if (code === 'refused') msg.text = ''; }
    }
    clearTimeout(hintT); msg.waitHint = false;
    ctl = null;
    if (retry) { msg.steps = []; msg.text = ''; msg.status = 'thinking'; renderMsg(idx); return run(msg, idx, false); }
    renderMsg(idx); save();
    if (msg.status === 'done' && u.auraSpeak && !msg.streamed) say(idx);
  }

  /* ---------- which voice speaks ----------
     One voice for the whole conversation: the Claude voice the person picked, every time.
     Claude's voice can't play while Claude's mic is open, so the mic is switched off before Aura speaks
     (one tap to reply). Only if the person turns on “Keep listening” does the device's voice take over. */
  function pickEngine(code) {
    const d = AI.cap.dict, live = V.open && d && d.active();
    if (AI.cap.tts && !(ui().auraHandsFree && live && AI.deviceVoiceFor(code))) return 'claude';
    if (AI.deviceVoiceFor(code) || (AI.cap.browserTts && !AI.cap.tts)) return 'device';
    return AI.cap.tts ? 'claude' : 'none';
  }

  /* ---------- speak-as-it-streams ---------- */
  function makeStreamer(msg, idx) {
    const S = { spoken: 0, started: false, engine: null, out: 0, finished: false, cancelled: false, ended: false, code: null, gate: null, claudeOn: false, buffer: '' };
    const BOUND = /[.!?।]+["'”’)\]]*\s+|\n+/g;
    function check() {
      if (S.ended || S.cancelled || !S.finished || S.out > 0) return;
      S.ended = true; if (V.streamer === S) V.streamer = null;
      if (ui().speakingIdx === idx) { ui().speakingIdx = null; renderMsg(idx); }
      if (V.open && (V.state === 'speaking' || V.state === 'thinking')) afterSpeech();
    }
    function begin(txt) {
      S.started = true;
      // The reply's language is decided once, so every sentence is read the same way (no voice change mid-reply).
      S.code = msg.lang && msg.lang !== 'auto' ? msg.lang : (msg.replyLang || AI.detectLang(txt));
      const d = AI.cap.dict, live = V.open && d && d.active();
      S.engine = pickEngine(S.code);
      if (S.engine === 'none') { A().toast(`There’s no ${AI.byCode(S.code).name} voice on this device — showing text only.`); return; }
      if (S.engine === 'claude') {
        if (live) { V.handoff = true; V.conv = false; S.gate = d.stop().catch(() => {}); }
        else if (V.preStop) S.gate = V.preStop;
        V.preStop = null;
      }
      if (S.engine === 'device') { try { const ss = window.speechSynthesis; if (ss.speaking || ss.pending) ss.cancel(); } catch (e) { /* none */ } }
      ui().speakingIdx = idx;
      if (V.open) { clearIdle(); V.state = 'speaking'; vRender(); }
    }
    function claudeSay(txt) {
      const t = AI.cap.tts;
      const opts = { voice: ui().auraVoice, rate: ui().auraRate, language: S.code }; // same voice + language on every line
      const first = !S.claudeOn; S.claudeOn = true;
      const go = () => (S.cancelled ? Promise.resolve() : first || typeof t.add !== 'function' ? t.speak(txt, opts) : t.add(txt, opts));
      return (S.gate || Promise.resolve()).then(go).then(() => { AI.cap.lastSpeechError = null; }, (e) => {
        const c = e && e.code; AI.cap.lastSpeechError = c;
        if (c === 'not_granted') { AI.cap.tts = null; ui().auraSpeak = false; renderChrome(); A().toast('Reading aloud is turned off for ORION in Claude’s permissions.'); }
        else if (c === 'stopped') S.cancelled = true;
        else if (c === 'rate_limited') A().toast('Voice is busy — try again shortly.');
      });
    }
    function sayPiece(piece) {
      const txt = AI.plainForSpeech(piece); if (!txt || S.cancelled) return;
      if (!S.started) begin(txt);
      if (S.engine === 'none') return;
      if (S.engine === 'claude' && typeof AI.cap.tts.add !== 'function' && !S.finished) { S.buffer += ' ' + txt; return; } // no add(): speak once at the end
      const t = S.buffer ? (S.buffer + ' ' + txt).trim() : txt; S.buffer = '';
      S.out++;
      const p = S.engine === 'device' ? AI.deviceSay(t, S.code, ui().auraRate) : claudeSay(t);
      p.finally(() => { S.out--; check(); });
    }
    const CLAUSE = /[,;:،]\s+/g;
    S.push = (full) => {
      if (S.cancelled) return;
      let cut = -1, m; BOUND.lastIndex = S.spoken;
      while ((m = BOUND.exec(full))) cut = m.index + m[0].length;
      if (cut < 0 && !S.started) { // nothing finished yet: start on the first clause once it is long enough to sound natural
        CLAUSE.lastIndex = 0;
        while ((m = CLAUSE.exec(full))) { if (m.index >= 32) { cut = m.index + m[0].length; break; } }
      }
      if (cut > S.spoken) { const piece = full.slice(S.spoken, cut); S.spoken = cut; sayPiece(piece); }
    };
    S.finish = (full) => {
      if (S.cancelled) return;
      full = full || '';
      S.finished = true;
      if (full.length > S.spoken) { const piece = full.slice(S.spoken); S.spoken = full.length; sayPiece(piece); }
      else if (S.buffer) sayPiece('');
      check();
    };
    S.cancel = () => { S.cancelled = true; S.finished = true; if (V.streamer === S) V.streamer = null; if (ui().speakingIdx === idx) ui().speakingIdx = null; };
    V.streamer = S;
    return S;
  }

  function basic(msg, idx, q) {
    const app = A();
    const r = ORION.aura.answer(q, app.source.snapshot(), app.ev || {}, app.config);
    const facts = r.facts.map((f) => `• ${f.label}: ${f.value}${f.at ? ` (${F.time(f.at)})` : ''}${f.status && f.status !== 'fresh' ? ' — ' + f.status : ''}`);
    msg.text = (facts.length ? facts.join('\n') + '\n\n' : '') + r.interp + (r.caveats.length ? '\n\n' + r.caveats.join(' ') : '');
    msg.mode = 'basic'; msg.status = 'done'; msg.emergency = !!r.emergency; msg.lang = 'en';
    renderMsg(idx); save();
    if (ui().auraSpeak) say(idx);
  }

  /* ---------- voice out ---------- */
  function say(idx) {
    const m = ui().auraMsgs[idx];
    if (!m || !AI.speechAvailable()) return;
    if (ui().speakingIdx === idx) { if (AI.cap.tts) AI.cap.tts.stop().catch(() => {}); else AI.stopBrowser(); ui().speakingIdx = null; renderMsg(idx); return; }
    const code = m.lang && m.lang !== 'auto' ? m.lang : AI.detectLang(m.text);
    if (!AI.canSpeak(code)) { A().toast(`There’s no ${AI.byCode(code).name} voice on this device — showing text only.`); if (V.open) { V.state = 'ready'; vRender(); } return; }
    const txt = AI.plainForSpeech(m.text).slice(0, 1990);
    if (!txt) return;
    ui().speakingIdx = idx; renderMsg(idx);
    if (V.open) { V.state = 'speaking'; vRender(); }
    const done = () => { if (ui().speakingIdx === idx) { ui().speakingIdx = null; renderMsg(idx); } if (V.open && V.state === 'speaking') afterSpeech(); };
    const d = AI.cap.dict, live = V.open && d && d.active(), eng = pickEngine(code);
    if (eng === 'device') { AI.speakBrowser(txt, code, done, ui().auraRate); return; }
    if (live) { V.handoff = true; V.conv = false; d.stop().catch(() => {}).then(() => sayClaude(txt, code, done)); return; }
    sayClaude(txt, code, done);
  }
  function sayClaude(txt, code, done) {
    {
      const opts = { voice: ui().auraVoice, rate: ui().auraRate, language: code };
      AI.cap.tts.speak(txt, opts).then(() => { AI.cap.lastSpeechError = null; }, (e) => { AI.cap.lastSpeechError = e && e.code; throw e; }).catch((e) => {
        if (e && e.code === 'not_granted') { AI.cap.tts = null; ui().auraSpeak = false; renderChrome(); A().toast('Reading aloud is turned off for ORION in Claude’s permissions.'); }
        else if (e && e.code === 'no_gesture') A().toast('Tap Listen to hear the reply.');
        else if (e && e.code === 'rate_limited') A().toast('Voice is busy — try again shortly.');
        else if (e && e.code !== 'stopped') A().toast('Couldn’t play the voice reply.');
      }).finally(done);
    }
  }
  function wireTts() {
    if (ttsWired || !AI.cap.tts) return; ttsWired = true;
    AI.cap.tts.onState(({ state }) => { if (state === 'idle' && ui().speakingIdx != null) { const i = ui().speakingIdx; ui().speakingIdx = null; renderMsg(i); } });
  }

  /* ---------- voice in ---------- */
  function wireDict() {
    const d = AI.cap.dict; if (dictWired || !d) return; dictWired = true;
    d.onPartial(({ text }) => { if (V.open) { if (vMuted()) return; if (text) { clearIdle(); clearHold(); } if (text && V.shown && !V.heard) V.shown = ''; V.partial = text; armSilence(); return vRender(); } const i = el('au-in'); if (i) { i.value = (dictBase + (text ? (dictBase ? ' ' : '') + text : '')).trimStart(); i.classList.add('provisional'); } });
    d.onFinal(({ text }) => { if (V.open) { if (vMuted()) return; clearIdle(); clearHold(); V.partialWaited = false; V.shown = ''; V.heard = (V.heard + text).trimStart(); V.partial = ''; armSilence(); return vRender(); } dictBase = (dictBase + text).trimStart(); const i = el('au-in'); if (i) { i.value = dictBase; i.classList.remove('provisional'); } });
    d.onState(({ state, reason }) => {
      const m = el('au-mic'); if (m) { m.classList.toggle('on', state !== 'idle'); m.setAttribute('aria-pressed', String(state !== 'idle')); m.innerHTML = I(state === 'idle' ? 'mic' : 'stop'); }
      const w = el('au-wrap'); if (w) w.classList.toggle('listening', state === 'listening' || state === 'starting');
      if (V.open) {
        if (state === 'starting') { V.micStarting = true; vRender(); }
        if (state === 'listening') { V.micStarting = false; V.micOn = true; if (V.state === 'listening' && !V.heard && !V.partial) armIdle(); vRender(); }
        if (state === 'idle') {
          V.micStarting = false; V.micOn = false;
          clearTimeout(V.timer); clearIdle();
          const wasConv = V.conv; V.conv = false;
          if (V.handoff) { V.handoff = false; return; } // we paused the mic so Claude's voice can speak
          const said = (V.heard + (V.partial ? ' ' + V.partial : '')).trim();
          V.partial = '';
          if (said && V.state === 'listening' && (reason === 'stopped' || reason === 'viewer_stopped' || wasConv)) vSubmit();
          else if (V.state === 'listening') { V.state = 'ready'; vRender(); }
          if (reason === 'not_granted') { AI.cap.dict = null; A().toast('Microphone not allowed — you can still type.'); voiceClose(); }
        }
        return;
      }
      if (state === 'idle') {
        const i = el('au-in'); if (i) i.classList.remove('provisional');
        if ((reason === 'stopped' || reason === 'viewer_stopped') && i && i.value.trim()) send(i.value, true);
        if (reason === 'not_granted') { AI.cap.dict = null; renderChrome(); A().toast('Microphone not allowed — you can still type.'); }
      }
    });
  }
  function micClick() {
    const d = AI.cap.dict; if (!d) return;
    if (d.active()) { d.stop().catch(() => {}); return; }
    if (AI.cap.tts && ui().speakingIdx != null) AI.cap.tts.stop().catch(() => {});
    const i = el('au-in'); dictBase = i ? i.value.trim() : '';
    const L = lang();
    const p = L.code === 'auto' ? d.start() : d.start({ language: L.code });
    p.catch((e) => {
      const code = e && e.code;
      if (code === 'unavailable') A().toast(L.code === 'auto' ? 'Voice input isn’t available here — please type.' : `Voice input isn’t available in ${L.name} yet. Try Auto or English, or type (your phone keyboard’s mic works too).`);
      else if (code === 'not_granted') { AI.cap.dict = null; renderChrome(); A().toast('Microphone not allowed — you can still type.'); }
      else if (code === 'rate_limited') A().toast('Voice input is busy — try again in a moment.');
      else if (code && code !== 'stopped' && code !== 'dismissed') A().toast('Voice input didn’t start. Please try again.');
    });
  }

  /* ---------- language sheet ---------- */
  function langSheet() {
    const u = ui();
    const row = (L) => {
      const voice = AI.cap.tts ? (AI.canSpeak(L.code) ? '<span class="lf ok">voice</span>' : '<span class="lf">text</span>') : '';
      const tier = L.tier === 'bench' ? '<span class="lf ok">tested</span>' : L.tier === 'other' ? '<span class="lf">not benchmarked</span>' : '';
      return `<button class="lang-row${u.auraLang === L.code ? ' on' : ''}" data-action="aura-setlang" data-l="${L.code}"><span class="ln" dir="auto">${esc(L.native)}</span><span class="le">${esc(L.name)}</span>${tier}${voice}</button>`;
    };
    return `<div class="sh-head">${I('globe', 'sh-ic')}<div><h2 id="md-t">Language &amp; voice</h2><span class="hint">Aura understands what you write or say and replies in the language you pick.</span></div></div>
      <div class="lang-list">${AI.LANGS.map(row).join('')}</div>
      <p class="hint"><b>Tested</b> — Anthropic publishes results for Claude in this language (Hindi and Bengali score within a few percent of English). <b>Not benchmarked</b> — Claude can usually reply in it, but there are no published results, so check important answers. Voice depends on your browser and device.</p>
      <h3>Voice</h3>
      ${AI.cap.tts ? `<div class="voices">${VOICES.map(([v, l, d]) => `<button class="voice-row${u.auraVoice === v ? ' on' : ''}" data-action="aura-voice" data-v="${v}">${I('speaker')}<span><b>${l}</b><small>${d}</small></span></button>`).join('')}</div>
        <div class="row-btns" style="margin:8px 0 0"><button class="btn sm ghost" data-action="voice-test">${I('speaker')}Test voice</button></div>
        <p class="hint">Rounded is the default. Tap a voice to hear it. In some regional languages Claude may use one voice for that language whichever you pick.</p>`
        : AI.cap.browserTts ? '<p class="hint">Using this device’s built-in voice. Claude’s voices are offered in Chrome and the Claude desktop app.</p>' : '<p class="hint">No voice is available in this browser — replies are shown as text.</p>'}
      ${AI.cap.tts ? `<div class="set-row"><div><b>Keep listening after each reply</b><span class="hint">Off: Aura always speaks in the voice you picked, and you tap once to reply. On: the mic stays open, so Aura has to use your device’s voice instead (Claude’s voice can’t speak while its mic is on).</span></div>
        <div class="seg">${[[false, 'Off'], [true, 'On']].map(([v, l]) => `<button class="seg-b${u.auraHandsFree === v ? ' on' : ''}" data-action="aura-handsfree" data-v="${v}">${l}</button>`).join('')}</div></div>` : ''}
      <div class="set-row"><div><b>Speaking speed</b></div><div class="seg">${[[0.9, 'Slower'], [1, 'Normal'], [1.15, 'Faster']].map(([v, l]) => `<button class="seg-b${u.auraRate === v ? ' on' : ''}" data-action="aura-rate" data-v="${v}">${l}</button>`).join('')}</div></div>
      <div class="set-row muted-row"><div><b>ElevenLabs voices</b><span class="hint">Planned for Phase 2. ElevenLabs needs a secret API key, which must stay on ORION’s own server — never inside this page — so it arrives with the backend.</span></div><span class="chip-s s-off">Phase 2</span></div>
      <h3>Answers</h3>
      <div class="set-row"><div><b>Answer style</b><span class="hint">Careful is slower but more accurate, especially in regional languages.</span></div>
        <div class="seg">${[['quick', 'Quick'], ['default', 'Careful']].map(([v, l]) => `<button class="seg-b${u.auraTier === v ? ' on' : ''}" data-action="aura-tier" data-v="${v}">${l}</button>`).join('')}</div></div>`;
  }

  /* ---------- voice mode ---------- */
  const VOICES = [['buttery', 'Buttery', 'Warm and smooth'], ['airy', 'Airy', 'Light and gentle'], ['glassy', 'Glassy', 'Clear and crisp'], ['rounded', 'Rounded', 'Calm and steady']];
  const SAMPLE = { en: 'Hi, I’m Aura. Everything in your home is being watched over.', ml: 'നമസ്കാരം, ഞാൻ ഓറയാണ്. നിങ്ങളുടെ വീട് ഞാൻ ശ്രദ്ധിക്കുന്നുണ്ട്.', hi: 'नमस्ते, मैं ओरा हूँ। मैं आपके घर पर नज़र रख रही हूँ।', ta: 'வணக்கம், நான் ஆரா. உங்கள் வீட்டை நான் கவனித்துக்கொள்கிறேன்.' };
  /* When has the person finished? Finished-sounding → answer fast. Stopped mid-sentence → wait up to 5 s. */
  const UNFINISHED = /(?:^|\s)(and|or|but|the|a|an|to|of|for|with|about|in|on|at|from|is|are|was|what|which|how|when|where|why|if|so|then|my|your|also|please|because|like|um|uh|aur|ki|ka|ke|ko|se|और|कि|का|के|को|से|या|पिन्ने|പിന്നെ|എന്നിട്ട്|കൂടെ|ഒന്ന്)\s*$/i;
  function endKind(text) {
    const t = text.trim(); if (!t) return 'none';
    if (UNFINISHED.test(t)) return 'hold';
    if (/[.?!।]["'”’)]*$/.test(t) || END.test(t) || /\?$/.test(t)) return 'quick';
    return 'normal';
  }
  function armSilence() {
    clearTimeout(V.timer); clearHold();
    V.timer = setTimeout(function tick() {
      if (V.state !== 'listening') return;
      const text = (V.heard + (V.partial ? ' ' + V.partial : '')).trim();
      if (!text) return;
      if (V.partial && !V.partialWaited) { V.partialWaited = true; V.timer = setTimeout(tick, END_PAUSE_MS); return; } // still settling
      V.partialWaited = false;
      const k = endKind(text);
      if (k === 'hold') return startHold();
      vSubmit();
    }, endKind(V.heard) === 'quick' && !V.partial ? QUICK_END_MS : END_PAUSE_MS);
  }
  /* Paused mid-sentence: keep listening quietly; after 5 s of silence go back to “Tap to talk” and keep the words,
     so the next tap simply continues the same sentence. */
  function startHold() {
    clearHold();
    V.hold = setTimeout(() => {
      V.hold = null;
      if (!V.open || V.state !== 'listening') return;
      V.carry = (V.heard + (V.partial ? ' ' + V.partial : '')).trim();
      V.heard = ''; V.partial = '';
      endConversation(); V.shown = V.carry ? V.carry + ' …' : ''; V.reply = ''; vRender();
    }, HOLD_MS);
    vRender();
  }
  function clearHold() { if (V.hold) { clearTimeout(V.hold); V.hold = null; } }
  /* 5 seconds of silence while listening → go back to “Tap to talk”. No countdown is shown. */
  function armIdle() { clearTimeout(V.idle); V.idle = setTimeout(onIdle, IDLE_MS); }
  function clearIdle() { clearTimeout(V.idle); V.idle = null; }
  function onIdle() {
    V.idle = null;
    if (V.micStarting) { armIdle(); return; }
    if (!V.open) return;
    if (V.state === 'listening' && !V.heard.trim() && !V.partial) { endConversation(); V.shown = V.carry ? V.carry + ' …' : ''; V.reply = ''; vRender(); }
    else if (V.state === 'await') { const i = el('vo-in'); if (i && !i.value.trim()) { i.blur(); V.state = 'ready'; V.shown = ''; V.reply = ''; vRender(); } }
  }
  const vMuted = () => V.state === 'thinking' || V.state === 'speaking' || Date.now() < (V.muteUntil || 0);
  const END = /^(stop|stop listening|bye|bye aura|goodbye|good bye|that'?s all|thank you,? bye|ok bye|നിർത്ത്|നിർത്തൂ|മതി|ബൈ|बस|बंद करो|रुको)[.!]?$/i;
  function vSubmit() {
    clearTimeout(V.timer); clearIdle(); clearHold();
    const said = ((V.carry ? V.carry + ' ' : '') + V.heard + (V.partial ? ' ' + V.partial : '')).trim();
    V.heard = ''; V.partial = ''; V.carry = '';
    if (!said) return;
    if (END.test(said)) { V.shown = said; V.reply = 'Okay — I’m here whenever you need me.'; endConversation(); return; }
    V.shown = said; V.reply = ''; V.state = 'thinking'; vRender();
    // If this reply will need Claude's own voice (no device voice for the language), switch the mic off now,
    // while Aura is still thinking — not after the answer arrives.
    const d = AI.cap.dict, code = ui().auraLang !== 'auto' ? ui().auraLang : AI.detectLang(said);
    if (ui().auraSpeak && d && d.active() && pickEngine(code) === 'claude') { V.handoff = true; V.conv = false; V.preStop = d.stop().catch(() => {}); }
    send(said, true);
  }
  function endConversation() {
    V.conv = false; clearTimeout(V.timer); clearIdle();
    const d = AI.cap.dict; if (d && d.active()) d.stop().catch(() => {});
    V.state = 'ready'; vRender();
  }
  /* After Aura speaks: carry on listening for the next request (like a real voice assistant). */
  function afterSpeech() {
    if (!V.open) return;
    const d = AI.cap.dict;
    if (V.conv && d && d.active()) { V.muteUntil = Date.now() + 350; V.state = 'listening'; vRender(); armIdle(); return; }
    if (V.kb) {
      const i = el('vo-in');
      if (i) {
        const h0 = window.visualViewport ? window.visualViewport.height : window.innerHeight;
        i.value = ''; try { i.focus({ preventScroll: true }); } catch (e) { i.focus(); }
        setTimeout(() => { const h1 = window.visualViewport ? window.visualViewport.height : window.innerHeight; V.state = document.activeElement === i && h1 < h0 * 0.85 ? 'await' : 'ready'; vRender(); if (V.state === 'await') armIdle(); }, 500);
        return;
      }
    }
    V.state = 'ready'; vRender();
  }
  function vSync(idx) {
    if (!V.open) return;
    const msgs = ui().auraMsgs, m = msgs[msgs.length - 1];
    if (!m || m.role !== 'assistant') return;
    if (m.status === 'thinking') { V.state = 'thinking'; V.reply = m.steps && m.steps.length ? m.steps[m.steps.length - 1].text : ''; }
    else if (m.status === 'streaming') { V.reply = AI.split(m.text).body || AI.plainForSpeech(m.text); }
    else if (m.status === 'done' || m.status === 'error') {
      V.reply = m.status === 'error' ? m.err : (AI.split(m.text).body || AI.plainForSpeech(m.text));
      if (V.state === 'thinking' && !m.streamed && (m.status === 'error' || !ui().auraSpeak || !AI.speechAvailable())) { vRender(); return afterSpeech(); }
    }
    vRender();
  }
  function vRender() {
    const o = el('voiceOverlay'); if (!o) return;
    o.dataset.state = V.state;
    o.querySelector('.vo-label').textContent = V.state === 'listening' && V.micStarting ? 'Starting the mic…' : V.state === 'ready' && V.reply && !V.kb ? 'Tap to reply' : VLABEL[V.state];
    const hint = o.querySelector('.vo-hint');
    if (hint) hint.textContent = V.state === 'speaking' ? 'Tap to interrupt'
      : V.kb && V.state === 'await' ? 'Speak using the 🎤 on your keyboard'
      : V.state === 'listening' && (V.heard || V.partial) && !V.kb ? 'Tap when you’re done' : '';
    o.classList.toggle('typing', !!V.typing);
    o.classList.toggle('kb', !!V.kb);
    const you = (V.heard + (V.partial ? ' ' + V.partial : '')).trim() || V.shown || '';
    o.querySelector('.vo-you').textContent = you;
    o.querySelector('.vo-you').hidden = !you;
    o.querySelector('.vo-aura').textContent = V.reply || '';
    o.querySelector('.vo-lang span').textContent = lang().code === 'auto' ? 'Auto' : lang().native;
  }
  function voiceOpen() {
    if (V.open) return;
    V.kb = AI.cap.ready && !AI.cap.dict; V.typing = false; // no Claude mic here → the phone keyboard's mic, behind the same orb
    wireDict(); wireTts();
    V.open = true; V.state = 'ready'; V.heard = ''; V.partial = ''; V.reply = '';
    ui().auraSpeak = true; renderChrome();
    const o = document.createElement('div');
    o.id = 'voiceOverlay'; o.className = 'vo'; o.setAttribute('role', 'dialog'); o.setAttribute('aria-label', 'Aura voice mode');
    o.innerHTML = `<div class="vo-top"><button class="vo-lang" data-action="aura-lang">${I('globe')}<span></span></button><button class="round vo-x" data-action="voice-close" aria-label="End voice mode">${I('x')}</button></div>
      <div class="vo-mid" data-action="voice-orb"><button class="vo-orb" data-action="voice-orb" aria-label="Talk to Aura"><span class="vo-ring"></span><span class="vo-core"></span></button>
      <div class="vo-label" aria-live="polite"></div><div class="vo-hint hint"></div><p class="vo-you" dir="auto"></p><p class="vo-aura" dir="auto" aria-live="polite"></p>
      <form class="vo-kb" id="vo-kb" autocomplete="off" data-action="noop"><input id="vo-in" dir="auto" enterkeyhint="send" autocapitalize="sentences" aria-label="Speak or type to Aura"><button class="round send" aria-label="Send">${I('send')}</button></form></div>
      <div class="vo-foot">${!AI.speechAvailable() ? `<p class="vo-warn">${I('info')}${AI.PLATFORM.android ? 'The Claude Android app can’t play voices from web pages, so Aura will answer in text here. Open in Chrome to hear Aura.' : 'This app can’t play voices from web pages, so Aura will answer in text here.'}</p>` : ''}<div class="vo-alt"><button class="mini" data-action="voice-type">${I('sliders')}Type instead</button>${AI.PLATFORM.android ? `<a class="mini" href="${ARTIFACT_URL}">${I('globe')}Hands-free: open in Chrome</a>` : ''}</div><span class="hint">Aura can’t control devices by itself. In an emergency, call 112.</span></div>`;
    document.body.appendChild(o);
    {
      const inp = o.querySelector('#vo-in');
      inp.addEventListener('input', () => { if (!V.kb && !V.typing) return; clearIdle(); V.heard = inp.value; V.partial = ''; if (V.state === 'speaking') stopSpeech(); V.state = inp.value.trim() ? 'listening' : 'await'; vRender(); if (inp.value.trim()) armKb(); else armIdle(); });
      inp.addEventListener('blur', () => { setTimeout(() => { if (V.open && V.state === 'await' && !inp.value.trim() && document.activeElement !== inp) { clearIdle(); V.state = 'ready'; vRender(); } }, 150); });
      o.querySelector('#vo-kb').addEventListener('submit', (e) => { e.preventDefault(); kbSend(); });
    }
    vRender();
    o.querySelector('.vo-orb').focus({ preventScroll: true });
  }
  function voiceClose() {
    if (!V.open) return;
    V.open = false; V.conv = false; V.carry = ''; clearTimeout(V.timer); clearIdle(); clearHold();
    if (V.streamer) V.streamer.cancel();
    const d = AI.cap.dict; if (d && d.active()) d.stop().catch(() => {});
    if (AI.cap.tts) AI.cap.tts.stop().catch(() => {}); else AI.stopBrowser();
    const o = el('voiceOverlay'); if (o) o.remove();
    renderLog();
  }
  function stopSpeech() { if (V.streamer) V.streamer.cancel(); if (AI.cap.tts) AI.cap.tts.stop().catch(() => {}); AI.stopBrowser(); ui().speakingIdx = null; }
  /* Keyboard-voice: send automatically after a short pause in what the keyboard's mic writes. */
  function armKb() {
    clearTimeout(V.timer);
    const i0 = el('vo-in'), k = endKind(i0 ? i0.value : '');
    V.timer = setTimeout(() => { const i = el('vo-in'); if (i && i.value.trim() && V.state === 'listening') kbSend(); }, k === 'hold' ? HOLD_MS : k === 'quick' ? 800 : 1200);
  }
  function kbSend() {
    clearTimeout(V.timer); clearIdle();
    const i = el('vo-in'); if (!i) return;
    const said = i.value.trim(); if (!said) return;
    i.value = ''; i.blur(); // close the keyboard so the answer can be heard and seen
    V.heard = said; V.state = 'thinking'; vRender(); send(said, true);
  }
  function kbTip() {
    const P = AI.PLATFORM;
    if (P.ios) return 'On iPhone: tap the box, then the mic on the keyboard and speak. Aura sends when you pause. (Turn on Dictation in Settings › General › Keyboard if you don’t see the mic.)';
    if (P.android) return 'On Android: tap the box, then the mic on your keyboard (Gboard supports മലയാളം, हिन्दी and more). Aura sends when you pause.';
    return 'Use your keyboard’s or system’s dictation to speak. Aura sends when you pause.';
  }
  function orbTap() {
    V.kb = !AI.cap.dict;
    if (V.kb) {
      if (V.state === 'speaking') { stopSpeech(); if (ctl) ctl.abort(); }
      else if (V.state === 'thinking' && ctl) ctl.abort();
      V.heard = ''; V.partial = ''; V.reply = ''; V.shown = '';
      const i = el('vo-in'); if (i) { i.value = ''; i.focus(); }
      V.state = 'await'; vRender(); armIdle();
      return;
    }
    const d = AI.cap.dict;
    if (V.state === 'listening' && d.active()) {
      if ((V.heard + V.partial).trim()) vSubmit();      // “I’m done” — answer now
      else { armIdle(); vRender(); }                    // already listening — just keep listening
      return;
    }
    if (V.state === 'thinking') { if (ctl) ctl.abort(); }
    const wasSpeaking = V.state === 'speaking';
    if (wasSpeaking) { stopSpeech(); if (ctl) ctl.abort(); }
    V.heard = ''; V.partial = ''; V.reply = ''; V.muteUntil = wasSpeaking ? Date.now() + 250 : 0;
    if (!V.carry || wasSpeaking) { V.carry = ''; V.shown = ''; } // a sentence left unfinished continues on this tap
    if (d.active()) { V.conv = true; V.state = 'listening'; vRender(); armIdle(); return; } // interrupted Aura — keep listening
    const L = lang();
    const p = L.code === 'auto' ? d.start() : d.start({ language: L.code }); // must be the first thing after the tap
    V.conv = true; V.state = 'listening'; V.micStarting = true; vRender(); // silence timer starts once the mic is actually on
    p.then(() => { AI.cap.lastDictError = null; if (V.open && V.state === 'listening' && !V.heard && !V.partial && !V.idle) armIdle(); }, (e) => {
      const code = (e && e.code) || 'upstream_error';
      AI.cap.lastDictError = code;
      V.conv = false; V.micStarting = false; clearIdle(); V.state = 'ready'; vRender();
      if (code === 'unavailable') A().toast(L.code === 'auto' ? 'Voice input isn’t available here.' : `Voice input isn’t available in ${L.name} yet — switch the language to Auto or English.`);
      else if (code === 'not_granted') { AI.cap.dict = null; A().toast('Microphone isn’t allowed for ORION. Turn it on in the artifact’s Permissions menu, then tap again.'); voiceClose(); }
      else if (code === 'rate_limited') A().toast('Voice input is busy — try again in a moment.');
      else if (code === 'dismissed') A().toast('The microphone question was closed. Tap the orb and choose Allow.');
      else if (code === 'no_gesture') A().toast('Tap the orb to start listening.');
      else if (code !== 'stopped') A().toast('The microphone didn’t start. Tap the orb to try again.');
    });
  }
  function previewVoice(v) {
    if (v) { ui().auraVoice = v; U.store.set('orion.aura.voice', v); }
    const L = lang(), code = L.code === 'auto' ? 'en' : L.code;
    const text = SAMPLE[code] || SAMPLE.en, tcode = SAMPLE[code] ? code : 'en';
    if (AI.cap.tts) {
      AI.cap.tts.speak(text, { voice: ui().auraVoice, rate: ui().auraRate, language: tcode }).then(() => {}, (e) => {
        const c = e && e.code;
        A().toast(c === 'not_granted' ? 'Reading aloud is turned off for ORION in Claude’s permissions.' : c === 'busy' ? 'Stop the mic first, then test again.' : c === 'rate_limited' ? 'Voice is busy — try again shortly.' : 'The voice test didn’t play. Check your volume and try again.');
      });
    } else if (AI.cap.browserTts) {
      if (!AI.speakBrowser(text, tcode, null, ui().auraRate)) A().toast('The voice test didn’t play on this device.');
    } else A().toast('No voice is available in this browser. Try Chrome or the Claude desktop app.');
  }

  /* ---------- what's working (diagnostics in plain words) ---------- */
  function statusSheet() {
    const c = AI.cap, L = lang();
    const row = (ok, title, text) => `<li class="${ok ? 'ok' : 'no'}">${I(ok ? 'check' : 'info')}<div><b>${esc(title)}</b><span>${esc(text)}</span></div></li>`;
    const ERRW = { not_granted: 'permission was not given', rate_limited: 'too many requests — wait a moment', session_expired: 'Claude sign-in expired', upstream_error: 'connection problem', sampling_disabled: 'Claude is not available for this account', refused: 'Claude declined the last question', invalid_request: 'the request was rejected' };
    const ai = !c.ready ? [false, 'Connecting…'] : aiOn() ? [true, 'Connected to Claude' + (c.tools ? ' · can check data and open pages' : '') + (c.lastError ? ` · last try failed: ${ERRW[c.lastError] || c.lastError}` : '')]
      : c.aiBlocked ? [false, 'Not connected — ' + (ERRW[c.lastError] || 'permission was not given') + '. Basic English answers only.'] : [false, 'Not available in this view — Basic English answers only.'];
    const voice = c.tts ? [true, `Claude voice · ${(VOICES.find((x) => x[0] === ui().auraVoice) || VOICES[3])[1]}`] : c.browserTts ? [true, 'This device’s voice (Claude voice isn’t offered here)'] : [false, 'No voice on this device or browser — text only'];
    return `<div class="sh-head">${I('info', 'sh-ic')}<div><h2 id="md-t">What’s working</h2><span class="hint">Aura checks this each time you open it.</span></div></div>
      <ul class="diag">${row(ai[0], 'Conversation (AI)', ai[1])}${row(voice[0], 'Talking back', voice[1] + (voice[0] ? (ui().auraSpeak ? ' · on' : ' · off — tap “Read replies aloud”') : ''))}
      ${voice[0] ? `<li class="test-li"><button class="btn sm" data-action="voice-test">${I('speaker')}Test voice</button><span class="hint">You should hear Aura say hello.</span></li>` : ''}
      ${row(!!c.dict, 'Microphone', c.dict ? 'Available — tap the mic and speak' : 'Not available here — type, or use your phone keyboard’s mic')}
      ${row(AI.canSpeak(L.code) || L.code === 'auto', 'Reply language', `${L.name}${voice[0] && !AI.canSpeak(L.code) && L.code !== 'auto' ? ' — no voice for this language here, text only' : ''}`)}</ul>
      <h3>Problem report</h3><p class="hint">Copy this (or take a screenshot of it) and paste it into your Claude chat.</p>
      <pre class="report" id="au-report">${esc(report())}</pre>
      <div class="row-btns" style="margin:8px 0 0"><button class="btn sm" data-action="aura-copyreport">${I('check')}Copy report</button></div>
      <h3>Talking to Aura on ${esc(AI.PLATFORM.name)}</h3><ul class="tips">${platformTips()}</ul>
      <h3>If Aura isn’t answering or speaking</h3><ul class="tips">
        <li>The first time you ask, Claude shows a permission prompt — choose <b>Allow</b>. If you chose No, re-enable it in the artifact’s Permissions menu.</li>
        <li>Turn on <b>Read replies aloud</b> below the message box, or tap <b>Listen</b> under any reply.</li>
        <li>Check your device volume — and that the page isn’t muted.</li></ul>`;
  }

  function report() {
    const c = AI.cap, u = ui(), P = AI.PLATFORM;
    let voices = 0; try { voices = window.speechSynthesis ? window.speechSynthesis.getVoices().length : 0; } catch (e) { /* none */ }
    const last = u.auraMsgs.filter((m) => m.role === 'assistant').slice(-3).map((m) => `${m.status}${m.mode ? '/' + m.mode : ''}${m.err ? ' (' + m.err + ')' : ''}`).join(', ') || 'none';
    return [
      `ORION report · ${new Date().toISOString()}`,
      `Device: ${P.name} · ${navigator.userAgent}`,
      `Inside Claude viewer: ${window.claude && typeof window.claude.use === 'function' ? 'yes' : 'no'} · framed: ${window.top !== window.self ? 'yes' : 'no'}`,
      `AI (sample): ${c.sample ? 'yes' : 'no'} · blocked: ${c.aiBlocked ? 'yes' : 'no'} · tools: ${c.tools ? 'yes' : 'no'} · last error: ${c.lastError || 'none'}`,
      `Claude voice (tts): ${c.tts ? 'yes' : 'no'} · langs: ${Array.isArray(c.ttsLangs) ? c.ttsLangs.join(' ') : 'n/a'}`,
      `Claude mic (dictation): ${c.dict ? 'yes' : 'no'} · last mic error: ${c.lastDictError || 'none'}`,
      `Device voice: ${c.browserTts ? 'yes' : 'no'} · voices installed: ${voices} · unlocked: ${c.speechUnlocked ? 'yes' : 'no'} · Malayalam voice: ${AI.browserVoiceFor('ml') ? 'yes' : 'no'}`,
      `Last speech error: ${c.lastSpeechError || 'none'}`,
      `Settings: lang ${u.auraLang} · speak ${u.auraSpeak ? 'on' : 'off'} · voice ${u.auraVoice} · style ${u.auraTier}`,
      `Last replies: ${last}`,
      `Screen: ${window.innerWidth}x${window.innerHeight} · route ${A().route}`,
    ].join('\n');
  }
  function platformTips() {
    const P = AI.PLATFORM, c = AI.cap;
    if (P.ios) return `<li>Tap <b>Voice</b> (the wave button), then the <b>mic on your keyboard</b> and speak — Aura sends when you pause. If there’s no mic key, turn on Settings › General › Keyboard › <b>Enable Dictation</b>.</li>
      <li>Aura answers with your iPhone’s voice. For more voices or other languages: Settings › Accessibility › Spoken Content › <b>Voices</b>.</li>
      <li>Make sure the ring/silent switch isn’t on silent, and the volume is up.</li>
      <li>Claude’s own voice and mic aren’t available on iPhone or iPad yet (Apple’s browser engine is used everywhere on iOS).</li>`;
    if (P.android) return `<li>Tap <b>Voice</b> (the wave button), then the <b>mic on your keyboard</b> (Gboard) and speak — Aura sends when you pause. Gboard can listen in മലയാളം, हिन्दी, தமிழ் and more: add the language in Gboard settings.</li>
      <li>${c.browserTts || c.tts ? 'Aura answers with ' + (c.tts ? 'Claude’s voice.' : 'your phone’s voice. For Malayalam or other voices, install them in your phone’s Text-to-speech settings (Google speech services).') : 'This app view can’t play voices. Open <b>claude.ai in Chrome</b> instead of the Claude app, then open ORION from your chat — Chrome gives Aura a voice, and usually Claude’s own mic too.'}</li>
      <li>For the full hands-free experience (Claude’s mic and voice), use <b>Chrome</b> on Android rather than the Claude app.</li>`;
    return `<li>Use <b>Chrome</b> or the <b>Claude desktop app</b> for Claude’s mic and voice — tap the mic or the wave button.</li><li>In Safari or Firefox you can still type, and Aura answers with your computer’s voice.</li>`;
  }

  /* ---------- mounting ---------- */
  function mount(root, inPanel) {
    root.innerHTML = `<div class="aura${inPanel ? ' in-panel' : ''}" id="au-wrap">
      <header class="au-head" id="au-head"></header>
      <div class="au-log" id="au-log" aria-live="polite"></div>
      <div id="au-foot"></div>
      <form class="au-form" id="au-form" autocomplete="off">
        <button type="button" class="round mic" id="au-mic" data-action="aura-mic" aria-label="Speak to Aura" aria-pressed="false" hidden>${I('mic')}</button>
        <label class="sr" for="au-in">Message Aura</label><input id="au-in" dir="auto" placeholder="Ask Aura anything…" maxlength="500">
        <button type="button" class="round voice-btn" id="au-voice" data-action="voice-open" aria-label="Voice mode" title="Voice mode — talk with Aura" hidden>${I('wave')}</button>
        <button type="submit" class="round send" aria-label="Send">${I('send')}</button>
      </form>
      <div class="au-under"><button type="button" class="mini" id="au-speak" data-action="aura-speak" aria-pressed="false" hidden></button>
        <span class="hint">Aura asks before any action. Emergency: 112.</span></div>
    </div>`;
    renderChrome(); renderLog();
    root.querySelector('#au-form').addEventListener('submit', (e) => { e.preventDefault(); send(el('au-in').value, false); });
    AI.ready.then(() => { wireDict(); wireTts(); renderChrome(); });
  }

  const view = { title: 'Aura', mount(root) { mount(root, false); }, update() {} };

  ORION.auraActions = {
    'aura-ask': (t) => send(t.dataset.q, false),
    'aura-mic': () => micClick(),
    'aura-stop': () => { if (ctl) ctl.abort(); },
    'aura-say': (t) => say(+t.dataset.i),
    'aura-copy': (t) => { const m = ui().auraMsgs[+t.dataset.i]; try { navigator.clipboard.writeText(AI.plainForSpeech(m.text)).then(() => A().toast('Copied.'), () => A().toast('Copy isn’t allowed here.')); } catch (e) { A().toast('Copy isn’t allowed here.'); } },
    'aura-retry': (t) => { const i = +t.dataset.i, m = ui().auraMsgs[i]; if (!m || ctl) return; m.status = 'thinking'; m.text = ''; m.steps = []; m.err = null; renderMsg(i); run(m, i, true); },
    'aura-speak': () => { const u = ui(); u.auraSpeak = !u.auraSpeak; u.auraSpeakSet = true; if (!u.auraSpeak && AI.cap.tts) AI.cap.tts.stop().catch(() => {}); U.store.set('orion.aura.speak', u.auraSpeak); renderChrome(); },
    'aura-clear': () => { if (ctl) ctl.abort(); ui().auraMsgs = []; renderLog(); },
    'aura-lang': () => A().sheet('lang', langSheet),
    'aura-status': () => A().sheet('status', statusSheet, true),
    'voice-open': () => { const was = V.open; voiceOpen(); if (!was && AI.cap.ready) orbTap(); },
    'voice-close': () => voiceClose(),
    'voice-orb': () => orbTap(),
    'voice-test': () => previewVoice(),
    'aura-handsfree': (t) => { ui().auraHandsFree = t.dataset.v === 'true'; U.store.set('orion.aura.handsfree', ui().auraHandsFree); A().sheet('lang', langSheet); },
    'voice-type': () => { V.typing = !V.typing; vRender(); const i = el('vo-in'); if (i && V.typing) i.focus(); },
    'aura-copyreport': () => { const t = report(); try { navigator.clipboard.writeText(t).then(() => A().toast('Report copied — paste it into your Claude chat.'), () => A().toast('Copy isn’t allowed here — take a screenshot of the report instead.')); } catch (e) { A().toast('Copy isn’t allowed here — take a screenshot of the report instead.'); } },
    'aura-voice': (t) => { previewVoice(t.dataset.v); A().sheet('lang', langSheet); },
    'aura-rate': (t) => { ui().auraRate = +t.dataset.v; U.store.set('orion.aura.rate', ui().auraRate); if (AI.cap.tts && AI.cap.tts.setRate) AI.cap.tts.setRate(ui().auraRate).catch(() => {}); A().sheet('lang', langSheet); },
    'aura-setlang': (t) => { ui().auraLang = t.dataset.l; U.store.set('orion.aura.lang', t.dataset.l); A().sheet('lang', langSheet); renderChrome(); },
    'aura-tier': (t) => { ui().auraTier = t.dataset.v; U.store.set('orion.aura.tier', t.dataset.v); A().sheet('lang', langSheet); },
  };
  document.addEventListener('keydown', (e) => {
    if (!V.open || e.repeat || (e.key !== ' ' && e.key !== 'Enter')) return;
    if (e.target && e.target.closest && e.target.closest('input,textarea,select,button,a')) return;
    e.preventDefault(); orbTap();
  });
  ORION.auraView = view;
  ORION.auraVoice = { isOpen: () => V.open, close: voiceClose };
  ORION.auraPanel = { mount: (root) => mount(root, true), focus: () => { const i = el('au-in'); if (i) i.focus(); }, rerender: () => { renderChrome(); renderLog(); } };
  AI.onChange(() => { renderChrome(); if (AI.cap.ready) { wireDict(); wireTts(); } });
})();
