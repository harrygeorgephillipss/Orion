'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

const { ORION } = load(['core.js', 'registry.js']);
const R = ORION.registry;
const snap = {
  sensors: {
    'z-dht': { id: 'z-dht', type: 'dht22', room: 'Bedroom' },
    'a-water': { id: 'a-water', type: 'water' },
    'smoke:2': { id: 'smoke:2', type: 'mq2' },
    weird: { id: 'weird', type: 'unknown' },
  },
  controllers: { u: { id: 'uno-1', name: 'UNO' }, g: { id: 'esp-1', name: 'ESP32', is_gateway: true } },
};

test('sensors are ordered by type then id; unknown types last', () => {
  assert.deepEqual(Array.from(R.sensorIds(snap)), ['smoke:2', 'a-water', 'z-dht', 'weird']);
});
test('series list: DHT22 yields temp + hum; unknown types yield none', () => {
  assert.deepEqual(Array.from(R.seriesList(snap), (s) => s.key), ['smoke:2:mq2', 'a-water:water', 'z-dht:temp', 'z-dht:hum']);
});
test('parseSeries handles ids that contain colons', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(R.parseSeries('smoke:2:mq2'))), { sensorId: 'smoke:2', metric: 'mq2' });
  assert.equal(R.seriesInfo('smoke:2:mq2').sensorId, 'smoke:2');
  assert.equal(R.seriesInfo('x:nope'), null);
});
test('seriesForMetric picks the first sensor of the metric type', () => {
  assert.equal(R.seriesForMetric(snap, 'hum'), 'z-dht:hum');
  assert.equal(R.seriesForMetric(snap, 'flame'), null);
});
test('gateway and controller lookups', () => {
  assert.equal(R.gatewayKey(snap), 'g');
  assert.equal(R.controllerKeyById(snap, 'uno-1'), 'u');
  assert.equal(R.gatewayKey({ controllers: {} }), null);
});
test('room: owner label overrides backend room', () => {
  assert.equal(R.roomOf({ rooms: {} }, snap.sensors['z-dht']), 'Bedroom');
  assert.equal(R.roomOf({ rooms: { 'z-dht': 'Study' } }, snap.sensors['z-dht']), 'Study');
});
test('esc escapes HTML special characters', () => {
  assert.equal(ORION.util.esc(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(ORION.util.esc(null), '');
});
