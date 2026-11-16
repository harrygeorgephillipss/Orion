'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, CORE } = require('./harness');

function run(sim, h, seconds) { for (let i = 0; i < seconds / 2; i++) { h.advance(2000); sim._tick(); } }
function setup() { const h = load(CORE); const sim = new h.ORION.sources.DemoSource(42); sim._tick(); return { h, sim }; }
const active = (sim, type) => sim.snapshot().incidents.filter((i) => i.type === type && i.state !== 'cleared');

test('every simulated sensor, controller and the GSM module is flagged simulated', () => {
  const { sim } = setup();
  const s = sim.snapshot();
  assert.equal(s.simulated, true);
  for (const x of Object.values(s.sensors)) assert.equal(x.simulated, true, x.id);
  for (const x of Object.values(s.controllers)) assert.equal(x.simulated, true, x.id);
  assert.equal(s.gsm.simulated, true);
});

test('flame scenario opens one critical incident and requests SMS + call', () => {
  const { h, sim } = setup();
  sim.setScenario('flame'); run(sim, h, 6);
  const inc = active(sim, 'flame');
  assert.equal(inc.length, 1);
  assert.equal(inc[0].severity, 'critical');
  const kinds = sim.snapshot().gsmAttempts.filter((a) => a.incident_id === inc[0].id).map((a) => a.type).sort();
  assert.deepEqual(Array.from(kinds), ['call', 'sms']);
});

test('incidents clear only after the clear-hold, never by acknowledgement', () => {
  const { h, sim } = setup();
  sim.setScenario('water'); run(sim, h, 6);
  const [inc] = active(sim, 'water');
  assert.ok(inc);
  assert.equal(sim.acknowledge(inc.id, 'tester').ok, true);
  assert.equal(active(sim, 'water').length, 1, 'ack must not clear');
  assert.equal(sim.acknowledge(inc.id, 'tester').ok, false, 'double ack rejected');
  sim.setScenario('normal'); run(sim, h, 6);
  assert.equal(active(sim, 'water').length, 1, 'still in clear-hold');
  run(sim, h, 12);
  assert.equal(active(sim, 'water').length, 0);
});

test('a hazard whose sensor goes silent is held open, not cleared', () => {
  const { h, sim } = setup();
  sim.setScenario('smoke_warning'); run(sim, h, 10);
  assert.equal(active(sim, 'smoke').length, 1);
  sim.setScenario('gateway_offline'); run(sim, h, 60);
  assert.equal(active(sim, 'smoke').length, 1, 'stale hazard must stay open');
});

test('UNO link loss: one controller incident instead of per-sensor stale incidents', () => {
  const { h, sim } = setup();
  sim.setScenario('uno_offline'); run(sim, h, 40);
  const s = sim.snapshot();
  const open = s.incidents.filter((i) => i.state !== 'cleared');
  assert.ok(open.some((i) => i.type === 'controller' && i.source_id === 'orion-uno-01'));
  assert.equal(open.filter((i) => i.type === 'sensor_stale').length, 0);
});

test('fan-off command is rejected by the local interlock during smoke', () => {
  const { h, sim } = setup();
  sim.setScenario('smoke_warning'); run(sim, h, 10);
  const r = sim.command({ actuator: 'fan', action: 'off', actor: 't' });
  assert.equal(r.ok, true);
  run(sim, h, 8);
  assert.equal(r.command.status, 'rejected');
});

test('fan-on command never ends as verified without feedback', () => {
  const { h, sim } = setup();
  const r = sim.command({ actuator: 'fan', action: 'on', actor: 't' });
  run(sim, h, 10);
  assert.equal(r.command.status, 'unknown');
  assert.equal(r.command.result, 'executed_unverified');
});

test('history keys: sensor-qualified series; unknown sensor yields nothing', () => {
  const { h, sim } = setup();
  const now = h.clock.now;
  assert.ok(sim.history('mq2-hall:mq2', now - 3600e3, now).length > 10);
  assert.equal(sim.history('other-sensor:mq2', now - 3600e3, now).length, 0);
});

test('LiveSource stub refuses commands instead of pretending', () => {
  const { h } = setup();
  const live = new h.ORION.sources.LiveSource();
  assert.equal(live.command({}).ok, false);
  assert.equal(live.snapshot().status, 'unconfigured');
});
