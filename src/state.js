/* ORION health evaluation: freshness, sensor status and overall system state.
 * Precedence: OFFLINE (no valid controller link) > EMERGENCY > ATTENTION > DEGRADED > NORMAL.
 * A degraded condition never hides an emergency; stale/missing data never shows NORMAL. */
'use strict';
(function () {
  const SENSOR_ORDER = ['mq2-hall', 'flame-kitchen', 'water-utility', 'dht22-living'];

  function evaluate(snap, cfg, now) {
    now = now || Date.now();
    const out = { status: snap.status, system: null, reasons: [], notes: [], sensors: {}, controllers: {}, gsm: null, active: [], lastKnown: null, now };
    if (snap.status === 'loading') { out.system = 'LOADING'; return out; }
    if (snap.status === 'error') { out.system = 'OFFLINE'; out.reasons.push('Backend error: ' + snap.error.message); out.backendError = true; return out; }
    if (snap.status === 'empty') { out.system = 'OFFLINE'; out.reasons.push('No telemetry has been received yet.'); out.noData = true; return out; }
    if (snap.status === 'unconfigured') { out.system = 'OFFLINE'; out.reasons.push(snap.message); out.unconfigured = true; return out; }

    const fresh = cfg.freshness.sensor_s * 1000, hb = cfg.freshness.heartbeat_s * 1000;
    for (const id of SENSOR_ORDER) {
      const s = snap.sensors[id];
      if (!s) { out.sensors[id] = { status: 'no_data', age: null }; continue; }
      const age = now - s.received_at;
      let status = 'live';
      if (age > fresh) status = 'stale';
      else if (s.quality === 'fault') status = 'fault';
      else if (s.quality === 'warming_up') status = 'warming_up';
      else if (s.quality === 'disconnected') status = 'disconnected';
      out.sensors[id] = { status, age, stale: age > fresh };
    }
    for (const [k, c] of Object.entries(snap.controllers)) {
      const age = now - c.last_seen_at;
      out.controllers[k] = { online: age <= hb, age };
    }
    const gAge = now - snap.gsm.last_report_at;
    out.gsm = { reported: gAge <= hb, age: gAge, registered: gAge <= hb && snap.gsm.network_registered };

    out.active = snap.incidents.filter((i) => i.state !== 'cleared');
    const hazards = out.active.filter((i) => i.severity === 'critical' || i.severity === 'warning');
    const crit = hazards.some((i) => i.severity === 'critical');

    const degraded = [];
    for (const id of SENSOR_ORDER) {
      const st = out.sensors[id].status;
      const name = snap.sensors[id] ? snap.sensors[id].label : id;
      if (st === 'stale') degraded.push(`${name}: no reading for ${Math.round(out.sensors[id].age / 1000)} s`);
      if (st === 'fault') degraded.push(`${name}: sensor fault reported`);
      if (st === 'warming_up') degraded.push(`${name}: warming up — readings not yet valid`);
      if (st === 'disconnected') degraded.push(`${name}: disconnected`);
    }
    for (const [k, c] of Object.entries(out.controllers)) if (!c.online) degraded.push(`${snap.controllers[k].name}: heartbeat missing`);
    if (!out.gsm.reported) degraded.push('SIM800C: no status report');
    else if (!out.gsm.registered) degraded.push('SIM800C: not registered on network — SMS/call alerts unavailable');

    const gatewayDown = !out.controllers.esp32.online; // demo assumption: ESP32 is the gateway
    if (gatewayDown) {
      out.system = 'OFFLINE';
      out.reasons.push('No valid controller connection: ESP32 gateway heartbeat missing for ' + Math.round(out.controllers.esp32.age / 1000) + ' s. All values below are last-known and stale.');
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

  ORION.state = { evaluate, SENSOR_ORDER };
})();
