/* Aura — Phase 1 MOCK assistant. Rule-based; reads only the current ORION snapshot.
 * Not an AI model. Phase 4 replaces answer() with backend-mediated model calls + permission-checked data tools. */
'use strict';
(function () {
  const F = ORION.fmt;

  const SUGGEST = ['What is the current temperature?', 'Why did ORION raise an alert?', 'Show the latest water-sensor event', 'Is the ESP32 online?', 'Is the GSM module working?', 'Is my home safe right now?'];

  function freshTag(ev, id) {
    const s = ev.sensors[id];
    if (!s) return 'unavailable';
    return { live: 'fresh', stale: 'STALE', fault: 'FAULT', warming_up: 'warming up', disconnected: 'disconnected', no_data: 'no data' }[s.status] || s.status;
  }

  function answer(q, snap, ev, cfg) {
    const t = q.toLowerCase();
    const res = { facts: [], interp: '', caveats: [], links: [] };
    const now = Date.now();
    const demo = snap.mode === 'demo';
    if (demo) res.caveats.push('All values are DEMO simulation data, not readings from your hardware.');

    // safety-first intents
    if (/(there'?s|there is|i see|real)\s+(a )?(fire|smoke)|help|emergency|burning|evacuat/.test(t)) {
      res.emergency = true; res.caveats = [];
      res.interp = 'If you believe there is a real fire, gas leak or emergency, do not wait for ORION or for me. Leave the building, keep others out and call emergency services: 112 (national emergency) or 101 (fire) in India. ORION is a prototype and not a certified alarm.';
      return res;
    }
    if (/(turn|switch)\s+(on|off)|open (the )?door|unlock|disable|silence|mute|change (the )?threshold|set (the )?threshold|activate|start (the )?(fan|mist)/.test(t)) {
      res.refusal = true; res.caveats = [];
      res.interp = 'I can’t operate devices, change thresholds, unlock doors or disable alarms. Any allowed action has to go through the Devices page, where it needs your explicit confirmation and is logged with its real result.';
      res.links.push({ href: '#devices', label: 'Open Devices & actuators' });
      return res;
    }
    if (snap.status !== 'ok') {
      res.interp = snap.status === 'error' ? 'I can’t reach ORION data right now (backend error), so I can’t tell you any current values. I won’t guess.'
        : snap.status === 'empty' ? 'ORION has not received any telemetry yet, so there is nothing to report.'
          : snap.status === 'unconfigured' ? 'No live data source is connected. Switch to Demo mode or connect a backend (Phase 2).'
            : 'Data is still loading.';
      return res;
    }
    const S = snap.sensors;
    const fact = (label, value, id, at) => res.facts.push({ label, value, at, status: id ? freshTag(ev, id) : null });

    if (/temp|hot|cold|warm|°/.test(t) && !/humid/.test(t)) {
      const d = S['dht22-living'];
      const st = freshTag(ev, 'dht22-living');
      if (d.fields.temperature_c == null) {
        fact('Temperature (DHT22)', 'no valid reading', 'dht22-living', d.recorded_at);
        res.interp = 'The DHT22 is not giving a valid temperature right now' + (d.fault ? ` (${d.fault})` : '') + '. I can’t tell you the current temperature.';
      } else {
        fact('Temperature (DHT22 · ' + (cfg.rooms['dht22-living'] || '') + ')', F.temp(d.fields.temperature_c) + ' ' + F.tempUnit(), 'dht22-living', d.recorded_at);
        fact('Humidity', d.fields.humidity_percent + ' %RH', 'dht22-living', d.recorded_at);
        res.interp = st === 'fresh' ? 'This is the latest reading and it is within the freshness window.' : `This value is ${st}: it is the last-known reading, not a current one.`;
        if (cfg.thresholds.temp_advisory_c == null) res.caveats.push('No temperature advisory threshold is configured, so I can’t say whether this is “too high”.');
      }
      return res;
    }
    if (/humid/.test(t)) {
      const d = S['dht22-living'];
      fact('Humidity (DHT22)', d.fields.humidity_percent == null ? 'no valid reading' : d.fields.humidity_percent + ' %RH', 'dht22-living', d.recorded_at);
      res.interp = d.fields.humidity_percent == null ? 'The DHT22 is not providing a valid humidity reading.' : 'Relative humidity from the DHT22. No advisory threshold is set.';
      return res;
    }
    if (/why|alert|alarm|incident|what happened/.test(t)) {
      const act = snap.incidents.filter((i) => i.state !== 'cleared');
      const inc = act[0] || snap.incidents.slice().sort((a, b) => b.opened_at - a.opened_at)[0];
      if (!inc) { res.interp = 'There are no incidents on record.'; return res; }
      fact('Incident', `${inc.severity.toUpperCase()} · ${inc.source_label}`, null, inc.opened_at);
      fact('State', inc.state === 'cleared' ? 'cleared at ' + F.dt(inc.cleared_at) : 'ACTIVE' + (inc.acknowledged_at ? ' (acknowledged)' : ''), null, inc.last_seen_at);
      fact('Sensor snapshot', `${inc.snapshot.value} ${inc.snapshot.unit || ''} · threshold: ${inc.snapshot.threshold}`, null, inc.opened_at);
      const fw = inc.actions.filter((a) => a.actor === 'firmware');
      if (fw.length) fact('Reported responses', fw.map((a) => a.action).join('; '), null, fw[0].at);
      res.interp = (act.length ? 'ORION raised this because ' : 'The most recent incident was raised because ') +
        { smoke: 'the MQ-2 raw reading crossed the configured threshold.', flame: 'the flame sensor reported a detection.', water: 'the water sensor reported wet.', sensor_stale: 'a sensor stopped reporting.', sensor_fault: 'a sensor reported a fault.', controller: 'a controller heartbeat went missing.', gsm: 'the GSM module lost network registration.' }[inc.type];
      res.caveats.push('Responses listed are what the controller reported doing. They are not proof of physical outcomes (no feedback sensors).');
      if (inc.type === 'smoke') res.caveats.push('MQ-2 values are raw ADC, not ppm, and the module is uncalibrated.');
      res.links.push({ href: '#incidents', label: 'Open Alerts & incidents' });
      return res;
    }
    if (/water|leak|wet/.test(t)) {
      const w = S['water-utility'];
      fact('Water sensor now', `${w.fields.wet ? 'WET' : 'dry'} · raw ${w.fields.raw_adc}`, 'water-utility', w.recorded_at);
      const last = snap.incidents.filter((i) => i.type === 'water').sort((a, b) => b.opened_at - a.opened_at)[0];
      if (last) fact('Latest water event', `${last.state === 'cleared' ? 'cleared' : 'ACTIVE'} · opened ${F.dt(last.opened_at)} · raw ${last.snapshot.value}`, null, last.opened_at);
      res.interp = last ? 'That is the most recent water incident in ORION’s history.' : 'No water incidents are on record.';
      res.caveats.push('ORION cannot estimate leak volume or severity: the sensor is uncalibrated and placement is unvalidated.');
      return res;
    }
    if (/smoke|gas|mq|air/.test(t)) {
      const m = S['mq2-hall'];
      fact('MQ-2 (raw ADC)', m.quality === 'warming_up' ? `warming up (${m.warmup_remaining_s} s left)` : String(m.fields.raw_adc), 'mq2-hall', m.recorded_at);
      fact('Firmware thresholds', `warning ${m.fw_threshold.warning} · critical ${m.fw_threshold.critical} (placeholder)`, null, null);
      fact('Device-reported state', m.state, null, m.recorded_at);
      res.interp = 'The MQ-2 reports a raw ADC count. It indicates relative change, not a gas concentration.';
      res.caveats.push('Raw ADC is not ppm. MQ-2 is not a certified smoke or gas detector.');
      return res;
    }
    if (/flame|fire/.test(t)) {
      const f = S['flame-kitchen'];
      fact('Flame sensor', f.fields.detected ? 'DETECTED' : 'not detected', 'flame-kitchen', f.recorded_at);
      res.interp = 'Digital flame module reading. Its polarity has not been verified on the real hardware.';
      return res;
    }
    if (/esp32|uno|controller|online|board|gateway/.test(t)) {
      for (const [k, c] of Object.entries(snap.controllers)) {
        const o = ev.controllers[k];
        res.facts.push({ label: c.name, value: (o.online ? 'online' : 'NO HEARTBEAT') + ' · last seen ' + F.ago(c.last_seen_at, now) + ' · fw ' + c.firmware_version, at: c.last_seen_at, status: o.online ? 'fresh' : 'STALE' });
      }
      res.interp = 'Online means a heartbeat arrived within the configured interval. Board roles are a demo assumption pending confirmation.';
      return res;
    }
    if (/gsm|sms|call|sim|modem|text/.test(t)) {
      const g = snap.gsm;
      res.facts.push({ label: 'SIM800C', value: ev.gsm.reported ? (g.network_registered ? `registered · CSQ ${g.csq}` : 'NOT registered') : 'no status report', at: g.last_report_at, status: ev.gsm.reported ? 'fresh' : 'STALE' });
      const a = snap.gsmAttempts[0];
      if (a) fact('Last attempt', `${a.type.toUpperCase()} · ${a.status} · ${a.note}`, null, a.updated_at);
      res.interp = 'A controller being online does not mean GSM works. SMS and calls are reported separately, and “sent” means the modem accepted it, not that it was delivered.';
      return res;
    }
    if (/safe|status|ok|okay|normal|everything|overall/.test(t)) {
      res.facts.push({ label: 'ORION system state', value: ev.system, at: snap.at, status: null });
      for (const r of ev.reasons.concat(ev.notes)) res.facts.push({ label: 'Reason', value: r, at: null, status: null });
      res.interp = `ORION currently reports ${ev.system}. I can only tell you what the sensors report; I can’t certify that your home is safe.`;
      res.caveats.push('ORION is a prototype, not a certified fire alarm or gas detector.');
      return res;
    }
    res.interp = 'In this Phase 1 mock I can answer about temperature, humidity, smoke (MQ-2), flame, water, controllers, GSM, incidents and overall status.';
    return res;
  }

  ORION.aura = { answer, SUGGEST };
})();
