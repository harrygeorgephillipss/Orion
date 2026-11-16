/* ORION app shell: routing, header + tabs, sheets/dialogs, demo controls, global actions. */
'use strict';
(function () {
  const U = ORION.util, F = ORION.fmt, esc = U.esc, C = ORION.ui, I = C.icon;
  const NAV = [['home', 'Home', 'home'], ['history', 'History', 'chart'], ['alerts', 'Alerts', 'alert'], ['devices', 'Devices', 'sliders'], ['aura', 'Aura', 'aura'], ['config', 'Settings', 'gear']];

  /* Saved settings are merged onto the current defaults, so new fields appear and old ones survive upgrades.
     Values are re-validated; anything invalid falls back to its default instead of discarding everything. */
  function loadConfig() {
    const d = ORION.defaultConfig();
    const s = U.store.get('orion.config.v1', null);
    if (!s || typeof s !== 'object') return d;
    const num = (v, lo, hi, def) => (typeof v === 'number' && isFinite(v) && v >= lo && v <= hi ? v : def);
    const out = Object.assign(d, {
      home: Object.assign(d.home, s.home && typeof s.home.name === 'string' ? { name: s.home.name.slice(0, 60) } : {}),
      timezone: typeof s.timezone === 'string' ? s.timezone : d.timezone,
      tempUnit: s.tempUnit === 'F' ? 'F' : 'C',
      freshness: { sensor_s: num(s.freshness && s.freshness.sensor_s, 5, 600, d.freshness.sensor_s), heartbeat_s: num(s.freshness && s.freshness.heartbeat_s, 5, 600, d.freshness.heartbeat_s) },
      thresholds: Object.assign(d.thresholds, s.thresholds || {}),
      rooms: Object.assign(d.rooms, s.rooms || {}),
      configVersion: s.configVersion || d.configVersion,
    });
    out.version = d.version;
    return out;
  }

  const app = (ORION.app = {
    config: loadConfig(), mode: 'demo', source: null, snap: null, ev: null, lastOkAt: null, route: 'home', view: null, _sheet: null,
    ui: {
      tick: 0, histRange: '6h', histSeries: null, incFilter: 'active', openAlerts: new Set(), speakingIdx: null,
      auraMsgs: [], auraVoice: U.store.get('orion.aura.voice', 'rounded'), auraHandsFree: U.store.get('orion.aura.handsfree', false) === true, auraRate: U.store.get('orion.aura.rate', 1), auraLang: U.store.get('orion.aura.lang', 'auto'), auraTier: U.store.get('orion.aura.tier', 'quick'), auraSpeak: U.store.get('orion.aura.speak', true) !== false,
    },
    user: { name: 'Simulation user', role: 'owner' },
    toast(msg, kind) {
      const box = document.getElementById('toasts');
      const t = document.createElement('div'); t.className = 'toast ' + (kind || ''); t.textContent = msg; box.appendChild(t);
      setTimeout(() => t.classList.add('out'), 4200); setTimeout(() => t.remove(), 4700);
    },
  });
  if (U.store.get('orion.aura.speak', null) !== null) app.ui.auraSpeakSet = true;

  app.setSource = function (mode) {
    if (this.source) this.source.stop();
    this.mode = mode;
    U.store.set('orion.mode', mode);
    this.source = mode === 'demo' ? (this._demo || (this._demo = new ORION.sources.DemoSource())) : new ORION.sources.LiveSource();
    this.user = mode === 'demo' ? { name: 'Simulation user', role: 'owner' } : { name: 'Not signed in', role: 'viewer' };
    this.source.listeners = [];
    this.source.start(() => this.onData());
    if (mode === 'live') this.onData();
    renderChrome();
  };
  /* Who may send device commands: anyone in simulation; member or higher on a live server. */
  app.canCommand = function () { return this.mode === 'demo' || ['owner', 'admin', 'member'].includes(this.user.role); };
  app.isAdmin = function () { return this.mode === 'live' && ['owner', 'admin'].includes(this.user.role); };

  app.onData = function () {
    this.ui.tick++;
    try {
      this.snap = this.source.snapshot();
      this.ev = ORION.state.evaluate(this.snap, this.config, Date.now());
    } catch (e) {
      // Never show stale-but-plausible values after an internal error: degrade to an explicit error state.
      console.error(e);
      this.snap = { status: 'error', error: { code: 'client', message: 'ORION could not process the latest data (' + (e && e.message) + ')' }, at: Date.now() };
      this.ev = ORION.state.evaluate(this.snap, this.config, Date.now());
    }
    if (this.snap.status === 'ok') this.lastOkAt = this.snap.at;
    renderHeader();
    if (this.view && this.view.update) { try { this.view.update(document.getElementById('view')); } catch (e) { console.error(e); } }
    if (this._sheet && this._sheet.live) { const b = document.querySelector('#modal .md-b'); if (b) { const h = this._sheet.render(); if (b._h !== h) { b.innerHTML = h; b._h = h; } } }
  };

  app.go = function (r) { if (location.hash.replace('#', '') === r) this.mountView(); else location.hash = r; };
  app.confirmCommand = function (key) {
    const c = CMDS[key]; if (!c) return;
    const sim = app.mode === 'demo';
    const body = `<p>${c.body}</p>${sim ? '<p class="hint"><b>Simulation:</b> no real device receives this command.</p>' : ''}`;
    confirmBox({ title: c.title, body, confirm: 'Send', onConfirm() {
      // A command is only reported as sent once the data source accepted it; its real outcome is shown step by step.
      Promise.resolve().then(() => app.source.command({ actuator: c.actuator, action: c.action, actor: app.user.name })).then((r) => {
        if (r && r.ok) app.toast(sim ? 'Simulated command queued. Follow its steps under “Recent commands”.' : 'Command queued. Follow its steps under “Recent commands”.');
        else app.toast('Command not sent: ' + ((r && r.error) || 'no response from the data source'), 'bad');
        app.onData();
      }, (e) => { app.toast('Command not sent: ' + ((e && e.message) || 'error'), 'bad'); app.onData(); });
    } });
  };

  /* Aura side panel — available on every page */
  function panelOpen() { return !document.getElementById('auraPanel').hidden; }
  function openPanel() {
    if (window.innerWidth <= 760 || app.route === 'aura') { if (app.route !== 'aura') location.hash = 'aura'; else ORION.auraPanel.focus(); return; }
    const p = document.getElementById('auraPanel');
    if (!panelOpen()) { ORION.auraPanel.mount(p.querySelector('.ap-body')); p.hidden = false; document.body.classList.add('aura-open'); }
    setTimeout(() => ORION.auraPanel.focus(), 30);
  }
  function closePanel() { const p = document.getElementById('auraPanel'); if (!panelOpen()) return; p.hidden = true; p.querySelector('.ap-body').innerHTML = ''; document.body.classList.remove('aura-open'); }
  app.openPanel = openPanel; app.closePanel = closePanel;

  app.mountView = function () {
    const el = document.getElementById('view');
    ORION.charts.reset();
    this.view = ORION.views[this.route];
    el.innerHTML = '';
    el.className = 'page-' + this.route;
    try {
      this.view.mount(el);
      this.view.update(el, true);
    } catch (e) {
      console.error(e);
      el.innerHTML = C.statePanel('error', 'This page failed to load', 'An internal error stopped this page from rendering. Other pages still work. Details: ' + (e && e.message));
      this.view = { title: this.view.title, update() {} };
    }
    document.title = `${this.view.title} · ORION`;
    document.querySelectorAll('[data-r]').forEach((a) => { const on = a.dataset.r === this.route; a.classList.toggle('on', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  };

  function route() {
    const h = (location.hash || '').replace('#', '');
    app.route = ORION.views[h] && h !== '_' ? h : 'home';
    closeModal(true);
    if (app.route === 'aura') closePanel();
    document.getElementById('auraFab').hidden = app.route === 'aura';
    app.mountView();
    document.getElementById('view').focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }

  /* ---------- chrome ---------- */
  function renderChrome() {
    const links = NAV.map(([r, label, ic]) => `<a href="#${r}" data-r="${r}" class="${r === 'aura' ? 'is-aura' : ''}${r === app.route ? ' on' : ''}">${I(ic)}<span>${esc(label)}</span></a>`).join('');
    document.getElementById('tabs').innerHTML = links;
    document.getElementById('btabs').innerHTML = links;
    document.getElementById('demoBar').hidden = app.mode !== 'demo';
    document.body.classList.toggle('is-sim', app.mode === 'demo');
  }
  function renderHeader() {
    const ev = app.ev; if (!ev) return;
    const p = C.PLAIN[ev.system] || C.PLAIN.OFFLINE;
    const pill = document.getElementById('hdState');
    const html = `<span class="hpill s-${p.cls}">${I(p.icon)}<span>${esc(p.title)}</span></span>`;
    if (pill._h !== html) { pill.innerHTML = html; pill._h = html; }
    const n = app.snap.incidents ? app.snap.incidents.filter((i) => i.state !== 'cleared' && (i.severity === 'critical' || i.severity === 'warning')).length : 0;
    document.querySelectorAll('[data-r="alerts"]').forEach((a) => { let b = a.querySelector('.cnt'); if (n) { if (!b) { b = document.createElement('b'); b.className = 'cnt'; a.appendChild(b); } b.textContent = n; } else if (b) b.remove(); });
    document.body.dataset.sys = ev.system;
    // Live server with simulated devices registered: say so on every page.
    const simDevices = app.mode === 'live' && app.snap && app.snap.contains_simulated;
    const bar = document.getElementById('demoBar');
    if (bar) {
      const want = app.mode === 'demo' || !!simDevices;
      if (bar.hidden === want) bar.hidden = !want;
      const txt = app.mode === 'demo' ? '<b>SIMULATION</b> · every value is invented test data — no hardware is connected'
        : app.snap.simulated ? '<b>SIMULATED DEVICES</b> · this server is receiving data from a device simulator, not hardware'
          : '<b>INCLUDES SIMULATED DEVICES</b> · values tagged “simulated” are not hardware readings';
      const tEl = document.getElementById('demoTxt'); if (tEl && tEl._h !== txt) { tEl.innerHTML = txt; tEl._h = txt; }
      const b = document.getElementById('demoBtn'); if (b) b.hidden = app.mode !== 'demo';
    }
    const sc = document.getElementById('scName');
    if (sc && app.mode === 'demo') { const s = ORION.sources.SCENARIOS.find((x) => x.id === app.source.scenario); sc.textContent = s ? s.label : ''; }
  }

  function scenarioDrawer(open) {
    const d = document.getElementById('drawer');
    if (!open) { d.hidden = true; return; }
    const groups = {};
    for (const s of ORION.sources.SCENARIOS) (groups[s.group] = groups[s.group] || []).push(s);
    if (app.mode !== 'demo') { d.hidden = true; return; }
    d.innerHTML = `<div class="dr-in" role="dialog" aria-label="Simulation scenarios"><div class="sec-h"><h2>Simulation scenarios</h2><button class="round sm" data-action="drawer-close" aria-label="Close">${I('x')}</button></div>
      <p class="hint">Make the simulated house do something and watch ORION respond. Nothing here touches real hardware.</p>
      ${Object.entries(groups).map(([g, list]) => `<div class="dr-g"><div class="dr-gt">${esc(g)}</div>${list.map((s) => `<button class="dr-s${app.source.scenario === s.id ? ' on' : ''}" data-action="scenario" data-s="${s.id}"><b>${esc(s.label)}</b><span>${esc(s.hint)}</span></button>`).join('')}</div>`).join('')}</div>`;
    d.hidden = false;
  }

  /* ---------- sheets & dialogs ---------- */
  let lastFocus = null;
  function openModal(inner, opts) {
    const m = document.getElementById('modal');
    if (m.hidden) lastFocus = document.activeElement;
    m.innerHTML = `<div class="md-bg" data-action="md-cancel"></div><div class="md ${opts && opts.wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="md-t"><button class="round sm md-x" data-action="md-cancel" aria-label="Close">${I('x')}</button><div class="md-b">${inner}</div>${opts && opts.actions ? `<div class="md-a">${opts.actions}</div>` : ''}</div>`;
    m.hidden = false;
    const f = m.querySelector(opts && opts.focus ? opts.focus : '.md-x'); if (f) f.focus();
  }
  function closeModal(silent) { const m = document.getElementById('modal'); if (m.hidden) return; m.hidden = true; m.innerHTML = ''; app._sheet = null; if (!silent && lastFocus) lastFocus.focus(); }
  function confirmBox({ title, body, confirm, danger, onConfirm }) {
    app._sheet = null;
    openModal(`<h2 id="md-t">${esc(title)}</h2>${body}`, { actions: `<button class="btn ghost" data-action="md-cancel">Cancel</button><button class="btn ${danger ? 'danger' : ''}" id="md-ok">${esc(confirm)}</button>`, focus: '#md-ok' });
    document.getElementById('md-ok').onclick = () => { closeModal(); onConfirm(); };
  }
  /* Sign-in dialog (live mode). The password is sent only to the ORION server, over HTTPS in production. */
  function loginBox() {
    if (app.mode !== 'live' || !app.source.login) return;
    app._sheet = null;
    openModal(`<h2 id="md-t">Sign in to ORION</h2><p class="hint">Server: ${esc(app.source.base || '—')}</p>
      <form id="login-f" class="stack" autocomplete="on"><label class="fld"><span>Email</span><input id="lg-e" type="email" autocomplete="username" required maxlength="254"></label>
      <label class="fld"><span>Password</span><input id="lg-p" type="password" autocomplete="current-password" required maxlength="200"></label>
      <div id="lg-err" class="note crit" hidden></div><div class="row-btns"><button class="btn" type="submit" id="lg-go">Sign in</button></div></form>`, { focus: '#lg-e' });
    document.getElementById('login-f').addEventListener('submit', (e) => {
      e.preventDefault();
      const btn = document.getElementById('lg-go'), err = document.getElementById('lg-err');
      btn.disabled = true; err.hidden = true;
      app.source.login(document.getElementById('lg-e').value.trim(), document.getElementById('lg-p').value).then((r) => {
        btn.disabled = false;
        if (r.ok) { closeModal(); app.toast('Signed in as ' + r.user.name + ' (' + r.user.role + ').'); app.mountView(); }
        else { err.hidden = false; err.textContent = r.error; }
      });
    });
  }

  app.sheet = function (key, render, live) {
    this._sheet = { key, render, live: !!live };
    const inner = render();
    const b = document.querySelector('#modal .md-b');
    if (b && !document.getElementById('modal').hidden) { b.innerHTML = inner; b._h = inner; } else openModal(inner, { wide: true });
  };

  const CMDS = {
    'fan:on': { actuator: 'fan', action: 'on', title: 'Turn the fan on?', body: 'You’ll see each step: requested → queued → sent → accepted. The fan has no feedback sensor, so it ends as “Done · unconfirmed” — ORION never claims it physically turned on.' },
    'fan:off': { actuator: 'fan', action: 'off', title: 'Turn the fan off?', body: 'The safety controller refuses to switch the fan off during smoke and for 60 s afterwards.' },
    'buzzer:test': { actuator: 'buzzer', action: 'test', title: 'Test the buzzer for 2 seconds?', body: 'The buzzer has no feedback sensor — listen for it to confirm it works.' },
  };

  /* ---------- global click handling ---------- */
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    const a = t.dataset.action;
    if (ORION.auraActions[a]) return ORION.auraActions[a](t);
    if (a === 'mode') { app.setSource(t.dataset.mode); app.mountView(); app.toast(t.dataset.mode === 'demo' ? 'Simulation mode — every value is invented test data.' : 'Live mode — ORION shows only real data, never invented values.'); }
    else if (a === 'scenario') { app.source.setScenario(t.dataset.s); scenarioDrawer(true); }
    else if (a === 'drawer-open') scenarioDrawer(document.getElementById('drawer').hidden);
    else if (a === 'drawer-close') scenarioDrawer(false);
    else if (a === 'sensor') app.sheet('sensor', () => ORION.views._.sensorSheet(t.dataset.k), true);
    else if (a === 'open-incident') { app.ui.openAlerts.add(t.dataset.id); app.ui.incFilter = 'all'; if (app.route !== 'alerts') location.hash = 'alerts'; else app.mountView(); setTimeout(() => { const d = document.querySelector(`details.al[data-id="${CSS.escape(t.dataset.id)}"]`); if (d) d.scrollIntoView({ block: 'center' }); }, 60); }
    else if (a === 'ack') {
      const inc = app.snap.incidents && app.snap.incidents.find((i) => i.id === t.dataset.id); if (!inc) return;
      confirmBox({
        title: 'Mark this alert as seen?', confirm: 'Mark as seen',
        body: `<p><b>${esc(C.incidentSentence(inc))}</b><br><span class="hint">Started ${esc(F.dt(inc.opened_at))}</span></p><p>This only records that you know about it. It <b>won’t</b> stop the buzzer or end the alert — that happens by itself when the sensor reads normal again.</p>`,
        onConfirm() {
          Promise.resolve().then(() => app.source.acknowledge(inc.id, app.user.name)).then((r) => {
            app.toast(r && r.ok ? 'Marked as seen. The alert stays until the sensor reads normal.' : 'Couldn’t save: ' + ((r && r.error) || 'no response'), r && r.ok ? '' : 'bad'); app.onData();
          });
        },
      });
    } else if (a === 'login-open') loginBox();
    else if (a === 'logout') { if (app.source.logout) app.source.logout().then(() => { app.toast('Signed out.'); app.mountView(); }); }
    else if (a === 'server-save') {
      const i = document.getElementById('c-server'); const v = i ? i.value.trim() : '';
      if (v && !/^https?:\/\/[^\s]+$/i.test(v)) { app.toast('Server address must start with http:// or https://', 'bad'); return; }
      U.store.set(ORION.sources.LiveSource.SERVER_KEY, v.replace(/\/+$/, ''));
      app.setSource('live'); app.mountView(); app.toast(v ? 'Server address saved.' : 'Using this page’s own server.');
    } else if (a === 'cmd') app.confirmCommand(t.dataset.act);
    else if (a === 'aura-open') { if (panelOpen()) closePanel(); else openPanel(); }
    else if (a === 'aura-close') closePanel();
    else if (a === 'theme') { document.body.dataset.theme = t.dataset.t; U.store.set('orion.theme', t.dataset.t); app.mountView(); }
    else if (a === 'md-cancel') closeModal();
    else if (a === 'range') { app.ui.histRange = t.dataset.r; app.mountView(); }
    else if (a === 'hseries') { app.ui.histSeries = t.dataset.s; app.mountView(); }
    else if (a === 'inc-filter') { app.ui.incFilter = t.dataset.f; app.mountView(); }
    else if (a === 'csv-dl') {
      const to = Date.now(), from = to - ORION.views._.RANGES[app.ui.histRange], ser = ORION.views._.curSeries(app.snap);
      if (!ser) { app.toast('No sensor history to export.', 'bad'); return; }
      const csv = ORION.views._.buildCSV(ser, from, to), rows = csv.split('\n').length - 1;
      const name = `orion-${app.mode === 'demo' ? 'SIMULATION' : 'live'}-${ser.replace(/[^a-z0-9-]+/gi, '_')}-${app.ui.histRange}.csv`;
      (async () => {
        let saved = false;
        try { const dl = window.claude && window.claude.use ? await window.claude.use('downloads') : null; if (dl) { await dl.save({ filename: name, data: csv }); saved = true; } } catch (err) { /* declined */ }
        if (!saved) { try { const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); const l = document.createElement('a'); l.href = url; l.download = name; document.body.appendChild(l); l.click(); l.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000); } catch (err) { /* ignored */ } }
        const box = document.getElementById('hi-csv');
        if (box) box.innerHTML = `<section class="card"><div class="sec-h"><h2>${rows} readings exported</h2><span class="hint mono">${esc(name)}</span></div><p class="hint">${saved ? 'Saved.' : 'If no download started, copy the text below.'}</p><textarea class="csv" readonly rows="6">${esc(csv.slice(0, 300000))}</textarea></section>`;
      })();
    } else if (a === 'cfg-reset') {
      confirmBox({ title: 'Reset all settings?', body: '<p>Room names, alert levels and other settings go back to their defaults.</p>', confirm: 'Reset', danger: true, onConfirm() { app.config = ORION.defaultConfig(); U.store.set('orion.config.v1', app.config); app.toast('Settings reset.'); app.mountView(); } });
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!document.getElementById('modal').hidden) { e.preventDefault(); closeModal(); }
      else if (ORION.auraVoice && ORION.auraVoice.isOpen()) { e.preventDefault(); ORION.auraVoice.close(); }
      else if (!document.getElementById('drawer').hidden) { e.preventDefault(); scenarioDrawer(false); }
      else if (panelOpen() && !e.target.matches('input')) { e.preventDefault(); closePanel(); }
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); if (panelOpen()) closePanel(); else openPanel(); }
  });

  /* ---------- boot ---------- */
  function boot() {
    ORION.auraAI.ready = ORION.auraAI.init();
    document.body.dataset.theme = U.store.get('orion.theme', 'dark');
    const P = ORION.auraAI.PLATFORM; document.body.classList.toggle('is-ios', P.ios); document.body.classList.toggle('is-android', P.android); document.body.classList.toggle('is-touch', P.mobile);
    renderChrome();
    window.addEventListener('hashchange', route);
    let rz, lastW = window.innerWidth;
    window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (Math.abs(window.innerWidth - lastW) > 40 && ['home', 'history'].includes(app.route)) { lastW = window.innerWidth; app.mountView(); } }, 250); });
    // Served by an ORION server → live data by default; opened as a local file → simulation. The choice is remembered.
    const saved = U.store.get('orion.mode', null);
    app.setSource(saved === 'demo' || saved === 'live' ? saved : (/^https?:$/.test(location.protocol) ? 'live' : 'demo'));
    route();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
