/* ORION telemetry sources.
 *
 * ADAPTER BOUNDARY: the UI talks only to an object with this interface.
 *   kind            'demo' | 'live'
 *   start(onUpdate) begin delivering updates; onUpdate() is called after each change
 *   stop()
 *   snapshot()      -> { status: 'ok'|'loading'|'error'|'empty'|'unconfigured', ...data }
 *   history(series, fromMs, toMs) -> [{ t: recorded_ms, r: received_ms, v: number|null, q: quality }]
 *   acknowledge(incidentId, actor) -> { ok, error? }
 *   command({ actuator, action, actor }) -> command record (lifecycle updated over time)
 *
 * A Phase 2 LiveSource implements the same interface on top of the ORION backend
 * (REST: /api/v1/overview, /telemetry, /incidents, /commands … and SSE/WebSocket for realtime).
 */
'use strict';
(function () {
  const U = ORION.util;
  const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3;

  const SCENARIOS = [
    { id: 'normal', label: 'Normal', group: 'Baseline', hint: 'All sensors valid, controllers online.' },
    { id: 'smoke_warning', label: 'Smoke — warning', group: 'Hazards', hint: 'MQ-2 rises above the warning threshold.' },
    { id: 'smoke_critical', label: 'Smoke — critical', group: 'Hazards', hint: 'MQ-2 rises above the critical threshold.' },
    { id: 'flame', label: 'Flame detected', group: 'Hazards', hint: 'Flame sensor trips; GSM alert attempted.' },
    { id: 'water', label: 'Water leak', group: 'Hazards', hint: 'Water sensor reads wet.' },
    { id: 'mq2_warmup', label: 'MQ-2 warming up', group: 'Sensor health', hint: 'MQ-2 heater warm-up after power-on.' },
    { id: 'dht_fault', label: 'DHT22 read failure', group: 'Sensor health', hint: 'DHT22 reports checksum/read errors.' },
    { id: 'dht_stale', label: 'DHT22 stops reporting', group: 'Sensor health', hint: 'No DHT22 readings; goes stale.' },
    { id: 'uno_offline', label: 'UNO heartbeat lost', group: 'Connectivity', hint: 'Arduino UNO stops sending heartbeats.' },
    { id: 'gsm_outage', label: 'GSM not registered', group: 'Connectivity', hint: 'SIM800C loses network registration.' },
    { id: 'gateway_offline', label: 'ESP32 gateway offline', group: 'Connectivity', hint: 'No telemetry reaches the backend.' },
    { id: 'backend_error', label: 'Backend error', group: 'App states', hint: 'API returns errors.' },
    { id: 'loading', label: 'Loading', group: 'App states', hint: 'First load in progress.' },
    { id: 'no_data', label: 'No data yet', group: 'App states', hint: 'Fresh install, nothing received.' },
  ];

  /* Which sensor produces each simulated metric (history arrays are kept per metric). */
  const SIM_SENSOR = { mq2: 'mq2-hall', flame: 'flame-kitchen', water: 'water-utility', temp: 'dht22-living', hum: 'dht22-living' };

  /* Kerala-like diurnal pattern, peak mid-afternoon IST (≈08:30 UTC). */
  function diurnal(ms) {
    const hUTC = (ms % DAY) / HOUR;
    return Math.sin((2 * Math.PI * (hUTC - 2.5)) / 24); // +1 ≈ 08:30 UTC = 14:00 IST
  }

  class DemoSource {
    constructor(seed) {
      this.kind = 'demo';
      this.label = 'Simulation';
      this.seed = seed || 20261115;
      this.rand = U.mulberry32(this.seed + 7);
      this.scenario = 'normal';
      this.scenarioSince = Date.now();
      this.timer = null;
      this.listeners = [];
      this.t0 = Date.now();
      this.tickN = 0;
      this.seq = { esp32: 1800, uno: 940 };
      this.fwThresholds = { mq2_warning: 350, mq2_critical: 500, water_wet: 300 };
      this.events = []; this.logs = []; this.incidents = []; this.commands = []; this.gsmAttempts = [];
      this.seqGaps = 0;
      this._buildHistory();
      this._initLive();
      this._log('info', 'Simulation started (seed ' + this.seed + '). No hardware is connected — every value is simulated.');
    }

    /* ---------- history (deterministic) ---------- */
    _buildHistory() {
      const r = U.mulberry32(this.seed);
      const now = this.t0;
      const start = now - 7 * DAY;
      this.hist = { mq2: [], temp: [], hum: [], water: [], flame: [] };
      // planned past episodes (relative to load time)
      const ep = {
        smoke: [now - 26 * HOUR, now - 26 * HOUR + 7 * MIN],
        water: [now - 53 * HOUR, now - 53 * HOUR + 18 * MIN],
        flame: [now - 4 * DAY - 2 * HOUR, now - 4 * DAY - 2 * HOUR + 40e3],
        dhtGap: [now - 3 * HOUR - 20 * MIN, now - 3 * HOUR],
        gatewayGap: [now - 5 * DAY - 6 * HOUR, now - 5 * DAY - 5 * HOUR - 25 * MIN],
      };
      this.episodes = ep;
      let tWalk = 0, hWalk = 0, mWalk = 0;
      let t = start;
      while (t < now - 4e3) {
        const step = t < now - DAY ? 5 * MIN : MIN;
        tWalk = tWalk * 0.92 + (r() - 0.5) * 0.25;
        hWalk = hWalk * 0.92 + (r() - 0.5) * 1.2;
        mWalk = mWalk * 0.85 + (r() - 0.5) * 9;
        const inGw = t >= ep.gatewayGap[0] && t < ep.gatewayGap[1];
        if (!inGw) {
          const recv = t + 250 + Math.floor(r() * 900);
          const d = diurnal(t);
          // MQ-2
          let mq = 172 + mWalk + 6 * Math.sin(t / (37 * MIN));
          if (t >= ep.smoke[0] && t < ep.smoke[1]) {
            const p = (t - ep.smoke[0]) / (ep.smoke[1] - ep.smoke[0]);
            mq = 180 + 258 * Math.sin(Math.PI * Math.min(1, p * 1.15));
          }
          if (t >= ep.flame[0] - 2 * MIN && t < ep.flame[1] + 3 * MIN) mq = Math.max(mq, 290 + r() * 30);
          this.hist.mq2.push({ t, r: recv, v: Math.round(mq), q: 'valid', i: step });
          // DHT22
          if (!(t >= ep.dhtGap[0] && t < ep.dhtGap[1])) {
            this.hist.temp.push({ t, r: recv, v: +(28.4 + 3.1 * d + tWalk).toFixed(1), q: 'valid', i: step });
            this.hist.hum.push({ t, r: recv, v: +(73 - 9 * d + hWalk).toFixed(1), q: 'valid', i: step });
          }
          // water
          let w = 34 + Math.round((r() - 0.5) * 10);
          if (t >= ep.water[0] && t < ep.water[1]) w = 600 + Math.round(r() * 60);
          this.hist.water.push({ t, r: recv, v: w, q: 'valid', i: step });
          // flame
          const fl = t >= ep.flame[0] && t < ep.flame[1] + MIN ? 1 : 0;
          this.hist.flame.push({ t, r: recv, v: fl, q: 'valid', i: step });
        }
        t += step;
      }
      this._seedPastIncidents(ep);
    }

    _seedPastIncidents(ep) {
      const owner = 'Demo Owner';
      const mk = (o) => Object.assign({ acknowledged_by: null, acknowledged_at: null, events: [], actions: [] }, o);
      // Flame test 4 days ago
      const f0 = ep.flame[0];
      const flame = mk({
        id: 'inc-demo-0001', type: 'flame', source_id: 'flame-kitchen', source_label: 'Flame sensor · Kitchen',
        severity: 'critical', state: 'cleared', opened_at: f0, last_seen_at: ep.flame[1], cleared_at: ep.flame[1] + 45e3,
        acknowledged_by: owner, acknowledged_at: f0 + 70e3,
        snapshot: { value: 'detected', unit: 'digital', threshold: 'digital trip (polarity unverified)', config_version: 'cfg-demo-2' },
        actions: [
          { at: f0 + 300, actor: 'firmware', action: 'Red LED ON, green LED OFF', outcome: 'commanded' },
          { at: f0 + 300, actor: 'firmware', action: 'White + warm-white model lights OFF', outcome: 'commanded' },
          { at: f0 + 900, actor: 'firmware', action: 'SMS to Owner (demo)', outcome: 'sent — modem accepted (+CMGS); delivery not confirmed' },
          { at: f0 + 9000, actor: 'firmware', action: 'Voice call to Owner (demo)', outcome: 'timeout — no answer within 30 s' },
        ],
      });
      flame.events = [
        { at: f0, text: 'Flame detected (device-reported state: critical)' },
        { at: f0 + 70e3, text: 'Acknowledged by Demo Owner — hazard not cleared by acknowledgement' },
        { at: ep.flame[1], text: 'Flame no longer detected' },
        { at: ep.flame[1] + 45e3, text: 'Cleared: sensor normal for the clear-hold period' },
      ];
      // Water 53 h ago
      const w0 = ep.water[0];
      const water = mk({
        id: 'inc-demo-0002', type: 'water', source_id: 'water-utility', source_label: 'Water sensor · Utility area',
        severity: 'warning', state: 'cleared', opened_at: w0, last_seen_at: ep.water[1], cleared_at: ep.water[1] + 30e3,
        acknowledged_by: owner, acknowledged_at: w0 + 4 * MIN,
        snapshot: { value: 628, unit: 'adc_raw', threshold: 'wet ≥ 300 (placeholder)', config_version: 'cfg-demo-2' },
        actions: [{ at: w0 + 500, actor: 'backend', action: 'In-app notification', outcome: 'shown' },
          { at: w0 + 500, actor: 'backend', action: 'SMS', outcome: 'not_configured — water SMS policy pending' }],
      });
      water.events = [
        { at: w0, text: 'Water sensor reads wet (raw 628)' },
        { at: w0 + 4 * MIN, text: 'Acknowledged by Demo Owner' },
        { at: ep.water[1], text: 'Sensor reads dry' },
        { at: ep.water[1] + 30e3, text: 'Cleared: sensor normal for the clear-hold period' },
      ];
      // Smoke 26 h ago
      const s0 = ep.smoke[0];
      const smoke = mk({
        id: 'inc-demo-0003', type: 'smoke', source_id: 'mq2-hall', source_label: 'MQ-2 · Hall',
        severity: 'warning', state: 'cleared', opened_at: s0 + 40e3, last_seen_at: ep.smoke[1] - 50e3, cleared_at: ep.smoke[1] + 20e3,
        snapshot: { value: 438, unit: 'adc_raw (peak)', threshold: 'warning 350 / critical 500 (placeholder)', config_version: 'cfg-demo-3' },
        actions: [
          { at: s0 + 40.3e3, actor: 'firmware', action: 'Red LED ON, green LED OFF', outcome: 'commanded' },
          { at: s0 + 40.3e3, actor: 'firmware', action: 'Buzzer ON', outcome: 'commanded' },
          { at: s0 + 40.3e3, actor: 'firmware', action: 'Exhaust fan ON (relay CH1, demo mapping)', outcome: 'commanded — no feedback sensor' },
          { at: s0 + 40.4e3, actor: 'firmware', action: 'MG995 target 180° for 5 s', outcome: 'commanded — position not sensed' },
          { at: ep.smoke[1] - 50e3, actor: 'firmware', action: 'Buzzer OFF; fan cooldown 60 s started', outcome: 'commanded' },
          { at: ep.smoke[1] + 10e3, actor: 'firmware', action: 'Exhaust fan OFF (cooldown ended)', outcome: 'commanded' },
        ],
      });
      smoke.events = [
        { at: s0 + 40e3, text: 'MQ-2 above warning threshold (raw 352)' },
        { at: ep.smoke[1] - 50e3, text: 'MQ-2 below warning threshold' },
        { at: ep.smoke[1] + 20e3, text: 'Cleared: sensor normal for the clear-hold period' },
      ];
      // DHT gap 3 h ago
      const d0 = ep.dhtGap[0];
      const dht = mk({
        id: 'inc-demo-0004', type: 'sensor_fault', source_id: 'dht22-living', source_label: 'DHT22 · Living room',
        severity: 'degraded', state: 'cleared', opened_at: d0 + 30e3, last_seen_at: ep.dhtGap[1], cleared_at: ep.dhtGap[1] + 2e3,
        snapshot: { value: 'no readings', unit: '', threshold: 'freshness 30 s', config_version: 'cfg-demo-3' },
        actions: [],
      });
      dht.events = [{ at: d0 + 30e3, text: 'DHT22 readings stale (no data for 30 s)' }, { at: ep.dhtGap[1] + 2e3, text: 'DHT22 readings resumed' }];
      // Gateway gap 5 days ago
      const g0 = ep.gatewayGap[0];
      const gw = mk({
        id: 'inc-demo-0005', type: 'controller', source_id: 'orion-esp32-01', source_label: 'ESP32 gateway',
        severity: 'degraded', state: 'cleared', opened_at: g0 + 20e3, last_seen_at: ep.gatewayGap[1], cleared_at: ep.gatewayGap[1] + 3e3,
        snapshot: { value: 'heartbeat missing', unit: '', threshold: 'heartbeat 20 s', config_version: 'cfg-demo-2' },
        actions: [],
      });
      gw.events = [{ at: g0 + 20e3, text: 'ESP32 heartbeat missing — all telemetry stale' }, { at: ep.gatewayGap[1] + 3e3, text: 'ESP32 reconnected (boot reason: brownout)' }];

      this.incidents = [smoke, dht, water, gw, flame];
      for (const inc of this.incidents) {
        for (const e of inc.events) this.events.push({ id: U.uid('ev'), at: e.at, severity: inc.severity, source: inc.source_label, text: e.text, incident_id: inc.id });
      }
      this.events.push({ id: U.uid('ev'), at: ep.gatewayGap[1] + 3e3, severity: 'info', source: 'ESP32 gateway', text: 'Controller reconnected', incident_id: null });
      this.gsmAttempts.push(
        { id: 'gsm-demo-0001', type: 'sms', destination: 'Owner (demo) · +91 ••••• •••42', status: 'sent', note: 'Modem accepted (+CMGS: 41). Delivery not confirmed.', error_code: null, created_at: f0 + 400, updated_at: f0 + 900, incident_id: 'inc-demo-0001' },
        { id: 'gsm-demo-0002', type: 'call', destination: 'Owner (demo) · +91 ••••• •••42', status: 'timeout', note: 'Dialled; no answer within 30 s.', error_code: 'NO ANSWER', created_at: f0 + 1200, updated_at: f0 + 31200, incident_id: 'inc-demo-0001' },
      );
      this.events.sort((a, b) => b.at - a.at);
    }

    /* ---------- live simulation ---------- */
    _initLive() {
      const now = Date.now();
      const lastTemp = this.hist.temp[this.hist.temp.length - 1];
      const lastHum = this.hist.hum[this.hist.hum.length - 1];
      this.cur = { mq2: 175, temp: lastTemp ? lastTemp.v : 29, hum: lastHum ? lastHum.v : 72, water: 34, flame: 0 };
      this.sensors = {
        'mq2-hall': { id: 'mq2-hall', type: 'mq2', label: 'MQ-2 smoke / gas', controller: 'uno', simulated: true, unit: 'adc_raw', fields: { raw_adc: 175 }, state: 'normal', quality: 'valid', recorded_at: now, received_at: now, sequence: 0, calibration: 'uncalibrated_raw' },
        'flame-kitchen': { id: 'flame-kitchen', type: 'flame', label: 'Flame sensor', controller: 'uno', simulated: true, unit: 'digital', fields: { detected: false, digital_value: 1 }, state: 'normal', quality: 'valid', recorded_at: now, received_at: now, sequence: 0, polarity: 'active LOW (demo assumption)' },
        'water-utility': { id: 'water-utility', type: 'water', label: 'Water sensor', controller: 'uno', simulated: true, unit: 'adc_raw', fields: { raw_adc: 34, wet: false }, state: 'normal', quality: 'valid', recorded_at: now, received_at: now, sequence: 0 },
        'dht22-living': { id: 'dht22-living', type: 'dht22', label: 'DHT22 temperature / humidity', controller: 'uno', simulated: true, unit: 'c_rh', fields: { temperature_c: this.cur.temp, humidity_percent: this.cur.hum }, state: 'normal', quality: 'valid', recorded_at: now, received_at: now, sequence: 0 },
      };
      this.controllers = {
        uno: { id: 'orion-uno-01', name: 'Arduino UNO', role: 'Safety controller — reads sensors, drives outputs', is_gateway: false, simulated: true, online: true, last_seen_at: now, firmware_version: '0.1.0-sim', boot_reason: 'power_on', link: 'UART to ESP32 via level shifter', logic: '5 V' },
        esp32: { id: 'orion-esp32-01', name: 'ESP32', role: 'Gateway — Wi-Fi/MQTT to server, SIM800C', is_gateway: true, simulated: true, online: true, last_seen_at: now, firmware_version: '0.1.0-sim', boot_reason: 'power_on', wifi_rssi_dbm: -58, uptime_s: 5 * 3600 + 12 * 60, logic: '3.3 V (not 5 V tolerant)' },
      };
      this.gsm = { id: 'orion-sim800c-01', module: 'SIM800C', simulated: true, network_registered: true, operator: 'Simulated 2G network', csq: 17, last_report_at: now, power: 'external supply (unconfirmed)' };
      this.fw = { smoke: false, smokeLevel: 'normal', flame: false, water: false, fanCooldownUntil: null, doorUntil: null, manualFan: null, buzzerTestUntil: null, normalSince: {} };
      this.act = {
        fan: { id: 'fan', name: '12 V exhaust fan', commanded: 'off', by: 'firmware', last_changed_at: now - 26 * HOUR, feedback: false },
        relay: { id: 'relay', name: '5 V relay module', channels: [{ ch: 1, load: 'Exhaust fan (planned mapping, unverified)', commanded: 'de-energised' }], active_level: 'unverified', feedback: false },
        mist: { id: 'mist', name: 'Mist maker', installed: false, commanded: 'off', interlock: 'undefined', remote: 'disabled', feedback: false },
        mg995: { id: 'mg995', name: 'MG995 servo — model door', target_angle: 0, duration_s: null, command_time: now - 26 * HOUR, reported_position: null, feedback: false },
        sg90: { id: 'sg90', name: 'SG90 servo — purpose pending', target_angle: null, command_time: null, reported_position: null, feedback: false },
        buzzer: { id: 'buzzer', name: 'Buzzer', commanded: 'off', pattern: null, incident_id: null, feedback: false },
        leds: { id: 'leds', name: 'Indicator LEDs', items: [
          { id: 'led-green', name: 'Green — status normal', color: 'green', commanded: 'on' },
          { id: 'led-red', name: 'Red — warning', color: 'red', commanded: 'off' },
          { id: 'led-white', name: 'White — model lighting', color: 'white', commanded: 'on' },
          { id: 'led-warm', name: 'Warm-white — model lighting', color: 'warm', commanded: 'on' },
        ], feedback: false },
      };
      this.live = { mq2: [], temp: [], hum: [], water: [], flame: [] };
      this.warmupUntil = null;
      this.gsmOutage = false;
    }

    setScenario(id) {
      if (!SCENARIOS.find((s) => s.id === id)) return;
      const prev = this.scenario;
      this.scenario = id;
      this.scenarioSince = Date.now();
      if (id === 'mq2_warmup') this.warmupUntil = Date.now() + 60e3;
      this._log('info', `Demo scenario changed: ${prev} → ${id}`);
      this._event('info', 'Demo controls', `Scenario set to “${SCENARIOS.find((s) => s.id === id).label}”`);
      this._tick();
    }

    start(cb) {
      if (cb) this.listeners.push(cb);
      if (!this.timer) {
        this._tick();
        this.timer = setInterval(() => this._tick(), 2000);
      }
    }
    stop() { clearInterval(this.timer); this.timer = null; }
    _emit() { for (const l of this.listeners) { try { l(); } catch (e) { console.error(e); } } }

    _log(level, msg) { this.logs.unshift({ at: Date.now(), level, msg }); if (this.logs.length > 200) this.logs.pop(); }
    _event(sev, source, text, incident_id) {
      this.events.unshift({ id: U.uid('ev'), at: Date.now(), severity: sev, source, text, incident_id: incident_id || null });
      if (this.events.length > 400) this.events.pop();
    }

    _tick() {
      const now = Date.now();
      const r = this.rand;
      const sc = this.scenario;
      this.tickN++;
      const gatewayUp = sc !== 'gateway_offline';
      const unoUp = sc !== 'uno_offline' && gatewayUp;

      // physical targets (what the sensors would "see")
      let mq2T = 172, flame = 0, waterT = 34;
      if (sc === 'smoke_warning') mq2T = 428;
      if (sc === 'smoke_critical') mq2T = 588;
      if (sc === 'flame') { flame = 1; mq2T = 315; }
      if (sc === 'water') waterT = 640;
      this.cur.mq2 += (mq2T - this.cur.mq2) * 0.35 + (r() - 0.5) * 10;
      this.cur.water += (waterT - this.cur.water) * 0.5 + (r() - 0.5) * 8;
      this.cur.flame = flame;
      const d = diurnal(now);
      this.cur.temp += (28.4 + 3.1 * d - this.cur.temp) * 0.05 + (r() - 0.5) * 0.08;
      this.cur.hum += (73 - 9 * d - this.cur.hum) * 0.05 + (r() - 0.5) * 0.4;

      /* --- simulated local firmware (runs even when the gateway is offline) --- */
      this._firmware(now);

      /* --- telemetry reaching the backend ---
         Sensors are read by the UNO and relayed by the ESP32, so both links must be up for fresh readings. */
      if (gatewayUp) {
        // occasional dropped packet → sequence gap (deterministic)
        if (this.tickN % 157 === 0) { this.seq.esp32++; this.seqGaps++; this._log('warn', 'Sequence gap detected on orion-esp32-01 (1 message missing)'); }
        const recv = now;
        const rec = now - 300 - Math.floor(r() * 500);
        const s = this.sensors;
        const fw = this.fwThresholds;
        if (unoUp) {
          // MQ-2
          const mqv = Math.round(U.clamp(this.cur.mq2, 0, 1023));
          const warm = this.warmupUntil && now < this.warmupUntil;
          if (this.warmupUntil && now >= this.warmupUntil) {
            this.warmupUntil = null;
            if (sc === 'mq2_warmup') { this.scenario = 'normal'; this._event('info', 'MQ-2 · Hall', 'MQ-2 warm-up complete'); }
          }
          Object.assign(s['mq2-hall'], {
            fields: { raw_adc: mqv }, quality: warm ? 'warming_up' : 'valid',
            warmup_remaining_s: warm ? Math.ceil((this.warmupUntil - now) / 1000) : 0,
            state: warm ? 'unknown' : mqv >= fw.mq2_critical ? 'critical' : mqv >= fw.mq2_warning ? 'warning' : 'normal',
            recorded_at: rec, received_at: recv, sequence: ++this.seq.esp32,
            fw_threshold: { warning: fw.mq2_warning, critical: fw.mq2_critical },
          });
          this._push('mq2', rec, recv, warm ? null : mqv, warm ? 'warming_up' : 'valid');
          // flame (active LOW demo assumption: digital 0 = detected)
          Object.assign(s['flame-kitchen'], {
            fields: { detected: !!flame, digital_value: flame ? 0 : 1 }, quality: 'valid',
            state: flame ? 'critical' : 'normal', recorded_at: rec, received_at: recv, sequence: ++this.seq.esp32,
          });
          this._push('flame', rec, recv, flame, 'valid');
          // water
          const wv = Math.round(U.clamp(this.cur.water, 0, 1023));
          const wet = wv >= fw.water_wet;
          Object.assign(s['water-utility'], {
            fields: { raw_adc: wv, wet }, quality: 'valid', state: wet ? 'warning' : 'normal',
            recorded_at: rec, received_at: recv, sequence: ++this.seq.esp32, fw_threshold: { wet: fw.water_wet },
          });
          this._push('water', rec, recv, wv, 'valid');
          // DHT22
          if (sc === 'dht_fault') {
            Object.assign(s['dht22-living'], { fields: { temperature_c: null, humidity_percent: null }, quality: 'fault', fault: 'read failure (checksum / timeout)', state: 'unknown', recorded_at: rec, received_at: recv, sequence: ++this.seq.esp32 });
            if (this.tickN % 3 === 0) this._log('warn', 'dht22-living: read failure reported by controller');
          } else if (sc !== 'dht_stale') {
            const tv = +this.cur.temp.toFixed(1), hv = +U.clamp(this.cur.hum, 0, 100).toFixed(1);
            Object.assign(s['dht22-living'], { fields: { temperature_c: tv, humidity_percent: hv }, quality: 'valid', fault: null, state: 'normal', recorded_at: rec, received_at: recv, sequence: ++this.seq.esp32 });
            this._push('temp', rec, recv, tv, 'valid');
            this._push('hum', rec, recv, hv, 'valid');
          }
        } // unoUp
        // controllers
        this.controllers.esp32.online = true;
        this.controllers.esp32.last_seen_at = recv;
        this.controllers.esp32.uptime_s += 2;
        this.controllers.esp32.wifi_rssi_dbm = -56 - Math.round(r() * 6);
        if (unoUp) { this.controllers.uno.last_seen_at = recv; this.seq.uno++; }
        // GSM status report
        this.gsmOutage = sc === 'gsm_outage';
        this.gsm.network_registered = !this.gsmOutage;
        this.gsm.csq = this.gsmOutage ? 99 : 15 + Math.round(r() * 4);
        this.gsm.operator = this.gsmOutage ? null : 'Simulated 2G network';
        this.gsm.last_report_at = recv;
      }
      this._progressGsm(now);
      this._progressCommands(now, gatewayUp && unoUp);
      this._incidentEngine(now);
      this._emit();
    }

    _push(series, t, r, v, q) {
      const a = this.live[series];
      a.push({ t, r, v, q, i: 2000 });
      if (a.length > 20000) a.shift();
    }

    _firmware(now) {
      const fw = this.fw, A = this.act, th = this.fwThresholds;
      const warm = this.warmupUntil && now < this.warmupUntil;
      const mq = this.cur.mq2;
      const smokeOn = !warm && (fw.smoke ? mq >= th.mq2_warning - 25 : mq >= th.mq2_warning); // hysteresis
      const led = (id, v) => { const l = A.leds.items.find((x) => x.id === id); l.commanded = v; };

      if (smokeOn && !fw.smoke) {
        fw.smoke = true;
        A.buzzer.commanded = 'on'; A.buzzer.pattern = 'continuous'; A.buzzer.last_changed_at = now;
        A.fan.commanded = 'on'; A.fan.by = 'firmware (smoke rule)'; A.fan.last_changed_at = now; fw.fanCooldownUntil = null;
        A.mg995.target_angle = 180; A.mg995.duration_s = 5; A.mg995.command_time = now; fw.doorUntil = now + 5000;
        this._fwAction('smoke', 'Red LED ON, green LED OFF; buzzer ON; exhaust fan ON; MG995 target 180° for 5 s');
      } else if (!smokeOn && fw.smoke) {
        fw.smoke = false;
        A.buzzer.commanded = 'off'; A.buzzer.pattern = null; A.buzzer.last_changed_at = now;
        fw.fanCooldownUntil = now + 60e3;
        this._fwAction('smoke', 'Smoke ended: buzzer OFF; fan cooldown 60 s started');
      }
      if (fw.doorUntil && now >= fw.doorUntil) {
        fw.doorUntil = null; A.mg995.target_angle = 0; A.mg995.duration_s = null; A.mg995.command_time = now;
        this._fwAction('smoke', 'MG995 target returned to 0° after 5 s (post-5 s behaviour pending confirmation)');
      }
      if (fw.fanCooldownUntil && now >= fw.fanCooldownUntil) {
        fw.fanCooldownUntil = null;
        if (fw.manualFan !== 'on') { A.fan.commanded = 'off'; A.fan.by = 'firmware (cooldown ended)'; A.fan.last_changed_at = now; }
        this._fwAction('smoke', 'Exhaust fan OFF (60 s cooldown ended)');
      }
      // flame
      const fl = !!this.cur.flame;
      if (fl && !fw.flame) {
        fw.flame = true;
        led('led-white', 'off'); led('led-warm', 'off');
        this._fwAction('flame', 'Red LED ON, green LED OFF; white + warm-white lights OFF; GSM SMS and call requested');
        this._gsmRequest('sms', 'flame'); this._gsmRequest('call', 'flame');
      } else if (!fl && fw.flame) {
        fw.flame = false;
        led('led-white', 'on'); led('led-warm', 'on');
        this._fwAction('flame', 'Flame ended: model lights restored (restore rule pending confirmation)');
      }
      fw.water = this.cur.water >= th.water_wet;
      // buzzer test
      if (fw.buzzerTestUntil && now >= fw.buzzerTestUntil) {
        fw.buzzerTestUntil = null;
        if (!fw.smoke) { A.buzzer.commanded = 'off'; A.buzzer.pattern = null; }
      }
      // manual fan
      if (fw.manualFan === 'on' && !fw.smoke && !fw.fanCooldownUntil) { A.fan.commanded = 'on'; }
      // indicators
      const hazard = fw.smoke || fw.flame;
      led('led-red', hazard ? 'on' : 'off');
      led('led-green', hazard ? 'off' : 'on');
      A.relay.channels[0].commanded = A.fan.commanded === 'on' ? 'energised' : 'de-energised';
      A.fan.cooldown_remaining_s = fw.fanCooldownUntil ? Math.ceil((fw.fanCooldownUntil - now) / 1000) : 0;
    }

    _fwAction(type, text) {
      this._pendingActions = this._pendingActions || [];
      this._pendingActions.push({ type, at: Date.now(), text });
    }

    _gsmRequest(kind, type) {
      const now = Date.now();
      const a = { id: U.uid('gsm'), type: kind, destination: 'Owner (demo) · +91 ••••• •••42', status: 'queued', note: 'Queued on controller', error_code: null, created_at: now, updated_at: now, incident_type: type, incident_id: null, _t: now };
      this.gsmAttempts.unshift(a);
      this._log('info', `GSM ${kind.toUpperCase()} queued (${type})`);
    }

    _progressGsm(now) {
      for (const a of this.gsmAttempts) {
        if (!a._t) continue;
        const age = now - a._t;
        const prev = a.status;
        if (this.gsmOutage && (a.status === 'queued' || a.status === 'sending')) {
          a.status = 'failed'; a.error_code = 'NOT REGISTERED'; a.note = 'Modem not registered on network (AT+CREG?).'; delete a._t;
        } else if (a.type === 'sms') {
          if (a.status === 'queued' && age > 2000) { a.status = 'sending'; a.note = 'AT+CMGS issued'; }
          else if (a.status === 'sending' && age > 7000) { a.status = 'sent'; a.note = 'Modem accepted (+CMGS). Delivery not confirmed.'; delete a._t; }
        } else {
          if (a.status === 'queued' && age > 4000) { a.status = 'sending'; a.note = 'Dialling (ATD)…'; }
          else if (a.status === 'sending' && age > 34000) { a.status = 'timeout'; a.error_code = 'NO ANSWER'; a.note = 'Dialled; no answer within 30 s.'; delete a._t; }
        }
        if (a.status !== prev) { a.updated_at = now; this._log(a.status === 'failed' || a.status === 'timeout' ? 'warn' : 'info', `GSM ${a.type.toUpperCase()} ${a.id}: ${prev} → ${a.status}`); }
      }
    }

    /* ---------- backend-side incident engine (demo) ---------- */
    _incidentEngine(now) {
      const fresh = (ORION.app ? ORION.app.config.freshness.sensor_s : 30) * 1000;
      const hb = (ORION.app ? ORION.app.config.freshness.heartbeat_s : 20) * 1000;
      const CLEAR_HOLD = 10e3;
      const sensors = this.sensors;
      const BASE = { mq2: 'MQ-2', flame: 'Flame sensor', water: 'Water sensor', dht22: 'DHT22' };
      const labelOf = (id) => {
        const s = sensors[id];
        const room = s && ORION.app ? ORION.registry.roomOf(ORION.app.config, s) : '';
        const base = (s && BASE[s.type]) || id;
        return room ? `${base} · ${room}` : base;
      };
      const conds = [];
      const stale = (s) => now - s.received_at > fresh;
      // hazards (device-reported states are authoritative)
      const mq = sensors['mq2-hall'];
      if (!stale(mq) && (mq.state === 'warning' || mq.state === 'critical')) conds.push({ key: 'mq2', type: 'smoke', source_id: mq.id, severity: mq.state, value: mq.fields.raw_adc, unit: 'adc_raw', threshold: `warning ${mq.fw_threshold.warning} / critical ${mq.fw_threshold.critical} (firmware, placeholder)` });
      const fl = sensors['flame-kitchen'];
      if (!stale(fl) && fl.state === 'critical') conds.push({ key: 'flame', type: 'flame', source_id: fl.id, severity: 'critical', value: 'detected', unit: 'digital', threshold: 'digital trip (polarity unverified)' });
      const wa = sensors['water-utility'];
      if (!stale(wa) && wa.state === 'warning') conds.push({ key: 'water', type: 'water', source_id: wa.id, severity: 'warning', value: wa.fields.raw_adc, unit: 'adc_raw', threshold: `wet ≥ ${wa.fw_threshold ? wa.fw_threshold.wet : 300} (placeholder)` });
      // degraded conditions
      // When the gateway is down, report one root-cause incident instead of one per downstream sensor.
      const gw = Object.values(this.controllers).find((c) => c.is_gateway);
      const gatewayDown = now - gw.last_seen_at > hb;
      const ctrlDown = (k) => this.controllers[k] && now - this.controllers[k].last_seen_at > hb;
      for (const s of Object.values(sensors)) {
        if (gatewayDown) break;
        if (stale(s) && ctrlDown(s.controller)) continue; // root cause is the controller, reported below
        if (stale(s)) conds.push({ key: 'stale:' + s.id, type: 'sensor_stale', source_id: s.id, severity: 'degraded', value: 'no readings', unit: '', threshold: `freshness ${fresh / 1000} s` });
        else if (s.quality === 'fault') conds.push({ key: 'fault:' + s.id, type: 'sensor_fault', source_id: s.id, severity: 'degraded', value: s.fault || 'fault', unit: '', threshold: 'quality = valid' });
      }
      for (const c of Object.values(this.controllers)) {
        if (gatewayDown && c !== gw) continue;
        if (now - c.last_seen_at > hb) conds.push({ key: 'hb:' + c.id, type: 'controller', source_id: c.id, severity: 'degraded', value: c === gw ? 'gateway heartbeat missing — all telemetry stale' : 'heartbeat missing — its sensors are stale', unit: '', threshold: `heartbeat ${hb / 1000} s`, label: c.name });
      }
      if (now - this.gsm.last_report_at <= hb && !this.gsm.network_registered) conds.push({ key: 'gsm', type: 'gsm', source_id: this.gsm.id, severity: 'degraded', value: 'not registered', unit: '', threshold: 'network registered', label: 'SIM800C GSM' });

      this.openKeys = this.openKeys || {};
      const pend = this._pendingActions || [];
      this._pendingActions = [];
      const active = new Set();
      for (const c of conds) {
        active.add(c.key);
        let inc = this.openKeys[c.key] && this.incidents.find((i) => i.id === this.openKeys[c.key]);
        const label = c.label || labelOf(c.source_id);
        if (!inc || inc.state === 'cleared') {
          inc = {
            id: 'inc-' + Date.now().toString(36) + '-' + Math.floor(this.rand() * 1e4).toString(36),
            key: c.key, type: c.type, source_id: c.source_id, source_label: label, severity: c.severity, state: 'active',
            opened_at: now, last_seen_at: now, cleared_at: null, acknowledged_by: null, acknowledged_at: null,
            snapshot: { value: c.value, unit: c.unit, threshold: c.threshold, config_version: ORION.app ? ORION.app.config.configVersion : '' },
            actions: [], events: [{ at: now, text: `Opened: ${c.type.replace('_', ' ')} (${c.severity})` }], _normalSince: null,
          };
          if (c.type === 'water') inc.actions.push({ at: now, actor: 'backend', action: 'In-app notification', outcome: 'shown' }, { at: now, actor: 'backend', action: 'SMS', outcome: 'not_configured — water SMS policy pending' });
          if (c.type === 'smoke') inc.actions.push({ at: now, actor: 'backend', action: 'SMS / call', outcome: 'none — smoke SMS policy not specified' });
          this.incidents.unshift(inc);
          this.openKeys[c.key] = inc.id;
          this._event(c.severity, label, `Incident opened — ${c.type.replace('_', ' ')} (${c.severity.toUpperCase()})`, inc.id);
          this._log(c.severity === 'degraded' ? 'warn' : 'error', `Incident ${inc.id} opened: ${c.key} ${c.severity}`);
        } else {
          inc.last_seen_at = now; inc._normalSince = null;
          if (c.severity === 'critical' && inc.severity === 'warning') {
            inc.severity = 'critical';
            inc.events.push({ at: now, text: 'Escalated to CRITICAL' });
            this._event('critical', label, 'Incident escalated to CRITICAL', inc.id);
          }
          if (typeof c.value === 'number' && (typeof inc.snapshot.peak !== 'number' || c.value > inc.snapshot.peak)) inc.snapshot.peak = c.value;
        }
      }
      // attach firmware-reported actions to the matching hazard incident
      for (const p of pend) {
        const key = p.type === 'smoke' ? 'mq2' : p.type;
        const inc = this.openKeys[key] && this.incidents.find((i) => i.id === this.openKeys[key]);
        if (inc) {
          inc.actions.push({ at: p.at, actor: 'firmware', action: p.text, outcome: 'reported by controller' });
          inc.events.push({ at: p.at, text: 'Firmware reported: ' + p.text });
          if (p.type === 'flame') for (const a of this.gsmAttempts) if (!a.incident_id && a.incident_type === 'flame') a.incident_id = inc.id;
        }
        this._event('info', p.type === 'flame' ? 'Flame response' : 'Smoke response', 'Firmware reported: ' + p.text, inc ? inc.id : null);
      }
      // GSM attempt outcomes into flame incident action log
      for (const a of this.gsmAttempts) {
        if (!a.incident_id) continue;
        const inc = this.incidents.find((i) => i.id === a.incident_id);
        if (!inc || inc.id.startsWith('inc-demo')) continue;
        const label = (a.type === 'sms' ? 'SMS' : 'Voice call') + ' to ' + a.destination.split(' · ')[0];
        let row = inc.actions.find((x) => x.gsm === a.id);
        if (!row) { row = { at: a.created_at, actor: 'firmware', action: label, outcome: '', gsm: a.id }; inc.actions.push(row); }
        row.outcome = a.status + (a.note ? ' — ' + a.note : '');
      }
      // clearing: based on sensor/state logic, never on a button
      for (const [key, id] of Object.entries(this.openKeys)) {
        if (active.has(key)) continue;
        const inc = this.incidents.find((i) => i.id === id);
        if (!inc || inc.state === 'cleared') { delete this.openKeys[key]; continue; }
        // A hazard whose sensor has gone silent is NOT cleared: absence of data is not "normal".
        const src = sensors[inc.source_id];
        if (src && stale(src) && ['smoke', 'flame', 'water'].includes(inc.type)) {
          if (!inc._heldStale) { inc._heldStale = true; inc.events.push({ at: now, text: 'Source sensor stale — incident held open (cannot confirm the hazard has cleared)' }); }
          inc._normalSince = null;
          continue;
        }
        inc._heldStale = false;
        if (!inc._normalSince) { inc._normalSince = now; inc.events.push({ at: now, text: 'Condition no longer reported; clear-hold started (10 s)' }); }
        if (now - inc._normalSince >= CLEAR_HOLD) {
          inc.state = 'cleared'; inc.cleared_at = now;
          inc.events.push({ at: now, text: 'Cleared: condition normal for the clear-hold period' });
          this._event('info', inc.source_label, 'Incident cleared by sensor/state logic', inc.id);
          delete this.openKeys[key];
        }
      }
    }

    /* ---------- adapter interface ---------- */
    snapshot() {
      const sc = this.scenario;
      if (sc === 'loading') return { status: 'loading' };
      if (sc === 'backend_error') return { status: 'error', error: { code: 503, message: 'GET /api/v1/overview failed: 503 Service Unavailable (simulated)' }, at: Date.now() };
      if (sc === 'no_data') return { status: 'empty', at: Date.now() };
      return {
        status: 'ok', mode: 'demo', simulated: true, at: Date.now(),
        sensors: this.sensors, controllers: this.controllers, gsm: this.gsm, gsmAttempts: this.gsmAttempts,
        actuators: this.act, incidents: this.incidents, events: this.events, commands: this.commands, logs: this.logs,
        fwThresholds: this.fwThresholds, fwState: { fanCooldownRemaining: this.act.fan.cooldown_remaining_s, smoke: this.fw.smoke, flame: this.fw.flame },
        pipeline: { seqGaps: this.seqGaps, seq: this.seq },
      };
    }

    history(key, from, to) {
      if (this.scenario === 'no_data') return [];
      const { sensorId, metric } = ORION.registry.parseSeries(key);
      if (sensorId && SIM_SENSOR[metric] !== sensorId) return [];
      const out = [];
      for (const arr of [this.hist[metric], this.live[metric]]) {
        if (!arr) continue;
        for (const p of arr) if (p.t >= from && p.t <= to) out.push(p);
      }
      return out;
    }

    acknowledge(id, actor) {
      if (this.scenario === 'backend_error') return { ok: false, error: 'Backend unavailable — acknowledgement not recorded.' };
      const inc = this.incidents.find((i) => i.id === id);
      if (!inc) return { ok: false, error: 'Incident not found' };
      if (inc.acknowledged_at) return { ok: false, error: 'Already acknowledged' };
      inc.acknowledged_by = actor; inc.acknowledged_at = Date.now();
      inc.events.push({ at: inc.acknowledged_at, text: `Acknowledged by ${actor} — acknowledgement does not clear or silence the hazard` });
      this._event('info', inc.source_label, `Acknowledged by ${actor}`, inc.id);
      this._log('info', `audit: incident.acknowledge ${inc.id} by ${actor}`);
      this._emit();
      return { ok: true };
    }

    command({ actuator, action, actor }) {
      const now = Date.now();
      const cmd = { id: 'cmd-' + now.toString(36), actuator, action, requested_by: actor, created_at: now, expires_at: now + 30e3, status: 'requested', completed_at: null, result: null, simulated: true, history: [{ at: now, status: 'requested', note: `${actor} requested ${actuator} → ${action}` }] };
      this.commands.unshift(cmd);
      this._log('info', `audit: command.create ${cmd.id} ${actuator}:${action} by ${actor}`);
      this._emit();
      return { ok: true, command: cmd };
    }

    _progressCommands(now, gatewayUp) {
      for (const c of this.commands) {
        if (['completed', 'failed', 'rejected', 'expired', 'unknown'].includes(c.status)) continue;
        const age = now - c.created_at;
        const step = (status, note) => { c.status = status; c.history.push({ at: now, status, note }); };
        if (this.scenario === 'backend_error' && c.status === 'requested') { step('failed', 'Backend unavailable; command not queued'); c.completed_at = now; continue; }
        if (c.status === 'requested' && age >= 600) step('queued', 'Backend validated permissions, allowlist, expiry and interlocks (simulated)');
        else if (c.status === 'queued' && age >= 1800) {
          if (gatewayUp) step('sent', 'Transmitted to gateway'); else step('sent', 'Transmit attempted; gateway not acknowledging');
        } else if (c.status === 'sent') {
          if (!gatewayUp) { if (now > c.expires_at) { step('expired', 'No device response before expiry (30 s)'); c.completed_at = now; } continue; }
          if (age < 3500) continue;
          const fw = this.fw;
          if (c.actuator === 'fan' && c.action === 'off' && (fw.smoke || fw.fanCooldownUntil)) {
            step('rejected', 'Device local rule: fan held ON during smoke / cooldown'); c.completed_at = now; c.result = 'rejected_by_interlock'; continue;
          }
          step('accepted', 'Controller accepted command');
          if (c.actuator === 'fan') { fw.manualFan = c.action; this.act.fan.commanded = c.action === 'on' ? 'on' : (fw.smoke || fw.fanCooldownUntil ? 'on' : 'off'); this.act.fan.by = 'user command (simulated)'; this.act.fan.last_changed_at = now; }
          if (c.actuator === 'buzzer') { fw.buzzerTestUntil = now + 2000; this.act.buzzer.commanded = 'on'; this.act.buzzer.pattern = 'test (2 s)'; }
          c._acceptedAt = now;
        } else if (c.status === 'accepted' && now - c._acceptedAt >= 1500) {
          step('unknown', 'Output driven by controller; physical result unverified (no feedback sensor)');
          c.completed_at = now; c.result = 'executed_unverified';
        }
      }
      this._firmware(now);
    }
  }

  /* Phase 2 placeholder: same interface, no data until a backend exists. Never fabricates. */
  class LiveSource {
    constructor() { this.kind = 'live'; this.label = 'Live backend'; }
    start() {} stop() {}
    snapshot() { return { status: 'unconfigured', message: 'No ORION backend is configured. Live telemetry arrives in Phase 2 (backend + ESP32 gateway).' }; }
    history() { return []; }
    acknowledge() { return { ok: false, error: 'No backend configured' }; }
    command() { return { ok: false, error: 'No backend configured — the command was not sent.' }; }
    setScenario() {}
  }

  ORION.sources = { DemoSource, LiveSource, SCENARIOS, SIM_SENSOR };
})();
