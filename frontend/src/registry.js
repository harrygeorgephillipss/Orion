/* ORION device registry helpers.
 *
 * The UI must not assume particular sensor or controller IDs: the live backend registers devices with its own IDs.
 * A snapshot carries `sensors` (keyed by sensor id, each with a `type`) and `controllers` (keyed by controller key,
 * one of which may be flagged `is_gateway`). Everything else (tiles, chart series, Aura context, settings rows)
 * is derived here from those objects.
 *
 * Series keys identify one measured quantity of one sensor: `<sensor_id>:<metric>`, e.g. `mq2-hall:mq2`.
 */
'use strict';
(function () {
  /* Sensor types ORION understands, in display order, with the metrics each one produces. */
  const TYPES = {
    mq2: { name: 'Smoke & gas', metrics: ['mq2'] },
    flame: { name: 'Flame', metrics: ['flame'] },
    water: { name: 'Water leak', metrics: ['water'] },
    dht22: { name: 'Temperature & humidity', metrics: ['temp', 'hum'] },
  };
  const TYPE_ORDER = Object.keys(TYPES);

  /* One measured quantity. `field` is the key inside sensor.fields. */
  const METRICS = {
    mq2: { type: 'mq2', field: 'raw_adc', name: 'Smoke & gas', label: 'MQ-2 (raw ADC)', unit: 'ADC', dp: 0, icon: 'smoke', color: '#f0a35e', aura: 'smoke' },
    flame: { type: 'flame', field: 'detected', name: 'Flame', label: 'Flame (detected)', unit: '0/1', dp: 0, icon: 'flame', color: '#ff6b6b', aura: 'flame' },
    water: { type: 'water', field: 'raw_adc', name: 'Water leak', label: 'Water (raw ADC)', unit: 'ADC', dp: 0, icon: 'water', color: '#7aa8ff', aura: 'water' },
    temp: { type: 'dht22', field: 'temperature_c', name: 'Temperature', label: 'Temperature', unit: '°C', dp: 1, icon: 'temp', color: '#ff8a7a', aura: 'temperature' },
    hum: { type: 'dht22', field: 'humidity_percent', name: 'Humidity', label: 'Humidity', unit: '%RH', dp: 1, icon: 'hum', color: '#6cc6e8', aura: 'humidity' },
  };

  const sensorList = (snap) => {
    if (!snap || !snap.sensors) return [];
    return Object.values(snap.sensors).sort((a, b) => {
      const ta = TYPE_ORDER.indexOf(a.type), tb = TYPE_ORDER.indexOf(b.type);
      return (ta < 0 ? 99 : ta) - (tb < 0 ? 99 : tb) || String(a.id).localeCompare(String(b.id));
    });
  };
  const sensorIds = (snap) => sensorList(snap).map((s) => s.id);
  /* First sensor of a type (most homes have one of each). */
  const sensorOfType = (snap, type) => sensorList(snap).find((s) => s.type === type) || null;

  const seriesKey = (sensorId, metric) => `${sensorId}:${metric}`;
  function parseSeries(key) {
    const s = String(key || ''), i = s.lastIndexOf(':');
    return i < 0 ? { sensorId: null, metric: s } : { sensorId: s.slice(0, i), metric: s.slice(i + 1) };
  }
  /* All chart series available in a snapshot, in display order. */
  function seriesList(snap) {
    const out = [];
    for (const s of sensorList(snap)) {
      const t = TYPES[s.type]; if (!t) continue;
      for (const m of t.metrics) out.push(Object.assign({ key: seriesKey(s.id, m), sensorId: s.id, metric: m }, METRICS[m]));
    }
    return out;
  }
  function seriesInfo(key) {
    const p = parseSeries(key), m = METRICS[p.metric];
    return m ? Object.assign({ key, sensorId: p.sensorId, metric: p.metric }, m) : null;
  }
  /* Series for the first sensor of the metric's type (used by Aura's sensor names). */
  function seriesForMetric(snap, metric) {
    const m = METRICS[metric]; if (!m) return null;
    const s = sensorOfType(snap, m.type);
    return s ? seriesKey(s.id, metric) : null;
  }

  /* Controller that relays telemetry to the backend (ESP32 in the ORION design). */
  function gatewayKey(snap) {
    if (!snap || !snap.controllers) return null;
    const e = Object.entries(snap.controllers).find(([, c]) => c.is_gateway);
    return e ? e[0] : null;
  }
  function controllerKeyById(snap, id) {
    if (!snap || !snap.controllers) return null;
    const e = Object.entries(snap.controllers).find(([k, c]) => c.id === id || k === id);
    return e ? e[0] : null;
  }

  /* Room shown for a sensor: owner's label in settings, else what the backend reports. */
  const roomOf = (cfg, sensor) => (cfg && cfg.rooms && cfg.rooms[sensor.id]) || sensor.room || '';

  ORION.registry = { TYPES, TYPE_ORDER, METRICS, sensorList, sensorIds, sensorOfType, seriesKey, parseSeries, seriesList, seriesInfo, seriesForMetric, gatewayKey, controllerKeyById, roomOf };
})();
