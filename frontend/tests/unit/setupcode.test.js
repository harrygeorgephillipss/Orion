'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

const { ORION } = load(['core.js']);
const SAMPLE = { host: '192.168.1.10', port: 1883, home: 'home-1', gateway: 'esp32-01', password: 'Abc_def-ghijklmnopqrstu12', controller: 'uno-01', gsm: 'gsm-01', mq2: 'mq2-01', flame: 'flame-01', water: 'water-01', dht: 'dht-01' };
// The same vector is decoded by the firmware's host test (hardware/lib/OrionCore/test/test_main.cpp).
const VECTOR = 'T1JJT04xfDE5Mi4xNjguMS4xMHwxODgzfGhvbWUtMXxlc3AzMi0wMXxBYmNfZGVmLWdoaWprbG1ub3BxcnN0dTEyfHVuby0wMXxnc20tMDF8bXEyLTAxfGZsYW1lLTAxfHdhdGVyLTAxfGRodC0wMQ';

test('setup code encodes to the firmware test vector (base64url, no padding)', () => {
  assert.equal(ORION.setupCode.encode(SAMPLE), VECTOR);
});
test('setup code rejects a field containing the separator', () => {
  assert.throws(() => ORION.setupCode.encode(Object.assign({}, SAMPLE, { host: 'a|b' })));
});
