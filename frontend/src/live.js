/* ORION live data source: the same adapter interface as the simulation (see sources.js), backed by the ORION server.
 *
 *  - REST  /api/v1/...  for the overview snapshot, history, acknowledgements and commands
 *  - WebSocket /api/v1/ws for real-time events (on any event the overview is re-fetched, debounced)
 *  - Access token kept in memory only. Browsers keep the refresh token in an httpOnly cookie set by the server;
 *    the Android app (Phase 5) keeps it in secure storage.
 *  - When the server can't be reached the snapshot becomes an explicit error — values are never invented or kept
 *    looking current. A periodic 2 s tick re-evaluates freshness even when no messages arrive.
 */
'use strict';
(function () {
  const U = ORION.util;
  const SERVER_KEY = 'orion.server';

  /* Base URL of the ORION server: saved setting, else the page's own origin when served over http(s). */
  function serverBase() {
    const saved = U.store.get(SERVER_KEY, '');
    if (saved) return String(saved).replace(/\/+$/, '');
    if (/^https?:$/.test(location.protocol)) return location.origin;
    return '';
  }

  class LiveSource {
    constructor() {
      this.kind = 'live'; this.label = 'Live';
      this.base = serverBase();
      this.token = null; this.user = null;
      this.snap = this.base ? { status: 'loading' } : { status: 'unconfigured', message: 'No ORION server address is set. Add it in Settings → Data, or open ORION from your server.' };
      this.listeners = []; this.hist = new Map(); this.timer = null; this.ws = null; this.wsBackoff = 1000; this.stopped = false;
      this.wsState = 'closed'; this._refetchT = null; this._inflight = null;
    }

    /* ---------- lifecycle ---------- */
    start(cb) {
      if (cb) this.listeners.push(cb);
      this.stopped = false;
      if (!this.timer) this.timer = setInterval(() => this._emit(), 2000); // freshness re-evaluation
      if (this.base) this._boot();
      else this._emit();
    }
    stop() {
      this.stopped = true;
      clearInterval(this.timer); this.timer = null;
      if (this.ws) { try { this.ws.close(); } catch (e) { /* closed */ } this.ws = null; }
    }
    _emit() { for (const l of this.listeners) { try { l(); } catch (e) { console.error(e); } } }

    async _boot() {
      const ok = await this._refresh();
      if (!ok) { if (this.snap.status !== 'error') this.snap = { status: 'auth', message: 'Sign in to see live data.' }; this._emit(); return; }
      await this._afterAuth();
    }
    async _afterAuth() {
      await Promise.all([this._loadConfig(), this.refetch()]);
      this._openWs();
    }

    /* ---------- auth ---------- */
    async _refresh() {
      try {
        const r = await fetch(this.base + '/api/v1/auth/refresh', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        if (!r.ok) return false;
        this._setAuth(await r.json());
        return true;
      } catch (e) {
        this.snap = { status: 'error', error: { code: 'network', message: 'Cannot reach the ORION server at ' + this.base }, at: Date.now() };
        return false;
      }
    }
    _setAuth(j) {
      this.token = j.access_token; this.user = j.user;
      if (ORION.app) ORION.app.user = { name: j.user.name, role: j.user.role, email: j.user.email };
    }
    async login(email, password) {
      let r;
      try {
        r = await fetch(this.base + '/api/v1/auth/login', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, client: 'web' }) });
      } catch (e) { return { ok: false, error: 'Cannot reach the ORION server.' }; }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, error: j.detail || ('Sign-in failed (' + r.status + ')') };
      this._setAuth(j);
      this.snap = { status: 'loading' }; this._emit();
      await this._afterAuth();
      return { ok: true, user: j.user };
    }
    async logout() {
      try { await fetch(this.base + '/api/v1/auth/logout', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch (e) { /* offline */ }
      this.token = null; this.user = null;
      if (this.ws) { try { this.ws.close(); } catch (e) { /* closed */ } this.ws = null; }
      this.hist.clear();
      this.snap = { status: 'auth', message: 'Signed out.' };
      if (ORION.app) ORION.app.user = { name: 'Signed out', role: 'viewer' };
      this._emit();
    }

    /* Authenticated request; on 401 tries one refresh, then reports "sign in". */
    async api(path, opts) {
      if (!this.base) return { ok: false, status: 0, data: {}, error: 'No ORION server is configured.' };
      try { return await this._api(path, opts); } catch (e) {
        return { ok: false, status: 0, data: {}, error: 'Cannot reach the ORION server.' };
      }
    }
    async _api(path, opts) {
      const o = Object.assign({ method: 'GET' }, opts || {});
      const go = () => fetch(this.base + '/api/v1' + path, { method: o.method, credentials: 'include', headers: Object.assign({ 'Content-Type': 'application/json' }, this.token ? { Authorization: 'Bearer ' + this.token } : {}), body: o.body === undefined ? undefined : JSON.stringify(o.body) });
      let r = await go();
      if (r.status === 401 && await this._refresh()) r = await go();
      if (r.status === 401) { this.token = null; this.snap = { status: 'auth', message: 'Your session ended — sign in again.' }; this._emit(); }
      const j = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, data: j, error: r.ok ? null : (typeof j.detail === 'string' ? j.detail : 'Request failed (' + r.status + ')') };
    }

    /* ---------- data ---------- */
    refetch() {
      if (this._inflight) return this._inflight;
      this._inflight = (async () => {
        try {
          const r = await this.api('/overview');
          if (r.ok) this.snap = r.data;
          else if (r.status === 0 && !this.base) this.snap = { status: 'unconfigured', message: r.error };
          else if (r.status !== 401) this.snap = { status: 'error', error: { code: r.status, message: 'GET /api/v1/overview failed: ' + r.error }, at: Date.now() };
        } catch (e) {
          this.snap = { status: 'error', error: { code: 'network', message: 'Lost connection to the ORION server' }, at: Date.now() };
        } finally { this._inflight = null; }
        this._emit();
      })();
      return this._inflight;
    }
    _soon() { clearTimeout(this._refetchT); this._refetchT = setTimeout(() => this.refetch(), 250); }
    async _loadConfig() {
      const r = await this.api('/config').catch(() => null);
      if (!r || !r.ok || !ORION.app) return;
      const c = ORION.app.config, v = (k) => r.data[k] && r.data[k].value;
      if (v('freshness')) c.freshness = Object.assign({}, c.freshness, v('freshness'));
      if (v('thresholds')) c.thresholds = Object.assign({}, c.thresholds, v('thresholds'));
      if (v('rooms')) c.rooms = Object.assign({}, c.rooms, v('rooms'));
      if (v('home')) { c.home = Object.assign({}, c.home, { name: v('home').name }); c.timezone = v('home').timezone || c.timezone; }
      this.serverConfig = r.data;
    }

    _openWs() {
      if (this.stopped || !this.token || this.ws) return;
      const url = this.base.replace(/^http/, 'ws') + '/api/v1/ws';
      let ws;
      try { ws = new WebSocket(url); } catch (e) { return this._wsRetry(); }
      this.ws = ws; this.wsState = 'connecting';
      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: this.token }));
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.type === 'ready') { this.wsState = 'open'; this.wsBackoff = 1000; this.refetch(); return; }
        if (m.type === 'tick') return;
        if (m.type === 'incident_opened' && ORION.app && ORION.app.toast) {
          ORION.app.toast((m.simulated ? '[Simulated] ' : '') + 'New alert: ' + (m.source || m.incident_type) + ' (' + String(m.severity).toUpperCase() + ')', m.severity === 'critical' ? 'bad' : '');
        }
        this._soon();
      };
      ws.onclose = (ev) => {
        this.ws = null; this.wsState = 'closed';
        if (ev.code === 4401 && !this.stopped) { this._refresh().then((ok) => { if (ok) this._openWs(); }); return; }
        this._wsRetry();
      };
      ws.onerror = () => { /* onclose follows */ };
    }
    _wsRetry() {
      if (this.stopped) return;
      this.refetch(); // shows OFFLINE/error state promptly if the server is gone
      setTimeout(() => this._openWs(), this.wsBackoff);
      this.wsBackoff = Math.min(this.wsBackoff * 2, 30000);
    }

    snapshot() { return this.snap; }

    /* Synchronous for the UI: returns cached points and fetches in the background, then re-renders. */
    history(key, from, to) {
      if (!this.token || !key) return [];
      const span = Math.round((to - from) / 60e3);
      const ck = key + '|' + span;
      const c = this.hist.get(ck);
      const now = Date.now();
      if (!c || (now - c.at > 15000 && !c.loading)) {
        const entry = c || { at: 0, pts: [] };
        entry.loading = true; this.hist.set(ck, entry);
        const q = '/telemetry?series=' + encodeURIComponent(key) + '&from=' + Math.floor(from) + '&to=' + Math.ceil(to) + '&max_points=' + (span > 1440 ? 1500 : 2000);
        this.api(q).then((r) => { entry.loading = false; entry.at = Date.now(); if (r.ok) { entry.pts = r.data.points; this._emit(); } }, () => { entry.loading = false; entry.at = Date.now(); });
      }
      return (c ? c.pts : []).filter((p) => p.t >= from && p.t <= to);
    }

    async acknowledge(id) {
      const r = await this.api('/incidents/' + encodeURIComponent(id) + '/ack', { method: 'POST' });
      if (r.ok) this.refetch();
      return { ok: r.ok, error: r.error };
    }
    async command({ actuator, action }) {
      const r = await this.api('/commands', { method: 'POST', body: { actuator, action } });
      this.refetch();
      if (!r.ok) return { ok: false, error: r.error };
      if (r.data.status === 'failed') return { ok: false, error: r.data.history[r.data.history.length - 1].note, command: r.data };
      return { ok: true, command: r.data };
    }
    async putConfig(key, value) { return this.api('/config/' + key, { method: 'PUT', body: value }); }
    setScenario() { /* simulation only */ }
  }

  LiveSource.serverBase = serverBase;
  LiveSource.SERVER_KEY = SERVER_KEY;
  ORION.sources.LiveSource = LiveSource;
})();
