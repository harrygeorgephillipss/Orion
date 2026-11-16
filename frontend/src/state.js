/* ORION health evaluation: freshness, sensor status and overall system state.
 * Precedence: OFFLINE (no valid controller link) > EMERGENCY > ATTENTION > DEGRADED > NORMAL.
 * A degraded condition never hides an emergency; stale/missing data never shows NORMAL.
 * Sensors and controllers come from the snapshot (see registry.js) — no IDs are assumed. */
'use strict';
(function () {
  const R = ORION.registry;

  function evaluate(snap, cfg, now) {
    now = now || Date.now();
    const out = { status: snap.status, system: null, reasons: [], notes: [], sensors: {}, controllers: {}, gsm: null, active: [], lastKnown: null, now, gateway: null };
    if (snap.status === 'loading') { out.system = 'LOADING'; return out; }
    if (snap.status === 'error') { out.system = 'OFFLINE'; out.reasons.push('Backend error: ' + ((snap.error && snap.error.message) || 'unknown error')); out.backendError = true; return out; }
    if (snap.status === 'empty') { out.system = 'OFFLINE'; out.reasons.push('No telemetry has been received yet.'); out.noData = true; return out; }
    if (snap.status === 'unconfigured') { out.system = 'OFFLINE'; out.reasons.push(snap.message || 'No data source configured.'); out.unconfigured = true; return out; }
    if (snap.status === 'auth') { out.system = 'OFFLINE'; out.reasons.push(snap.message || 'Sign in to see live data.'); out.needsAuth = true; return out; }

    const fresh = cfg.freshness.sensor_s * 1000, hb = cfg.freshness.heartbeat_s * 1000;
    for (const [k, c] of Object.entries(snap.controllers || {})) {
      const age = c.last_seen_at == null ? Infinity : now - c.last_seen_at;
      out.controllers[k] = { online: age <= hb, age };
    }
    const sensors = R.sensorList(snap);
    for (const s of sensors) {
      const age = s.received_at == null ? Infinity : now - s.received_at;
      const ck = s.controller && out.controllers[s.controller] ? s.controller : null;
      let status = 'live';
      if (age > fresh) status = 'stale';
      else if (s.quality === 'fault') status = 'fault';
      else if (s.quality === 'warming_up') status = 'warming_up';
      else if (s.quality === 'disconnected') status = 'disconnected';
      out.sensors[s.id] = { status, age, stale: age > fresh, controllerOffline: !!(ck && !out.controllers[ck].online) };
    }
    const g = snap.gsm || null;
    if (g) {
      const gAge = g.last_report_at == null ? Infinity : now - g.last_report_at;
      out.gsm = { reported: gAge <= hb, age: gAge, registered: gAge <= hb && !!g.network_registered };
    } else out.gsm = { reported: false, age: Infinity, registered: false, missing: true };

    out.active = (snap.incidents || []).filter((i) => i.state !== 'cleared');
    const hazards = out.active.filter((i) => i.severity === 'critical' || i.severity === 'warning');
    const crit = hazards.some((i) => i.severity === 'critical');

    const degraded = [];
    const secs = (ms) => (ms === Infinity ? 'ever' : Math.round(ms / 1000) + ' s');
    for (const s of sensors) {
      const e = out.sensors[s.id], name = s.label || s.id;
      if (e.status === 'stale' && e.controllerOffline) continue; // reported once, as its controller
      if (e.status === 'stale') degraded.push(`${name}: no reading for ${secs(e.age)}`);
      if (e.status === 'fault') degraded.push(`${name}: sensor fault reported`);
      if (e.status === 'warming_up') degraded.push(`${name}: warming up — readings not yet valid`);
      if (e.status === 'disconnected') degraded.push(`${name}: disconnected`);
    }
    if (!sensors.length) degraded.push('No sensors are registered.');
    for (const [k, c] of Object.entries(out.controllers)) if (!c.online) degraded.push(`${snap.controllers[k].name}: heartbeat missing`);
    if (out.gsm.missing) degraded.push('SIM800C: not registered with ORION');
    else if (!out.gsm.reported) degraded.push('SIM800C: no status report');
    else if (!out.gsm.registered) degraded.push('SIM800C: not registered on network — SMS/call alerts unavailable');

    // No valid controller link: the gateway is silent, or (if no gateway is flagged) every controller is silent.
    const gk = R.gatewayKey(snap);
    out.gateway = gk;
    const ctrls = Object.values(out.controllers);
    const gatewayDown = gk ? !out.controllers[gk].online : (ctrls.length === 0 || ctrls.every((c) => !c.online));
    if (gatewayDown) {
      out.system = 'OFFLINE';
      const who = gk ? `${snap.controllers[gk].name} gateway heartbeat missing for ${secs(out.controllers[gk].age)}` : 'no controller heartbeat';
      out.reasons.push(`No valid controller connection: ${who}. All values below are last-known and stale.`);
      if (hazards.length) out.lastKnown = crit ? 'EMERGENCY' : 'ATTENTION';
      out.notes = degraded;
      return out;
    }
    if (crit) out.system = 'EMERGENCY';
    else if (hazards.length) out.system = 'ATTENTION';
    else if (degraded.length) out.system = 'DEGRADED';
    else out.system = 'NORMAL';
    for (const h of hazards) out.reasons.push(`${h.severity.toUpperCase()}: ${h.source_label}`);
    if (out.system === 'DEGRADED') out.reasons = degraded.slice();
    else out.notes = degraded;
    return out;
  }

  ORION.state = { evaluate, sensorOrder: (snap) => R.sensorIds(snap) };
})();
