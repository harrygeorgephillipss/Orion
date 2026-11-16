/* ORION app shell: routing, header + tabs, sheets/dialogs, demo controls, global actions. */
'use strict';
(function () {
  const U = ORION.util, F = ORION.fmt, esc = U.esc, C = ORION.ui, I = C.icon;
  const NAV = [['home', 'Home', 'home'], ['history', 'History', 'chart'], ['alerts', 'Alerts', 'alert'], ['devices', 'Devices', 'sliders'], ['aura', 'Aura', 'aura'], ['config', 'Settings', 'gear']];

  function loadConfig() {
    const d = ORION.defaultConfig();
    const s = U.store.get('orion.config.v1', null);
    if (!s || s.version !== d.version) return d;
    return Object.assign(d, s, { freshness: Object.assign(d.freshness, s.freshness), thresholds: Object.assign(d.thresholds, s.thresholds), rooms: Object.assign(d.rooms, s.rooms) });
  }

  const app = (ORION.app = {
    config: loadConfig(), mode: 'demo', source: null, snap: null, ev: null, lastOkAt: null, route: 'home', view: null, _sheet: null,
    ui: {
      tick: 0, histRange: '6h', histSeries: 'mq2', incFilter: 'active', openAlerts: new Set(), speakingIdx: null,
      auraMsgs: [], auraVoice: U.store.get('orion.aura.voice', 'rounded'), auraHandsFree: U.store.get('orion.aura.handsfree', false) === true, auraRate: U.store.get('orion.aura.rate', 1), auraLang: U.store.get('orion.aura.lang', 'auto'), auraTier: U.store.get('orion.aura.tier', 'quick'), auraSpeak: U.store.get('orion.aura.speak', true) !== false,
    },
    user: { name: 'Demo Owner', role: 'owner' },
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
    this.source = mode === 'demo' ? (this._demo || (this._demo = new ORION.sources.DemoSource())) : new ORION.sources.LiveSource();
    this.source.listeners = [];
    this.source.start(() => this.onData());
    if (mode === 'live') this.onData();
    renderChrome();
  };

  app.onData = function () {
    this.ui.tick++;
    this.snap = this.source.snapshot();
    this.ev = ORION.state.evaluate(this.snap, this.config, Date.now());
    if (this.snap.status === 'ok') this.lastOkAt = this.snap.at;
    renderHeader();
    if (this.view && this.view.update) { try { this.view.update(document.getElementById('view')); } catch (e) { console.error(e); } }
    if (this._sheet && this._sheet.live) { const b = document.querySelector('#modal .md-b'); if (b) { const h = this._sheet.render(); if (b._h !== h) { b.innerHTML = h; b._h = h; } } }
  };

  app.go = function (r) { if (location.hash.replace('#', '') === r) this.mountView(); else location.hash = r; };
  app.confirmCommand = function (key) {
    const c = CMDS[key]; if (!c) return;
    confirmBox({ title: c.title, body: `<p>${c.body}</p>`, confirm: 'Send', onConfirm() { app.source.command({ actuator: c.actuator, action: c.action, actor: app.user.name }); app.toast('Command sent (simulated). See “Recent commands” on Devices.'); app.onData(); } });
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
    this.view.mount(el);
    this.view.update(el, true);
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
    const sc = document.getElementById('scName');
    if (sc && app.mode === 'demo') { const s = ORION.sources.SCENARIOS.find((x) => x.id === app.source.scenario); sc.textContent = s ? s.label : ''; }
  }

  function scenarioDrawer(open) {
    const d = document.getElementById('drawer');
    if (!open) { d.hidden = true; return; }
    const groups = {};
    for (const s of ORION.sources.SCENARIOS) (groups[s.group] = groups[s.group] || []).push(s);
    d.innerHTML = `<div class="dr-in" role="dialog" aria-label="Demo scenarios"><div class="sec-h"><h2>Try a scenario</h2><button class="round sm" data-action="drawer-close" aria-label="Close">${I('x')}</button></div>
      <p class="hint">Make the simulated house do something and watch ORION respond.</p>
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
  app.sheet = function (key, render, live) {
    this._sheet = { key, render, live: !!live };
    const inner = render();
    const b = document.querySelector('#modal .md-b');
    if (b && !document.getElementById('modal').hidden) { b.innerHTML = inner; b._h = inner; } else openModal(inner, { wide: true });
  };

  const CMDS = {
    'fan:on': { actuator: 'fan', action: 'on', title: 'Turn the fan on?', body: 'This is a <b>simulated</b> command — no real fan receives it. You’ll see each step: requested → queued → sent → accepted. The fan can’t report back, so it ends as “Done · unconfirmed”.' },
    'fan:off': { actuator: 'fan', action: 'off', title: 'Turn the fan off?', body: 'This is a <b>simulated</b> command. The device refuses to switch the fan off during smoke and for 60 s afterwards.' },
    'buzzer:test': { actuator: 'buzzer', action: 'test', title: 'Test the buzzer for 2 seconds?', body: 'This is a <b>simulated</b> command — no real buzzer receives it.' },
  };

  /* ---------- global click handling ---------- */
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    const a = t.dataset.action;
    if (ORION.auraActions[a]) return ORION.auraActions[a](t);
    if (a === 'mode') { app.setSource(t.dataset.mode); app.mountView(); app.toast(t.dataset.mode === 'demo' ? 'Using demo data.' : 'Live mode — no backend yet, so ORION shows no values rather than inventing them.'); }
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
        onConfirm() { const r = app.source.acknowledge(inc.id, app.user.name); app.toast(r.ok ? 'Marked as seen. The alert stays until the sensor reads normal.' : 'Couldn’t save: ' + r.error, r.ok ? '' : 'bad'); app.onData(); },
      });
    } else if (a === 'cmd') app.confirmCommand(t.dataset.act);
    else if (a === 'aura-open') { if (panelOpen()) closePanel(); else openPanel(); }
    else if (a === 'aura-close') closePanel();
    else if (a === 'theme') { document.body.dataset.theme = t.dataset.t; U.store.set('orion.theme', t.dataset.t); app.mountView(); }
    else if (a === 'md-cancel') closeModal();
    else if (a === 'range') { app.ui.histRange = t.dataset.r; app.mountView(); }
    else if (a === 'hseries') { app.ui.histSeries = t.dataset.s; app.mountView(); }
    else if (a === 'inc-filter') { app.ui.incFilter = t.dataset.f; app.mountView(); }
    else if (a === 'csv-dl') {
      const to = Date.now(), from = to - ORION.views._.RANGES[app.ui.histRange], ser = app.ui.histSeries;
      const csv = ORION.views._.buildCSV(ser, from, to), rows = csv.split('\n').length - 1;
      const name = `orion-${app.mode}-${ser}-${app.ui.histRange}.csv`;
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
    app.setSource('demo');
    route();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
