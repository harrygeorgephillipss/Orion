/* Loads ORION's browser scripts into an isolated VM context with a controllable clock. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', '..', 'src');

function load(files, opts) {
  const clock = { now: (opts && opts.now) || Date.UTC(2026, 10, 16, 6, 0, 0) };
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(clock.now); }
    static now() { return clock.now; }
  }
  const store = new Map();
  const ctx = {
    console, Math, JSON, Intl, Promise, Set, Map, Object, Array, String, Number, Boolean, Symbol, Error, RegExp, isFinite, parseFloat,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    Date: FakeDate,
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    navigator: { userAgent: 'node', language: 'en-IN' },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f });
  return { ORION: ctx.ORION, clock, advance(ms) { clock.now += ms; } };
}

const CORE = ['core.js', 'registry.js', 'sources.js', 'state.js'];
module.exports = { load, CORE };
