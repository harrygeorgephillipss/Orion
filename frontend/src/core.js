/* ORION core: namespace, utilities, configuration defaults, formatting. */
'use strict';
const ORION = (window.ORION = window.ORION || {});

/* ---------- utilities ---------- */
ORION.util = (function () {
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  let idc = 0;
  const uid = (p) => `${p}-${Date.now().toString(36)}-${(++idc).toString(36)}`;
  const iso = (ms) => new Date(ms).toISOString();
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  };
  const deepCopy = (o) => JSON.parse(JSON.stringify(o));
  return { mulberry32, esc, clamp, uid, iso, store, deepCopy };
})();

/* ---------- configuration (owner-editable; unknowns marked pending) ---------- */
ORION.defaultConfig = function () {
  return {
    version: 3,
    home: { id: 'home-demo', name: 'Demo Home (model house)' },
    timezone: 'Asia/Kolkata',
    tempUnit: 'C',
    freshness: { sensor_s: 30, heartbeat_s: 20 },
    rooms: {
      'mq2-hall': 'Hall',
      'flame-kitchen': 'Kitchen',
      'water-utility': 'Utility area',
      'dht22-living': 'Living room',
    },
    // App-side alert/display thresholds. The firmware's own thresholds are reported separately.
    thresholds: {
      mq2_warning: 350, mq2_critical: 500,
      water_wet: 300,
      temp_advisory_c: null, humidity_advisory: null,
    },
    notifications: { inapp: true, sms: false, call: false, recipients: [] },
    users: [{ name: 'Demo Owner', role: 'owner' }],
    configVersion: 'cfg-demo-3',
  };
};

/* Decisions the brief says must not be guessed. Shown across the app. */
ORION.pending = [
  { key: 'boards', title: 'UNO vs ESP32 responsibilities', detail: 'Planned (docs/hardware-architecture.md): the UNO reads all sensors and drives all outputs; the ESP32 is the Wi-Fi/MQTT gateway and runs the SIM800C. Not yet built or tested on hardware.' },
  { key: 'pins', title: 'Pin map and actual wiring', detail: 'No pins are shown or assumed anywhere in ORION.' },
  { key: 'mq2', title: 'MQ-2 calibration and thresholds', detail: 'Values are raw ADC, not ppm. 350/500 are placeholder thresholds.' },
  { key: 'mq2_level', title: 'Which MQ-2 level triggers local actions', detail: 'Demo firmware triggers fan, buzzer, LEDs and door at the warning threshold.' },
  { key: 'flame', title: 'Flame sensor polarity and output', detail: 'Active HIGH/LOW must be measured. Demo uses a digital detected/not-detected value.' },
  { key: 'flame_buzzer', title: 'Flame → buzzer rule', detail: 'The brief does not say whether flame sounds the buzzer. Demo firmware follows the brief literally (no buzzer).' },
  { key: 'flame_lights', title: 'Flame → white lights OFF', detail: 'The brief turns model lights off on flame. Confirm intent (cut kitchen power vs. lights for egress).' },
  { key: 'water', title: 'Water sensor type and threshold', detail: 'Demo treats raw ADC above 300 as wet.' },
  { key: 'water_notify', title: 'Water notification channel', detail: 'In-app only until SMS/call policy and recipients are defined.' },
  { key: 'smoke_sms', title: 'Smoke → SMS/call policy', detail: 'Not specified in the brief. No SMS is sent for smoke in the demo.' },
  { key: 'dht', title: 'DHT22 wiring, read interval and advisory thresholds', detail: 'Advisory thresholds are unset.' },
  { key: 'relay', title: 'Relay channel count, mapping and active level', detail: 'Not assumed active-LOW. Demo maps CH1 to the fan as an illustration.' },
  { key: 'mist', title: 'Mist maker', detail: 'Not in the current hardware inventory. Kept as a disabled placeholder; never activated automatically.' },
  { key: 'sg90', title: 'SG90 mechanical purpose', detail: 'Generic servo card only.' },
  { key: 'door', title: 'MG995 door policy', detail: 'MQ-2 only, 180° for 5 s (latest request). What happens after 5 s is unconfirmed; demo returns to 0°. Needs safety review before any real door.' },
  { key: 'gsm', title: 'SIM800C power and AT response reporting', detail: 'SIM800C is 2G-only. A Jio SIM will not register; use a 2G-capable network.' },
  { key: 'hosting', title: 'Where the ORION server runs', detail: 'LAN PC / Raspberry Pi or a cloud VPS. Simulation mode runs entirely in the browser.' },
  { key: 'recipients', title: 'Notification recipients', detail: 'None configured. Real alerts are disabled.' },
];

/* ---------- formatting ---------- */
ORION.fmt = (function () {
  const cache = {};
  function dtf(tz, opts) {
    const k = tz + JSON.stringify(opts);
    if (!cache[k]) {
      try { cache[k] = new Intl.DateTimeFormat('en-IN', Object.assign({ timeZone: tz }, opts)); }
      catch (e) { cache[k] = new Intl.DateTimeFormat('en-IN', opts); }
    }
    return cache[k];
  }
  function tzAbbr(tz) {
    if (tz === 'Asia/Kolkata' || tz === 'Asia/Calcutta') return 'IST';
    if (tz === 'UTC') return 'UTC';
    try {
      const p = dtf(tz, { timeZoneName: 'short' }).formatToParts(new Date()).find((x) => x.type === 'timeZoneName');
      return p ? p.value : tz;
    } catch (e) { return tz; }
  }
  const tz = () => (ORION.app && ORION.app.config.timezone) || 'Asia/Kolkata';
  return {
    time(ms) { return ms == null ? '—' : dtf(tz(), { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(ms); },
    hm(ms) { return dtf(tz(), { hour: '2-digit', minute: '2-digit', hour12: false }).format(ms); },
    day(ms) { return dtf(tz(), { day: 'numeric', month: 'short' }).format(ms); },
    dt(ms) {
      if (ms == null) return '—';
      return dtf(tz(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(ms) + ' ' + tzAbbr(tz());
    },
    tzAbbr: () => tzAbbr(tz()),
    ago(ms, now) {
      if (ms == null) return 'never';
      const s = Math.max(0, Math.round(((now || Date.now()) - ms) / 1000));
      if (s < 2) return 'just now';
      if (s < 60) return s + 's ago';
      const m = Math.floor(s / 60);
      if (m < 60) return m + 'm ' + (s % 60) + 's ago';
      const h = Math.floor(m / 60);
      if (h < 48) return h + 'h ' + (m % 60) + 'm ago';
      return Math.floor(h / 24) + 'd ago';
    },
    dur(s) {
      s = Math.round(s);
      if (s < 60) return s + 's';
      const m = Math.floor(s / 60);
      if (m < 60) return m + 'm ' + (s % 60 ? (s % 60) + 's' : '');
      return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
    },
    temp(c) {
      if (c == null) return '—';
      const u = (ORION.app && ORION.app.config.tempUnit) || 'C';
      return u === 'F' ? (c * 9 / 5 + 32).toFixed(1) : c.toFixed(1);
    },
    tempUnit() { return ((ORION.app && ORION.app.config.tempUnit) || 'C') === 'F' ? '°F' : '°C'; },
  };
})();
