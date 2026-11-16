'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, CORE } = require('./harness');

function setup() {
  const h = load(CORE);
  const cfg = h.ORION.defaultConfig();
  const sim = new h.ORION.sources.DemoSource(1234);
  sim._tick();
  return Object.assign(h, { cfg, sim, ev: (now) => h.ORION.state.evaluate(sim.snapshot(), cfg, now || h.clock.now) });
}

test('non-ok snapshot statuses never produce NORMAL', () => {
  const { ORION, cfg } = setup();
  const ev = (s) => ORION.state.evaluate(s, cfg, Date.now());
  assert.equal(ev({ status: 'loading' }).system, 'LOADING');
  assert.equal(ev({ status: 'error', error: { message: 'x' } }).system, 'OFFLINE');
  assert.equal(ev({ status: 'error' }).system, 'OFFLINE', 'error without details must not throw');
  assert.equal(ev({ status: 'empty' }).system, 'OFFLINE');
  assert.equal(ev({ status: 'unconfigured', message: 'm' }).system, 'OFFLINE');
  assert.equal(ev({ status: 'auth' }).system, 'OFFLINE');
});

test('fresh simulated snapshot evaluates NORMAL', () => {
  const { ev } = setup();
  const e = ev();
  assert.equal(e.system, 'NORMAL', JSON.stringify(e.reasons));
  assert.equal(e.gateway, 'esp32');
});

test('stale data never shows NORMAL — gateway silence → OFFLINE', () => {
  const { ev, clock } = setup();
  const e = ev(clock.now + 60e3);
  assert.equal(e.system, 'OFFLINE');
  assert.match(e.reasons[0], /gateway heartbeat missing/);
});

test('one stale sensor with controllers online → DEGRADED', () => {
  const { ORION, cfg, sim, clock } = setup();
  const snap = sim.snapshot();
  snap.sensors['dht22-living'].received_at = clock.now - 120e3;
  const e = ORION.state.evaluate(snap, cfg, clock.now);
  assert.equal(e.system, 'DEGRADED');
  assert.ok(e.reasons.some((r) => /no reading for 120 s/.test(r)));
});

test('sensor that never reported is stale, not healthy', () => {
  const { ORION, cfg, sim, clock } = setup();
  const snap = sim.snapshot();
  snap.sensors['water-utility'].received_at = null;
  const e = ORION.state.evaluate(snap, cfg, clock.now);
  assert.equal(e.sensors['water-utility'].status, 'stale');
  assert.notEqual(e.system, 'NORMAL');
});

test('degraded conditions never hide an emergency', () => {
  const { ORION, cfg, sim, clock } = setup();
  const snap = sim.snapshot();
  snap.sensors['dht22-living'].quality = 'fault';
  snap.incidents = snap.incidents.concat([{ id: 'x', state: 'active', severity: 'critical', source_label: 'Flame sensor · Kitchen' }]);
  const e = ORION.state.evaluate(snap, cfg, clock.now);
  assert.equal(e.system, 'EMERGENCY');
  assert.ok(e.notes.length >= 1, 'degraded note retained');
});

test('gateway offline keeps last-known hazard visible', () => {
  const { ORION, cfg, sim, clock } = setup();
  const snap = sim.snapshot();
  snap.incidents = [{ id: 'x', state: 'active', severity: 'warning', source_label: 'MQ-2 · Hall' }];
  const e = ORION.state.evaluate(snap, cfg, clock.now + 25e3);
  assert.equal(e.system, 'OFFLINE');
  assert.equal(e.lastKnown, 'ATTENTION');
});

test('no gateway flagged: OFFLINE only when every controller is silent', () => {
  const { ORION, cfg, sim, clock } = setup();
  const snap = JSON.parse(JSON.stringify(sim.snapshot()));
  for (const c of Object.values(snap.controllers)) c.is_gateway = false;
  assert.notEqual(ORION.state.evaluate(snap, cfg, clock.now).system, 'OFFLINE');
  assert.equal(ORION.state.evaluate(snap, cfg, clock.now + 60e3).system, 'OFFLINE');
});

test('missing GSM module is reported as degraded, not healthy', () => {
  const { ORION, cfg, sim, clock } = setup();
  const snap = sim.snapshot();
  delete snap.gsm;
  const e = ORION.state.evaluate(snap, cfg, clock.now);
  assert.equal(e.system, 'DEGRADED');
  assert.ok(e.reasons.some((r) => /SIM800C/.test(r)));
});

test('a sensor stale because its controller is offline is reported once, as the controller', () => {
  const { ORION, cfg, sim, clock } = setup();
  const snap = sim.snapshot();
  snap.controllers.uno.last_seen_at = clock.now - 60e3;
  for (const s of Object.values(snap.sensors)) s.received_at = clock.now - 60e3;
  const e = ORION.state.evaluate(snap, cfg, clock.now);
  assert.equal(e.system, 'DEGRADED');
  assert.deepEqual(Array.from(e.reasons), ['Arduino UNO: heartbeat missing']);
});
