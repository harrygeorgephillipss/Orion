/* ORION views — simple, plain-language pages. Technical detail lives in sheets and collapsible sections. */
'use strict';
(function () {
  const U = ORION.util, F = ORION.fmt, esc = U.esc, C = ORION.ui, I = C.icon;
  const A = () => ORION.app;
  const set = (el, sel, html) => { const n = el.querySelector(sel); if (n && n._h !== html) { n.innerHTML = html; n._h = html; } };
  const R = ORION.registry;
  const isSim = () => A().mode === 'demo';

  /* One tile per measured quantity of each registered sensor (DHT22 → temperature + humidity). */
  const tilesOf = (snap) => R.seriesList(snap).map((s) => ({ k: s.key, id: s.sensorId, metric: s.metric, icon: s.icon, name: s.name, series: s.key, color: s.color }));
  const tileOf = (k) => { const s = R.seriesInfo(k); return s ? { k, id: s.sensorId, metric: s.metric, icon: s.icon, name: s.name, series: s.key, color: s.color } : null; };
  /* The chart series the History page shows: the user's choice if it still exists, else the first one. */
  function curSeries(snap) {
    const list = R.seriesList(snap), want = A().ui.histSeries;
    const hit = list.find((x) => x.key === want);
    if (hit) return hit.key;
    const byMetric = want && list.find((x) => x.metric === R.parseSeries(want).metric);
    return byMetric ? byMetric.key : list.length ? list[0].key : null;
  }

  /* ---------- sensor reading → plain words ---------- */
  function reading(k, snap, ev) {
    const t = tileOf(k), s = snap.sensors[t.id], st = ev.sensors[t.id], f = s.fields, m = t.metric;
    let big = '—', small = '', level = 'ok', unit = '';
    if (m === 'mq2') {
      if (s.quality === 'warming_up' && st.status !== 'stale') { big = 'Warming up'; small = `${s.warmup_remaining_s} s left`; level = 'muted'; }
      else { big = { normal: 'Clear', warning: 'Smoke', critical: 'Danger' }[s.state] || '—'; small = `Level ${f.raw_adc} (raw)`; level = { normal: 'ok', warning: 'warn', critical: 'crit' }[s.state] || 'muted'; }
    } else if (m === 'flame') {
      // The controller's state is authoritative; the raw field is only a fallback.
      const fl = s.state === 'critical' || s.state === 'warning' || f.detected === true;
      big = fl ? 'Flame!' : 'None'; level = fl ? 'crit' : 'ok'; small = fl ? 'Fire sensor triggered' : 'No flame seen';
    } else if (m === 'water') {
      const wet = s.state === 'warning' || s.state === 'critical' || f.wet === true;
      big = wet ? 'Wet' : 'Dry'; level = wet ? 'warn' : 'ok'; small = f.raw_adc == null ? '' : `Level ${f.raw_adc} (raw)`;
    }
    else if (m === 'temp') { if (f.temperature_c == null) { big = 'No reading'; level = 'muted'; } else { big = F.temp(f.temperature_c); unit = F.tempUnit(); small = 'Room temperature'; } }
    else if (m === 'hum') { if (f.humidity_percent == null) { big = 'No reading'; level = 'muted'; } else { big = f.humidity_percent.toFixed(0); unit = '%'; small = 'Relative humidity'; } }
    // A sensor that is faulty, disconnected or not ready never shows a healthy-looking value.
    if (st.status === 'fault') { big = 'No reading'; level = 'muted'; small = 'Sensor fault'; }
    if (st.status === 'disconnected') { big = 'No reading'; level = 'muted'; small = 'Sensor disconnected'; }
    if (st.status === 'warming_up' && m !== 'mq2') { big = 'Not ready'; level = 'muted'; small = 'Warming up'; }
    if (st.status === 'stale' && s.received_at == null) { big = 'No reading'; level = 'muted'; small = ''; }
    if (st.status === 'live' && s.quality === 'valid' && s.state === 'unknown' && (m === 'flame' || m === 'water' || m === 'mq2')) { big = 'Unknown'; level = 'muted'; small = 'Controller reported no state'; }
    let foot;
    if (st.status === 'stale') foot = s.received_at == null ? 'No reading received yet' : `Not updating · last reading ${F.ago(s.received_at)}`;
    else if (st.status === 'fault') foot = 'Sensor reported a fault';
    else if (st.status === 'disconnected') foot = 'Check the sensor wiring';
    else if (st.status === 'warming_up') foot = 'Getting ready';
    else foot = `Updated ${F.ago(s.received_at)}`;
    return { big, small, level, unit, foot, stale: st.status === 'stale', status: st.status, room: R.roomOf(A().config, s) };
  }

  function tile(t, snap, ev) {
    const r = reading(t.k, snap, ev);
    const now = Date.now();
    const sp = ORION.charts.spark(A().source.history(t.series, now - 30 * 60e3, now), t.color, now - 30 * 60e3, now);
    return `<button class="tile lv-${r.level}${r.stale ? ' is-stale' : ''}" data-action="sensor" data-k="${t.k}" aria-label="${esc(t.name)}: ${esc(r.big)} ${esc(r.unit)}. ${esc(r.foot)}. Open details.">
      <div class="t-top">${I(t.icon, 't-ic')}<div class="t-name">${esc(t.name)}<span>${esc(r.room)}</span></div></div>
      <div class="t-val">${r.stale ? '<span class="t-lk">Last known</span>' : ''}<b>${esc(r.big)}</b>${r.unit ? `<i>${esc(r.unit)}</i>` : ''}</div>
      <div class="t-small">${esc(r.small)}</div>
      <div class="t-spark">${sp}</div>
      <div class="t-foot">${r.stale ? I('clock') : r.status === 'live' ? '<i class="pulse-dot"></i>' : I('info')}<span>${esc(r.foot)}</span>${isSim() || snap.sensors[t.id].simulated ? C.demoTag() : ''}</div>
    </button>`;
  }

  /* ---------- overall status ---------- */
  function statusCard(ev, snap) {
    const p = C.PLAIN[ev.system] || C.PLAIN.OFFLINE;
    let title = p.title, sub = p.sub;
    const hazards = snap && snap.incidents ? snap.incidents.filter((i) => i.state !== 'cleared' && (i.severity === 'critical' || i.severity === 'warning')).sort((a, b) => (b.severity === 'critical') - (a.severity === 'critical')) : [];
    if (ev.system === 'EMERGENCY' || ev.system === 'ATTENTION') {
      title = C.incidentSentence(hazards[0]) + (hazards.length > 1 ? ` (+${hazards.length - 1} more)` : '');
      sub = ev.system === 'EMERGENCY'
        ? 'The alarm on the device works on its own. If there is real danger, get everyone out and call 112 or 101 (fire).'
        : 'ORION is keeping an eye on it. Check the area when it’s safe to do so.';
    }
    if (ev.system === 'DEGRADED' && ev.reasons.length) sub = ev.reasons[0] + (ev.reasons.length > 1 ? ` (+${ev.reasons.length - 1} more)` : '');
    const lk = ev.lastKnown ? `<div class="st-lk">${I('alert')} Before the connection dropped, ORION was reporting ${ev.lastKnown === 'EMERGENCY' ? 'an emergency' : 'a warning'}. It may still be happening.</div>` : '';
    const also = ev.system !== 'DEGRADED' && ev.notes && ev.notes.length && ev.system !== 'OFFLINE' ? `<div class="st-also">${I('info')} Also: ${esc(ev.notes[0])}${ev.notes.length > 1 ? ` (+${ev.notes.length - 1})` : ''}</div>` : '';
    return `<section class="status st-${p.cls}" aria-live="polite">
      <div class="st-ic">${I(p.icon)}</div>
      <div class="st-txt"><div class="st-k">System state · ${esc(ev.system)}</div><h1>${esc(title)}</h1><p>${esc(sub)}</p>${lk}${also}</div>
      <div class="st-time">${snap && snap.at ? 'Checked ' + esc(F.time(snap.at)) : ''}</div>
    </section>`;
  }

  function alertCard(i) {
    const s = C.SEV[i.severity] || C.SEV.info;
    const ic = { smoke: 'smoke', flame: 'flame', water: 'water', controller: 'chip', gsm: 'signal' }[i.type] || 'info';
    return `<div class="alert a-${s.cls}" role="${i.severity === 'critical' ? 'alert' : 'status'}">
      <div class="a-ic">${I(ic)}</div>
      <div class="a-txt"><b>${esc(C.incidentSentence(i))}</b><span>Started ${esc(F.time(i.opened_at))} · ${esc(F.ago(i.opened_at))}${i.acknowledged_at ? ' · marked as seen' : ''}</span></div>
      <div class="a-act">${i.acknowledged_at ? C.chip('info', 'Seen', 'check') : `<button class="btn sm" data-action="ack" data-id="${esc(i.id)}">Mark as seen</button>`}<button class="btn sm ghost" data-action="open-incident" data-id="${esc(i.id)}">Details</button></div>
    </div>`;
  }

  function devicesCompact(snap) {
    const a = snap.actuators;
    if (!a || !a.fan) return '<p class="hint">No outputs have reported yet.</p>';
    const onoff = (v) => v === 'on' ? C.chip('ok', 'On') : C.chip('off', 'Off');
    const led = (id) => a.leds.items.find((l) => l.id === id).commanded;
    const rows = [
      ['fan', 'Exhaust fan', onoff(a.fan.commanded) + (a.fan.cooldown_remaining_s ? `<small>runs ${a.fan.cooldown_remaining_s} s more</small>` : '')],
      ['bell', 'Buzzer', a.buzzer.commanded === 'on' ? C.chip('crit', 'Sounding') : C.chip('off', 'Quiet')],
      ['door', 'Model door', a.mg995.target_angle > 0 ? C.chip('warn', 'Set to open') : C.chip('off', 'Set to closed')],
      ['bulb', 'Status light', led('led-red') === 'on' ? C.chip('crit', 'Red') : C.chip('ok', 'Green')],
      ['bulb', 'Room lights', led('led-white') === 'on' ? C.chip('ok', 'On') : C.chip('off', 'Off')],
      ['mist', 'Mist maker', C.chip('off', 'Not installed')],
    ];
    return `<ul class="rows">${rows.map(([ic, n, v]) => `<li>${I(ic)}<span>${esc(n)}</span><span class="r-v">${v}</span></li>`).join('')}</ul><p class="hint">Shows what the controller told each device to do. Nothing reports back whether it physically happened.</p>`;
  }
  function connCompact(snap, ev) {
    const row = (ic, n, ok, okText, badText, sub) => `<li>${I(ic)}<span>${esc(n)}<small>${esc(sub)}</small></span><span class="r-v">${ok ? C.chip('ok', okText) : C.chip('crit', badText)}</span></li>`;
    const g = snap.gsm || {};
    const ctrls = Object.entries(snap.controllers || {}).sort(([, a], [, b]) => (b.is_gateway ? 1 : 0) - (a.is_gateway ? 1 : 0));
    return `<ul class="rows">
      ${ctrls.map(([k, c]) => row('chip', c.name, ev.controllers[k].online, 'Online', 'No signal', (c.last_seen_at == null ? 'Never seen' : 'Last seen ' + F.ago(c.last_seen_at)) + (c.is_gateway ? ' · gateway' : ''))).join('')}
      ${!ev.gsm.reported ? `<li>${I('signal')}<span>GSM (SIM800C)<small>No status received</small></span><span class="r-v">${C.chip('off', 'Unknown')}</span></li>` : row('signal', 'GSM (SIM800C)', g.network_registered, 'Can text & call', 'No network', g.network_registered ? `Signal ${g.csq}/31` : 'SMS and calls unavailable')}
    </ul>`;
  }

  /* ================= Home ================= */
  const home = {
    title: 'Home',
    mount(el) {
      el.innerHTML = `<div id="h-status"></div><div id="h-alerts" class="alerts"></div>
        <div class="sec-h"><h2>Sensors</h2><span class="hint">Tap a sensor for details</span></div><div id="h-tiles" class="tiles"></div>
        <div class="two">
          <section class="card"><div class="sec-h"><h2>Devices</h2><a class="lnk" href="#devices">All devices</a></div><div id="h-dev"></div></section>
          <section class="card"><div class="sec-h"><h2>Connections</h2><a class="lnk" href="#config">Diagnostics</a></div><div id="h-conn"></div></section>
        </div>
        <div class="aura-card"><button class="ac-main" data-action="aura-open"><span class="orb" aria-hidden="true"></span><span class="ac-t"><b>Ask Aura</b><span>Checks your sensors, explains alerts and opens the right page — in English, മലയാളം, हिन्दी and more</span></span></button><button class="ac-mic" data-action="voice-open" aria-label="Talk to Aura now" title="Talk to Aura">${I('mic')}</button></div>`;
    },
    update(el) {
      const { snap, ev } = A();
      const g = C.guard(ev, 5);
      if (g) { set(el, '#h-status', ev && ev.system !== 'LOADING' ? statusCard(ev, snap) : ''); set(el, '#h-tiles', g); ['#h-alerts', '#h-dev', '#h-conn'].forEach((s) => set(el, s, '')); return; }
      set(el, '#h-status', statusCard(ev, snap));
      const act = snap.incidents.filter((i) => i.state !== 'cleared').sort((a, b) => rank(b) - rank(a) || b.opened_at - a.opened_at);
      set(el, '#h-alerts', act.map(alertCard).join(''));
      const tiles = tilesOf(snap);
      set(el, '#h-tiles', tiles.length ? tiles.map((t) => tile(t, snap, ev)).join('') : C.statePanel('empty', 'No sensors registered', 'Register a controller and its sensors to see readings here.'));
      set(el, '#h-dev', devicesCompact(snap));
      set(el, '#h-conn', connCompact(snap, ev));
    },
  };
  const rank = (i) => ({ critical: 4, warning: 3, degraded: 2, info: 1 }[i.severity] || 0);

  /* ---------- sensor detail sheet ---------- */
  const PENDING_FOR = { mq2: ['mq2', 'mq2_level', 'door'], flame: ['flame', 'flame_buzzer', 'flame_lights'], water: ['water', 'water_notify'], temp: ['dht'], hum: ['dht'] }; // keyed by metric
  const EXPLAIN = {
    mq2: 'The MQ-2 senses smoke and flammable gas. ORION shows its raw level, not a gas concentration (ppm), because the sensor isn’t calibrated.',
    flame: 'The flame sensor sees the light of a nearby flame. It only says yes or no.',
    water: 'The water sensor detects water touching it. It can’t tell how big a leak is.',
    temp: 'The DHT22 measures room temperature.',
    hum: 'The DHT22 measures how much moisture is in the air.',
  };
  function sensorSheet(k) {
    const { snap, ev, config } = A();
    if (!snap || snap.status !== 'ok') return C.guard(ev, 1) || '';
    const t = tileOf(k);
    if (!t || !snap.sensors[t.id]) return C.statePanel('empty', 'Sensor not found', 'This sensor is no longer registered.');
    const s = snap.sensors[t.id], r = reading(k, snap, ev), f = s.fields;
    const now = Date.now(), m = t.metric;
    const ctrl = s.controller && snap.controllers ? snap.controllers[s.controller] : null;
    const gk = R.gatewayKey(snap);
    const via = ctrl ? ctrl.name + (gk && gk !== s.controller ? ` → ${snap.controllers[gk].name} gateway` : '') : 'not reported';
    const rows = [
      m === 'mq2' ? ['Raw level', String(f.raw_adc)] : null,
      m === 'mq2' && s.fw_threshold ? ['Firmware levels', `warning ${s.fw_threshold.warning} · danger ${s.fw_threshold.critical}`] : null,
      m === 'mq2' && s.fw_threshold && (config.thresholds.mq2_warning !== s.fw_threshold.warning || config.thresholds.mq2_critical !== s.fw_threshold.critical) ? ['App levels', `warning ${config.thresholds.mq2_warning} · danger ${config.thresholds.mq2_critical} — differ from the device; the device’s values are what trigger the alarm`] : null,
      m === 'water' ? ['Raw level', `${f.raw_adc} (wet at ${s.fw_threshold ? s.fw_threshold.wet : '—'})`] : null,
      m === 'flame' ? ['Digital output', `${f.digital_value} · ${s.polarity}`] : null,
      ['Device says', s.state],
      ['Data quality', s.quality + (s.fault ? ` — ${s.fault}` : '')],
      ['Measured at', F.dt(s.recorded_at)],
      ['Received', s.received_at == null ? 'never' : `${F.ago(s.received_at)} (${((s.received_at - s.recorded_at) / 1000).toFixed(1)} s delay)`],
      ['Sensor ID', `${s.id} · seq ${s.sequence == null ? '—' : s.sequence}`],
      ['Connected to', via + (s.simulated ? ' (simulated)' : '')],
      ['Data source', s.simulated ? 'SIMULATION — not a hardware reading' : 'Hardware telemetry'],
    ];
    const pend = ORION.pending.filter((p) => (PENDING_FOR[m] || []).includes(p.key));
    return `<div class="sh-head">${I(t.icon, 'sh-ic lv-' + r.level)}<div><h2 id="md-t">${esc(t.name)}</h2><span class="hint">${esc(r.room)}${s.simulated ? ' · simulated data' : ''}</span></div></div>
      <div class="sh-val lv-${r.level}${r.stale ? ' is-stale' : ''}">${r.stale ? '<span class="t-lk">Last known</span>' : ''}<b>${esc(r.big)}</b>${r.unit ? `<i>${esc(r.unit)}</i>` : ''}<span>${esc(r.foot)}</span></div>
      <p class="sh-ex">${esc(EXPLAIN[m] || '')}</p>
      <div class="sh-chart">${chartFor(t.series, now - 3600e3, now, 170, 520)}</div>
      <details class="more" open><summary>Technical details</summary>${C.kv(rows)}</details>
      ${pend.length ? `<details class="more"><summary>Not decided yet (${pend.length})</summary><ul class="pend">${pend.map((p) => `<li><b>${esc(p.title)}</b><span>${esc(p.detail)}</span></li>`).join('')}</ul></details>` : ''}`;
  }

  /* ================= History ================= */
  const RANGES = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 86400e3, '7d': 7 * 86400e3 };
  const RLABEL = { '1h': 'Hour', '6h': '6 hours', '24h': 'Day', '7d': 'Week' };
  const viewW = () => { const v = document.getElementById('view'); return v ? v.clientWidth : 1000; };
  function markersFor(series, from, to) {
    const snap = A().snap, sid = R.parseSeries(series).sensorId, sensor = snap.sensors[sid];
    // A sensor's data also stops when its own controller or the gateway goes silent.
    const ctrlIds = new Set();
    const gk = R.gatewayKey(snap);
    if (gk) ctrlIds.add(snap.controllers[gk].id);
    if (sensor && sensor.controller && snap.controllers[sensor.controller]) ctrlIds.add(snap.controllers[sensor.controller].id);
    return snap.incidents
      .filter((i) => (i.source_id === sid || (i.type === 'controller' && ctrlIds.has(i.source_id))) && i.opened_at <= to && (i.cleared_at || Date.now()) >= from)
      .map((i) => ({ t0: i.opened_at, t1: i.cleared_at || Date.now(), sev: (C.SEV[i.severity] || C.SEV.info).cls, label: `${C.incidentSentence(i)} · ${F.dt(i.opened_at)}`, short: i.severity === 'degraded' ? 'NO DATA' : (C.SEV[i.severity] || C.SEV.info).word.toUpperCase() }));
  }
  function thresholdsFor(key) {
    const t = A().config.thresholds, series = R.parseSeries(key).metric;
    if (series === 'mq2') return [{ v: t.mq2_warning, label: 'warning ' + t.mq2_warning, sev: 'warn' }, { v: t.mq2_critical, label: 'danger ' + t.mq2_critical, sev: 'crit' }];
    if (series === 'water') return [{ v: t.water_wet, label: 'wet ' + t.water_wet, sev: 'warn' }];
    if (series === 'temp' && t.temp_advisory_c != null) return [{ v: t.temp_advisory_c, label: 'advisory', sev: 'warn' }];
    if (series === 'hum' && t.humidity_advisory != null) return [{ v: t.humidity_advisory, label: 'advisory', sev: 'warn' }];
    return [];
  }
  function seriesPoints(series, from, to) {
    let pts = A().source.history(series, from, to) || [];
    if (R.parseSeries(series).metric === 'temp' && A().config.tempUnit === 'F') pts = pts.map((p) => Object.assign({}, p, { v: p.v == null ? null : +(p.v * 9 / 5 + 32).toFixed(1) }));
    return pts;
  }
  function chartFor(series, from, to, height, width) {
    const S = R.seriesInfo(series), m = S.metric;
    return ORION.charts.render({
      points: seriesPoints(series, from, to), from, to, unit: m === 'temp' ? F.tempUnit() : m === 'mq2' || m === 'water' ? 'raw' : S.unit, dp: S.dp, color: S.color, title: S.label,
      thresholds: thresholdsFor(series), markers: markersFor(series, from, to), height, width, step: m === 'flame', binary: m === 'flame',
      yMin: m === 'flame' ? -0.1 : null, yMax: m === 'flame' ? 1.1 : null,
    });
  }
  const pillsHTML = (snap, cur) => R.seriesList(snap).map((t) => `<button class="pill${cur === t.key ? ' on' : ''}" data-action="hseries" data-s="${esc(t.key)}" aria-pressed="${cur === t.key}">${I(t.icon)}${esc(t.name)}${R.sensorList(snap).filter((x) => x.type === t.type).length > 1 ? ' · ' + esc(R.roomOf(A().config, snap.sensors[t.sensorId]) || t.sensorId) : ''}</button>`).join('');
  const history = {
    title: 'History',
    mount(el) {
      const ui = A().ui;
      el.innerHTML = `<div class="page-h"><h1>History</h1><p>How each sensor changed over time. Coloured bands are alerts; striped bands mean no data arrived.</p></div>
        <div class="bar">
          <div class="pills" id="hi-pills" role="group" aria-label="Sensor"></div>
          <div class="seg" role="group" aria-label="Time range">${Object.keys(RANGES).map((r) => `<button class="seg-b${ui.histRange === r ? ' on' : ''}" data-action="range" data-r="${r}" aria-pressed="${ui.histRange === r}">${RLABEL[r]}</button>`).join('')}</div>
        </div>
        <section class="card"><div id="hi-sum" class="sum"></div><div id="hi-chart"></div><div class="card-foot"><span id="hi-range" class="hint"></span><button class="btn sm ghost" data-action="csv-dl">${I('chart')}Export CSV</button></div></section>
        <div id="hi-csv"></div>`;
    },
    update(el, force) {
      const { ev, snap, ui } = A();
      const g = C.guard(ev, 1);
      if (g) { set(el, '#hi-pills', ''); return set(el, '#hi-chart', g); }
      const key = curSeries(snap);
      set(el, '#hi-pills', pillsHTML(snap, key));
      if (!key) { set(el, '#hi-sum', ''); return set(el, '#hi-chart', C.statePanel('empty', 'No sensors registered', 'There is no history to show yet.')); }
      ui.histSeries = key;
      if (!force && ui.tick % 5 !== 1 && el.querySelector('#hi-chart').innerHTML) return;
      if (!force && el.querySelector('.chart-wrap:hover')) return;
      const to = Date.now(), from = to - RANGES[ui.histRange], s = key, m = R.parseSeries(key).metric, sid = R.parseSeries(key).sensorId;
      const pts = seriesPoints(s, from, to).filter((p) => p.v != null);
      const n = snap.incidents.filter((i) => i.source_id === sid && i.opened_at >= from && i.severity !== 'degraded').length;
      const unit = m === 'temp' ? F.tempUnit() : m === 'hum' ? '%' : '';
      let sum;
      if (m === 'flame') sum = `<div><b>${pts.some((p) => p.v) ? 'Yes' : 'No'}</b><span>flame seen</span></div>`;
      else if (pts.length) {
        let mn = Infinity, mx = -Infinity, tot = 0; for (const p of pts) { mn = Math.min(mn, p.v); mx = Math.max(mx, p.v); tot += p.v; }
        const dp = m === 'temp' ? 1 : 0;
        sum = `<div><b>${mx.toFixed(dp)}${unit}</b><span>highest</span></div><div><b>${mn.toFixed(dp)}${unit}</b><span>lowest</span></div><div><b>${(tot / pts.length).toFixed(dp)}${unit}</b><span>average</span></div>`;
      } else sum = '';
      set(el, '#hi-sum', sum + `<div><b>${n}</b><span>${n === 1 ? 'alert' : 'alerts'}</span></div>`);
      set(el, '#hi-range', `${esc(F.dt(from))} → ${esc(F.dt(to))}${isSim() || (snap.sensors[sid] && snap.sensors[sid].simulated) ? ' · simulated data' : ''}${m === 'mq2' || m === 'water' ? ' · raw sensor level, not calibrated' : ''}`);
      set(el, '#hi-chart', chartFor(s, from, to, 300, viewW() - 50));
    },
  };
  function buildCSV(series, from, to) {
    const rows = ['series,sensor_id,recorded_at_utc,received_at_utc,value,unit,quality,source'];
    const S = R.seriesInfo(series);
    if (!S) return rows[0];
    const source = isSim() ? 'simulation' : 'hardware';
    const q = (v) => (/[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
    for (const p of A().source.history(series, from, to) || []) rows.push([S.metric, S.sensorId, U.iso(p.t), U.iso(p.r), p.v == null ? '' : p.v, S.metric === 'temp' ? 'celsius' : S.unit, p.q, p.sim === true || (p.sim == null && source === 'simulation') ? 'simulation' : 'hardware'].map(q).join(','));
    return rows.join('\n');
  }

  /* ================= Alerts ================= */
  const alerts = {
    title: 'Alerts',
    mount(el) {
      const ui = A().ui;
      el.innerHTML = `<div class="page-h"><h1>Alerts</h1><p>“Mark as seen” only records that you know. It doesn’t stop the alarm — an alert ends by itself when the sensor reads normal again.</p></div>
        <div class="bar"><div class="seg" role="group" aria-label="Filter">${[['active', 'Active'], ['all', 'All']].map(([f, l]) => `<button class="seg-b${ui.incFilter === f ? ' on' : ''}" data-action="inc-filter" data-f="${f}" aria-pressed="${ui.incFilter === f}">${l}</button>`).join('')}</div></div>
        <div id="al-list" class="al-list"></div>`;
      el.addEventListener('toggle', (e) => { const d = e.target; if (d.matches && d.matches('details.al')) { if (d.open) A().ui.openAlerts.add(d.dataset.id); else A().ui.openAlerts.delete(d.dataset.id); } }, true);
    },
    update(el) {
      const { snap, ev, ui } = A();
      const g = C.guard(ev, 3);
      if (g) return set(el, '#al-list', g);
      let list = snap.incidents.slice().sort((a, b) => (a.state === 'cleared') - (b.state === 'cleared') || b.opened_at - a.opened_at);
      if (ui.incFilter === 'active') list = list.filter((i) => i.state !== 'cleared');
      if (!list.length) return set(el, '#al-list', `<div class="empty">${I('check')}<b>No active alerts</b><span>Everything is quiet. <button class="lnk" data-action="inc-filter" data-f="all">See past alerts</button></span></div>`);
      set(el, '#al-list', list.map(alertRow).join(''));
    },
  };
  function alertRow(i) {
    const s = C.SEV[i.severity] || C.SEV.info, open = A().ui.openAlerts.has(i.id);
    const ic = { smoke: 'smoke', flame: 'flame', water: 'water', controller: 'chip', gsm: 'signal' }[i.type] || 'info';
    const st = i.state === 'cleared' ? C.chip('off', 'Resolved', 'check') : i.acknowledged_at ? C.chip(s.cls, 'Active · seen') : C.chip(s.cls, 'Active');
    const acts = i.actions.slice().sort((a, b) => a.at - b.at);
    return `<details class="al a-${s.cls}${i.state === 'cleared' ? ' done' : ''}" data-id="${esc(i.id)}"${open ? ' open' : ''}>
      <summary><span class="a-ic">${I(ic)}</span><span class="a-txt"><b>${esc(C.incidentSentence(i))}</b><span>${esc(F.day(i.opened_at))}, ${esc(F.time(i.opened_at))} · ${esc(s.word)}${i.cleared_at ? ' · lasted ' + esc(F.dur((i.cleared_at - i.opened_at) / 1000)) : ''}</span></span>${st}${I('chevron', 'chev')}</summary>
      <div class="al-body">
        ${i.state !== 'cleared' && !i.acknowledged_at ? `<button class="btn sm" data-action="ack" data-id="${esc(i.id)}">Mark as seen</button>` : ''}
        ${i.acknowledged_at ? `<p class="hint">Seen by ${esc(i.acknowledged_by)} at ${esc(F.time(i.acknowledged_at))}.</p>` : ''}
        <h3>What the sensor read</h3>${C.kv([['Reading', `${i.snapshot.value} ${i.snapshot.unit || ''}`], i.snapshot.peak != null ? ['Highest', String(i.snapshot.peak)] : null, ['Alert level', i.snapshot.threshold]])}
        ${acts.length ? `<h3>What happened</h3><ul class="steps">${acts.map((a) => `<li><span class="mono">${esc(F.time(a.at))}</span><span>${esc(a.action)}<small>${esc(a.outcome)}</small></span></li>`).join('')}</ul>` : ''}
        <h3>Timeline</h3><ul class="steps">${i.events.slice().sort((a, b) => a.at - b.at).map((e) => `<li><span class="mono">${esc(F.time(e.at))}</span><span>${esc(e.text)}</span></li>`).join('')}</ul>
        <p class="hint mono">${esc(i.id)}</p>
      </div></details>`;
  }

  /* ================= Devices ================= */
  const devices = {
    title: 'Devices',
    mount(el) {
      el.innerHTML = `<div class="page-h"><h1>Devices</h1><p>What each part of the system is doing. Devices have no sensors to confirm they moved or switched, so ORION shows what they were <em>told</em> to do.</p></div>
        <section class="card"><h2>Outputs</h2><div id="dv-out"></div></section>
        <section class="card"><h2>Connections</h2><div id="dv-conn"></div></section>
        <section class="card"><h2>Text &amp; call alerts</h2><div id="dv-gsm"></div></section>
        <section class="card"><details class="more"><summary>Recent commands</summary><div id="dv-cmd"></div></details></section>`;
    },
    update(el) {
      const { snap, ev } = A();
      const g = C.guard(ev, 3);
      if (g) { ['#dv-conn', '#dv-gsm', '#dv-cmd'].forEach((s) => set(el, s, '')); return set(el, '#dv-out', g); }
      set(el, '#dv-out', outputs(snap, ev));
      set(el, '#dv-conn', connCompact(snap, ev) + `<p class="hint">ESP32 runs on 3.3 V and the UNO on 5 V — use a level shifter between them.</p>`);
      set(el, '#dv-gsm', gsmList(snap));
      set(el, '#dv-cmd', cmdList(snap));
    },
  };
  function outputs(snap, ev) {
    if (!snap.actuators || !snap.actuators.fan) return '<p class="hint">No outputs have reported yet.</p>';
    const a = snap.actuators, demo = isSim(), cmdOK = A().canCommand(), gk = R.gatewayKey(snap), live = gk ? ev.controllers[gk].online : false;
    const busy = (snap.commands || []).find((c) => ['requested', 'queued', 'sent', 'accepted'].includes(c.status));
    const dis = !live || busy ? 'disabled' : '';
    const btn = (act, label) => `<button class="btn sm ghost" data-action="cmd" data-act="${act}" ${dis}>${esc(label)}</button>`;
    const onoff = (v) => v === 'on' ? C.chip('ok', 'On') : C.chip('off', 'Off');
    const row = (ic, name, state, note, ctrl) => `<div class="drow">${I(ic, 'd-ic')}<div class="d-txt"><b>${esc(name)}</b><span>${note}</span></div><div class="d-state">${state}</div>${ctrl ? `<div class="d-ctrl">${ctrl}</div>` : ''}</div>`;
    const ledTxt = a.leds.items.map((l) => `${l.name.split(' — ')[0]} ${l.commanded}`).join(' · ');
    const simNote = busy ? '<span class="tag-demo">waiting for last command</span>' : !live ? '<span class="tag-demo">gateway offline</span>' : demo ? '<span class="tag-demo">simulated</span>' : '';
    return [
      row('fan', 'Exhaust fan', onoff(a.fan.commanded), a.fan.cooldown_remaining_s ? `Keeps running ${a.fan.cooldown_remaining_s} s after smoke clears` : `Last changed ${esc(F.ago(a.fan.last_changed_at))} by ${esc(a.fan.by)}`, cmdOK ? `${btn('fan:on', 'Turn on')}${btn('fan:off', 'Turn off')}${simNote}` : ''),
      row('bell', 'Buzzer', a.buzzer.commanded === 'on' ? C.chip('crit', 'Sounding') : C.chip('off', 'Quiet'), 'Sounds automatically on smoke — doesn’t need this app', cmdOK ? `${btn('buzzer:test', 'Test 2 s')}${simNote}` : ''),
      row('door', 'Model door (MG995 servo)', a.mg995.target_angle > 0 ? C.chip('warn', `Set to open ${a.mg995.target_angle}°`) : C.chip('off', 'Set to closed'), 'Opens 180° for 5 s on smoke. No manual control — needs a safety review before any real door.', ''),
      row('bulb', 'Lights & LEDs', '', esc(ledTxt), ''),
      row('relay', 'Relay module', C.chip('off', a.relay.channels[0].commanded === 'energised' ? 'Channel 1 on' : 'Channel 1 off'), 'Channel 1 → fan (planned). Wiring and on-level not confirmed yet.', ''),
      row('mist', 'Mist maker', C.chip('off', 'Not installed'), 'Not part of the current hardware. Kept as a disabled placeholder — never switches on by itself.', ''),
      row('servo', 'Second servo (SG90)', C.chip('off', 'Not set up'), 'Disabled until its job is decided.', ''),
    ].join('');
  }
  function gsmList(snap) {
    const W = { sent: ['ok', 'Sent'], failed: ['crit', 'Failed'], timeout: ['warn', 'No answer'], queued: ['info', 'Waiting'], sending: ['info', 'Sending…'], unknown: ['degr', 'Unknown'], not_configured: ['off', 'Not set up'] };
    const list = (snap.gsmAttempts || []).slice(0, 6);
    if (!list.length) return '<p class="hint">No texts or calls yet.</p>';
    return `<ul class="rows">${list.map((a) => { const w = W[a.status] || ['info', a.status]; return `<li>${I(a.type === 'sms' ? 'send' : 'signal')}<span>${a.type === 'sms' ? 'Text message' : 'Phone call'} to ${esc(a.destination.split(' · ')[0])}<small>${esc(F.day(a.created_at))}, ${esc(F.time(a.created_at))} · ${esc(a.note)}</small></span><span class="r-v">${C.chip(w[0], w[1])}</span></li>`; }).join('')}</ul>
      <p class="hint">“Sent” means the GSM module accepted the text. ORION never claims it was delivered.</p>`;
  }
  function cmdList(snap) {
    if (!snap.commands || !snap.commands.length) return '<p class="hint">No commands yet. Commands you send above appear here with each step.</p>';
    return snap.commands.slice(0, 6).map((c) => `<div class="cmd"><div class="cmd-h"><b>${esc(c.actuator)} → ${esc(c.action)}</b>${C.cmdChip(c.status)}${c.simulated ? '<span class="tag-demo">simulated</span>' : ''}</div>
      <ul class="steps">${c.history.map((h) => `<li><span class="mono">${esc(F.time(h.at))}</span><span>${C.cmdChip(h.status)} ${esc(h.note)}</span></li>`).join('')}</ul></div>`).join('') +
      '<p class="hint">A command never shows as done until the device answers. Without a feedback sensor, the last step is “Done · unconfirmed”.</p>';
  }

  /* ================= Settings ================= */
  const TZS = ['Asia/Kolkata', 'UTC', 'Asia/Dubai', 'Europe/London', 'America/New_York', 'Asia/Singapore'];
  const config = {
    title: 'Settings',
    mount(el) {
      const c = A().config, t = c.thresholds;
      const num = (id, v, label, hint, opt) => `<label class="fld"><span>${esc(label)}</span><input type="number" id="${id}" value="${v == null ? '' : v}" ${opt || ''}><small>${esc(hint)}</small></label>`;
      const snap = A().snap;
      const roomRows = snap && snap.status === 'ok' && snap.sensors ? R.sensorList(snap).map((s) => [s.id, s.label || s.id]) : Object.keys(c.rooms).map((id) => [id, id]);
      el.innerHTML = `<div class="page-h"><h1>Settings</h1><p>These settings are saved in this browser. Server-side settings (users, alert contacts, device thresholds) arrive with the ORION backend.</p></div>
      <section class="card"><h2>Appearance</h2><div class="set-row"><div><b>Theme</b><span class="hint">Both are designed to be easy on the eyes.</span></div><div class="seg">${[['dark', 'Calm dark', 'moon'], ['light', 'Calm light', 'sun']].map(([v, l, ic]) => `<button class="seg-b${(document.body.dataset.theme || 'dark') === v ? ' on' : ''}" data-action="theme" data-t="${v}" type="button">${I(ic)} ${l}</button>`).join('')}</div></div></section>
      <section class="card"><h2>Data</h2><div class="set-row"><div><b>Data source</b><span class="hint">Simulation is a built-in test mode — every value is invented. Live shows only real data from an ORION server.</span></div><div class="seg" id="cfgMode"></div></div>
        ${A().mode === 'live' ? `<div class="set-row"><div><b>ORION server</b><span class="hint">Leave empty to use the server this page was opened from.</span></div><div class="row-btns"><input id="c-server" class="inp" placeholder="https://orion.local" value="${esc(U.store.get('orion.server', ''))}" maxlength="200"><button class="btn sm ghost" data-action="server-save" type="button">Save</button></div></div>
        <div class="set-row"><div><b>Signed in</b><span class="hint">${A().source.user ? esc(A().source.user.name + ' · ' + A().source.user.email + ' · ' + A().source.user.role) : 'Not signed in'}</span></div>${A().source.user ? '<button class="btn sm ghost" data-action="logout" type="button">Sign out</button>' : '<button class="btn sm" data-action="login-open" type="button">Sign in</button>'}</div>` : ''}
        <div class="set-row"><div><b>Simulation scenarios</b><span class="hint">Try smoke, flame, a leak, sensor faults or going offline (simulation only).</span></div><button class="btn sm ghost" data-action="drawer-open"${isSim() ? '' : ' disabled'}>Open</button></div></section>
      <form id="cfg" class="stack">
        <section class="card"><h2>General</h2><div class="fgrid">
          <label class="fld"><span>Home name</span><input id="c-home" value="${esc(c.home.name)}" maxlength="60"></label>
          <label class="fld"><span>Time zone</span><select id="c-tz">${TZS.map((z) => `<option ${z === c.timezone ? 'selected' : ''}>${z}</option>`).join('')}</select></label>
          <label class="fld"><span>Temperature</span><select id="c-unit"><option value="C" ${c.tempUnit === 'C' ? 'selected' : ''}>°C</option><option value="F" ${c.tempUnit === 'F' ? 'selected' : ''}>°F</option></select></label>
        </div></section>
        <section class="card"><h2>Room names</h2><div class="fgrid">${roomRows.map(([id, n]) => `<label class="fld"><span>${esc(n)}</span><input data-room="${esc(id)}" value="${esc(c.rooms[id] || '')}" maxlength="40"></label>`).join('')}</div></section>
        <section class="card"><h2>Alert levels</h2><p class="hint">These are the app’s levels. The device keeps its own (shown on each sensor) and those are what trigger the alarm. Saving here doesn’t change the hardware.</p><div class="fgrid">
          ${num('t-mq2w', t.mq2_warning, 'Smoke warning (raw)', 'Placeholder until calibrated', 'min="0" max="4095"')}${num('t-mq2c', t.mq2_critical, 'Smoke danger (raw)', 'Must be above warning', 'min="0" max="4095"')}
          ${num('t-wet', t.water_wet, 'Water “wet” (raw)', 'Depends on the sensor', 'min="0" max="4095"')}
          ${num('t-temp', t.temp_advisory_c, 'Hot room warning (°C)', 'Leave empty for none', 'step="0.5"')}${num('t-hum', t.humidity_advisory, 'Humid room warning (%)', 'Leave empty for none', 'min="0" max="100"')}</div></section>
        ${A().mode === 'live' ? '' : '<section class="card"><h2>Text &amp; call alerts</h2><p class="hint">Emergency contacts for SMS and calls are managed on the ORION server — switch to Live mode and sign in. Simulation mode never texts or calls anyone.</p></section>'}
        <section class="card"><details class="more"><summary>Advanced</summary><div class="fgrid">${num('c-fresh', c.freshness.sensor_s, 'Mark readings old after (s)', 'Older readings show as “not updating”', 'min="5" max="600"')}${num('c-hb', c.freshness.heartbeat_s, 'Mark boards offline after (s)', 'No heartbeat in this time', 'min="5" max="600"')}</div></details></section>
        <div id="cfg-err" class="note crit" hidden></div>
        <div class="row-btns"><button class="btn" type="submit">Save</button><button class="btn ghost" type="button" data-action="cfg-reset">Reset</button></div>
      </form>
      ${A().mode === 'live' && A().source.user ? '<div id="live-settings" class="stack" style="gap:16px"></div>' : ''}
      <section class="card"><details class="more"><summary>Setup checklist · ${ORION.pending.length} decisions still open</summary><p class="hint">ORION doesn’t guess these. Each one stays switched off or marked until you decide.</p><ul class="pend">${ORION.pending.map((p) => `<li><b>${esc(p.title)}</b><span>${esc(p.detail)}</span></li>`).join('')}</ul></details></section>
      <section class="card"><details class="more" id="diagBox"><summary>Diagnostics</summary><div id="dg"></div></details></section>
      <p class="hint center">ORION is a prototype. It is not a certified fire alarm, gas detector or safety system.</p>`;
      el.querySelector('#cfg').addEventListener('submit', (e) => { e.preventDefault(); saveConfig(el); });
      if (ORION.liveSettings) ORION.liveSettings.mount(el.querySelector('#live-settings'));
      el.querySelector('#cfgMode').innerHTML = ['demo', 'live'].map((m) => `<button class="seg-b${A().mode === m ? ' on' : ''}" data-action="mode" data-mode="${m}" type="button">${m === 'demo' ? 'Simulation' : 'Live'}</button>`).join('');
    },
    update(el) {
      const box = el.querySelector('#diagBox');
      if (!box || !box.open) return;
      const { snap, ev } = A();
      const g = C.guard(ev, 1);
      if (g) return set(el, '#dg', g);
      const now = Date.now();
      const recent = R.seriesList(snap).filter((x) => x.metric !== 'hum').reduce((acc, x) => acc.concat(A().source.history(x.key, now - 60e3, now) || []), []);
      const delay = recent.length ? recent.reduce((s, p) => s + (p.r - p.t), 0) / recent.length / 1000 : null;
      set(el, '#dg', `<h3>Boards</h3><table class="tbl"><thead><tr><th>Board</th><th>Heartbeat</th><th>Last seen</th><th>Firmware</th></tr></thead><tbody>${Object.entries(snap.controllers).map(([k, c]) => `<tr><td>${esc(c.name)}</td><td>${ev.controllers[k].online ? C.chip('ok', 'OK') : C.chip('crit', 'Missing')}</td><td>${esc(F.ago(c.last_seen_at, now))}</td><td class="mono">${esc(c.firmware_version)}</td></tr>`).join('')}</tbody></table>
        <h3>Sensors</h3><table class="tbl"><thead><tr><th>Sensor</th><th>Quality</th><th>Measured</th><th>Delay</th><th>Seq</th></tr></thead><tbody>${R.sensorList(snap).map((s) => `<tr><td>${esc(s.label || s.id)}</td><td>${esc(ev.sensors[s.id].status === 'stale' ? 'stale' : s.quality)}</td><td class="mono">${esc(F.time(s.recorded_at))}</td><td class="mono">${s.received_at == null ? '—' : ((s.received_at - s.recorded_at) / 1000).toFixed(2) + ' s'}</td><td class="mono">${s.sequence == null ? '—' : s.sequence}</td></tr>`).join('')}</tbody></table>
        <h3>Data pipeline</h3>${C.kv([['Readings in last minute', String(recent.length)], ['Average delay', delay == null ? '—' : delay.toFixed(2) + ' s'], ['Missing messages', snap.pipeline ? String(snap.pipeline.seqGaps) : '—'], ['GSM', snap.gsm ? `${snap.gsm.module} · ${ev.gsm.reported ? (snap.gsm.network_registered ? 'registered, CSQ ' + snap.gsm.csq : 'not registered') : 'no report'} · 2G only (Jio SIMs won’t work)` : 'not registered'], ['Mode', isSim() ? 'SIMULATION (seed ' + A().source.seed + ', scenario ' + A().source.scenario + ')' : 'live']])}
        <h3>Log</h3><div class="log">${(snap.logs || []).slice(0, 40).map((l) => `<div class="log-r lv-${l.level}"><span class="mono">${esc(F.time(l.at))}</span><span class="lv">${esc(l.level)}</span><span>${esc(l.msg)}</span></div>`).join('')}</div>`);
    },
  };
  function saveConfig(el) {
    const app = A(), c = U.deepCopy(app.config);
    const v = (id) => el.querySelector(id).value.trim();
    const n = (id) => (v(id) === '' ? null : Number(v(id)));
    const errs = [];
    c.home.name = v('#c-home') || c.home.name; c.timezone = v('#c-tz'); c.tempUnit = v('#c-unit');
    c.freshness.sensor_s = n('#c-fresh'); c.freshness.heartbeat_s = n('#c-hb');
    if (!(c.freshness.sensor_s >= 5 && c.freshness.sensor_s <= 600)) errs.push('“Mark readings old after” must be 5–600 seconds.');
    if (!(c.freshness.heartbeat_s >= 5 && c.freshness.heartbeat_s <= 600)) errs.push('“Mark boards offline after” must be 5–600 seconds.');
    el.querySelectorAll('[data-room]').forEach((i) => { c.rooms[i.dataset.room] = i.value.trim(); });
    const t = c.thresholds;
    t.mq2_warning = n('#t-mq2w'); t.mq2_critical = n('#t-mq2c'); t.water_wet = n('#t-wet'); t.temp_advisory_c = n('#t-temp'); t.humidity_advisory = n('#t-hum');
    if (t.mq2_warning == null || t.mq2_critical == null || t.mq2_warning >= t.mq2_critical) errs.push('Smoke danger level must be higher than the warning level.');
    if (t.water_wet == null || t.water_wet < 0) errs.push('Water level is required.');
    if (t.humidity_advisory != null && (t.humidity_advisory < 0 || t.humidity_advisory > 100)) errs.push('Humidity must be 0–100 %.');
    const box = el.querySelector('#cfg-err');
    if (errs.length) { box.hidden = false; box.innerHTML = errs.map(esc).join('<br>'); return; }
    box.hidden = true;
    const changed = JSON.stringify(c.thresholds) !== JSON.stringify(app.config.thresholds);
    c.configVersion = 'cfg-local-' + Date.now().toString(36);
    app.config = c;
    const ok = U.store.set('orion.config.v1', c);
    if (app.source.logs) app.source.logs.unshift({ at: Date.now(), level: 'info', msg: `audit: settings saved by ${app.user.name}${changed ? ' (alert levels changed)' : ''}` });
    if (app.isAdmin() && app.source.putConfig) {
      // Server-side settings are shared by everyone and drive the server's incident engine.
      const src = app.source;
      Promise.all([
        src.putConfig('freshness', c.freshness), src.putConfig('thresholds', c.thresholds),
        src.putConfig('rooms', c.rooms), src.putConfig('home', { name: c.home.name, timezone: c.timezone }),
      ]).then((rs) => {
        const bad = rs.find((r) => !r.ok);
        app.toast(bad ? 'Saved in this browser, but the server refused: ' + bad.error : 'Settings saved on the ORION server.', bad ? 'bad' : '');
      });
    } else app.toast(ok ? (app.mode === 'live' ? 'Saved in this browser only (server settings need an admin).' : 'Settings saved.') : 'Settings applied for this visit (browser storage unavailable).');
    app.onData();
  }

  ORION.views = { home, history, alerts, devices, aura: ORION.auraView, config, _: { buildCSV, RANGES, sensorSheet, tilesOf, curSeries } };
})();
