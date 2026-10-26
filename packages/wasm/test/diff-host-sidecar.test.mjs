/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { engine, currentMainOracle, init, create, observe, sameObservation } from './diff-host-helpers.mjs';

test('raw live/text WASM retains accepted structural claims and conflicts (#8042, #8130, #8088)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const vectors = JSON.parse(readFileSync(new URL('../../../rust/diff/tests/sidecar_dedup_vectors.json', import.meta.url), 'utf8'));
  for (const vector of vectors) {
    const lineage = vector.kind === 'lineage';
    const live = () => wasm.diffCreateSidecarValue(vector.init, lineage);
    const text = () => JSON.parse(wasm.diffCreateSidecar(JSON.stringify(vector.init), lineage));
    if (vector.error) {
      let message;
      assert.throws(live, error => {
        assert.ok(error instanceof Error, vector.name);
        message = error.message;
        assert.ok(message.includes(vector.error), vector.name);
        return true;
      });
      // R134-01: the preserved JSON-text ABI throws a diagnostic STRING.
      assert.throws(text, error => {
        assert.equal(typeof error, 'string', vector.name);
        assert.equal(error, message, vector.name);
        return true;
      });
    } else {
      const expected = vector.order.map(index => vector.init.entries[index]);
      assert.deepEqual(live().entries, expected, vector.name);
      assert.deepEqual(text().entries, expected, vector.name);
    }
  }
  for (const lineage of [false, true]) {
    const keys = ['\ud800\0\u0001', '\ud801\0\u0001', '\udfff', '\ufffd', 'literal\\ud800'];
    const entries = keys.map(key => lineage
      ? { base: [key], head: [`next:${key}`], relation: 'identity', reason: key }
      : { base: key, here: `next:${key}`, reason: key });
    entries.push({ ...entries[0], get reason() { throw new Error('duplicate reason must not be read'); } });
    const result = wasm.diffCreateSidecarValue(init(entries), lineage);
    const ordered = [...entries.slice(0, -1)].sort((a, b) => {
      const left = lineage ? a.base[0] : a.base;
      const right = lineage ? b.base[0] : b.base;
      return left < right ? -1 : left > right ? 1 : 0;
    });
    assert.deepEqual(result.entries, ordered);
  }
});

test('raw text string and live Error diagnostics retain exact lone UTF-16 units (#8042, R134-01)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  for (const key of ['\ud800\0\u0001', '\udfff', '\ufffd', 'literal\\ud800']) {
    for (const lineage of [false, true]) {
      const entries = ['a', 'b'].map(base => lineage
        ? { base: [base], head: [key], relation: 'identity', reason: 'conflict' }
        : { base, here: key, reason: 'conflict' });
      const value = init(entries);
      const expected = lineage
        ? `Invalid lineage sidecar: head key "${key}" appears in more than one lineage entry`
        : `Invalid identity-map sidecar: entries claim two different base identities for here "${key}"`;
      assert.throws(() => wasm.diffCreateSidecarValue(value, lineage), error => {
        assert.ok(error instanceof Error); assert.equal(error.message, expected); return true;
      });
      assert.throws(() => wasm.diffCreateSidecar(JSON.stringify(value), lineage), error => {
        assert.equal(typeof error, 'string'); assert.equal(error, expected); return true;
      });
    }
  }
});

test('raw live WASM structural corpus agrees with current-main built TS (#8042, #8130)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const oracle = await currentMainOracle(context); if (!oracle) return;
  const vectors = JSON.parse(readFileSync(new URL('../../../rust/diff/tests/sidecar_dedup_vectors.json', import.meta.url), 'utf8'));
  for (const vector of vectors) {
    const lineage = vector.kind === 'lineage';
    if (vector.error) {
      let expected;
      try { create(oracle, structuredClone(vector.init), lineage); } catch (error) { expected = error.message; }
      assert.equal(typeof expected, 'string', vector.name);
      assert.throws(() => wasm.diffCreateSidecarValue(structuredClone(vector.init), lineage), { message: expected });
    } else assert.deepEqual(wasm.diffCreateSidecarValue(vector.init, lineage), create(oracle, vector.init, lineage), vector.name);
  }
});

test('raw live WASM captures stringify callee/receiver before tuple getters (#8042, #8130)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const oracle = await currentMainOracle(context); if (!oracle) return;
  for (const lineage of [false, true]) {
    const make = trace => {
      const json = globalThis.JSON;
      const descriptor = Object.getOwnPropertyDescriptor(json, 'stringify');
      const stringify = json.stringify;
      const entry = lineage
        ? { relation: 'identity', base: ['\ud800\0x'], head: ['h\u0001'], reason: 'first' }
        : { base: '\ud800\0x', here: 'h\u0001', reason: 'first' };
      const first = lineage ? 'relation' : 'base';
      const value = entry[first];
      Object.defineProperty(entry, first, { get() {
        trace.push(first);
        // A late callee lookup would now throw; capture the original receiver
        // too, even if the global JSON binding is replaced by a field getter.
        Object.defineProperty(json, 'stringify', { configurable: true, value() { throw new Error('late callee'); } });
        globalThis.JSON = { stringify() { throw new Error('late receiver'); } };
        return value;
      } });
      Object.defineProperty(json, 'stringify', { configurable: true, get() {
        trace.push('callee');
        return function (tuple) {
          trace.push('call');
          assert.equal(this, json);
          assert.equal(arguments.length, 1);
          assert.deepEqual(tuple, lineage ? ['identity', ['\ud800\0x'], ['h\u0001']] : ['\ud800\0x', 'h\u0001']);
          return stringify(tuple);
        };
      } });
      return { value: init([entry]), restore() { globalThis.JSON = json; Object.defineProperty(json, 'stringify', descriptor); } };
    };
    const expected = observe(make, input => create(oracle, input.value, lineage));
    const actual = observe(make, input => wasm.diffCreateSidecarValue(input.value, lineage));
    sameObservation(expected, actual);
    assert.deepEqual(actual.trace.slice(0, 3), ['callee', lineage ? 'relation' : 'base', 'call']);
  }
});

test('raw live WASM preserves tuple toJSON/index/length and projection reads (#8042, #8130)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const oracle = await currentMainOracle(context); if (!oracle) return;
  const make = trace => {
    let reads = 0;
    const base = new Proxy(['\ud800\0a', 'b\u0001c'], { get(target, key, receiver) {
      trace.push(`base:${String(key)}`);
      return Reflect.get(target, key, receiver);
    } });
    Object.defineProperty(base, 'toJSON', { get() {
      trace.push('toJSON:get');
      return function (key) { trace.push(`toJSON:${key}`); assert.equal(this, base); return this; };
    } });
    Object.defineProperty(base, 'join', { get() { throw new Error('old SOH signature'); } });
    const entry = { get relation() { trace.push('relation'); return 'merge'; },
      get base() { trace.push(`base:get:${++reads}`); return base; },
      get head() { trace.push('head'); return ['h']; },
      get reason() { trace.push('reason'); return 'first'; } };
    return { value: init([entry]) };
  };
  const expected = observe(make, input => create(oracle, input.value, true));
  const actual = observe(make, input => wasm.diffCreateSidecarValue(input.value, true));
  sameObservation(expected, actual);
  assert.deepEqual(actual.value.entries[0].base, ['\ud800\0a', 'b\u0001c']);
  assert.ok(actual.trace.includes('toJSON:1'));
  assert.ok(actual.trace.includes('base:length'));
  assert.ok(actual.trace.includes('base:0'));
});

test('raw live WASM closes entries and preserves thrown identity with recovery (#8042, #8130)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const oracle = await currentMainOracle(context); if (!oracle) return;
  for (const sentinel of [{ failure: 'user callback' }, undefined, null, NaN, 'raw failure', Symbol('failure')]) {
    for (const stage of ['callee', 'base', 'stringify', 'toJSON', 'index', 'length', 'iterator']) {
      const make = trace => {
        const descriptor = Object.getOwnPropertyDescriptor(JSON, 'stringify');
        const base = ['b'];
        if (stage === 'toJSON') base.toJSON = () => { trace.push('throw:toJSON'); throw sentinel; };
        const liveBase = ['index', 'length'].includes(stage) ? new Proxy(base, { get(target, key, receiver) {
          if (key === (stage === 'index' ? '0' : 'length')) { trace.push(`throw:${stage}`); throw sentinel; }
          return Reflect.get(target, key, receiver);
        } }) : base;
        const entry = { relation: 'identity', get base() {
          if (stage === 'base') { trace.push('throw:base'); throw sentinel; }
          return liveBase;
        }, head: ['h'], reason: 'first' };
        if (stage === 'iterator') liveBase[Symbol.iterator] = function* () {
          try { trace.push('inner:next'); throw sentinel; } finally { trace.push('inner:close'); }
        };
        if (stage === 'callee') Object.defineProperty(JSON, 'stringify', { configurable: true, get() { trace.push('throw:callee'); throw sentinel; } });
        if (stage === 'stringify') Object.defineProperty(JSON, 'stringify', { configurable: true, value() { trace.push('throw:stringify'); throw sentinel; } });
        return { value: init((function* () { try { trace.push('entries:next'); yield entry; trace.push('unexpected'); } finally { trace.push('entries:close'); } })()),
          restore() { Object.defineProperty(JSON, 'stringify', descriptor); } };
      };
      const expected = observe(make, input => create(oracle, input.value, true));
      const actual = observe(make, input => wasm.diffCreateSidecarValue(input.value, true));
      sameObservation(expected, actual);
      assert.equal(actual.error, sentinel, stage);
      assert.equal(actual.trace.at(-1), 'entries:close', stage);
      assert.deepEqual(wasm.diffCreateSidecarValue(init([{ base: 'b', here: 'h', reason: 'recovery' }]), false).entries,
        [{ base: 'b', here: 'h', reason: 'recovery' }]);
    }
  }
});

test('raw live WASM observes tuple-root toJSON and duplicate JSON identities (#8042, #8130)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const oracle = await currentMainOracle(context); if (!oracle) return;
  const make = trace => {
    const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
    const first = ['first\ud800'];
    const second = ['different\ud801'];
    for (const base of [first, second]) Object.defineProperty(base, 'toJSON', {
      enumerable: true, writable: true, configurable: true,
      value: function (key) { trace.push(`base:toJSON:${key}`); return ['same-wire']; },
    });
    const value = init([
      { relation: 'identity', base: first, head: ['h'], reason: 'first' },
      { relation: 'identity', base: second, head: ['h'], get reason() { throw new Error('JSON duplicate must keep first reason'); } },
    ]);
    Object.defineProperty(Array.prototype, 'toJSON', { configurable: true, value(key) {
      trace.push(`array:toJSON:${key}`);
      return this;
    } });
    return { value, restore() {
      if (descriptor) Object.defineProperty(Array.prototype, 'toJSON', descriptor);
      else delete Array.prototype.toJSON;
    } };
  };
  const expected = observe(make, input => create(oracle, input.value, true));
  const actual = observe(make, input => wasm.diffCreateSidecarValue(input.value, true));
  sameObservation(expected, actual);
  assert.deepEqual(actual.value.entries.map(entry => [entry.base, entry.reason]), [[['first\ud800'], 'first']]);
  assert.ok(actual.trace.includes('array:toJSON:'));
});

test('raw live WASM sidecar stringify callbacks can reenter without losing the outer input (#8042, #8130)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const oracle = await currentMainOracle(context); if (!oracle) return;
  const run = (api, value) => api === wasm ? wasm.diffCreateSidecarValue(value, true) : create(api, value, true);
  const execute = api => observe(trace => {
    const base = ['outer\ud800'];
    Object.defineProperty(base, 'toJSON', { enumerable: true, writable: true, configurable: true, value: function () {
      trace.push('toJSON:enter');
      const nested = run(api, init([{ base: ['inner'], head: ['next'], relation: 'identity', reason: 'inner' }]));
      assert.equal(nested.entries[0].reason, 'inner');
      trace.push('toJSON:exit');
      return this;
    } });
    return { value: init([{ base, head: ['outer-head'], relation: 'identity', reason: 'outer' }]) };
  }, input => run(api, input.value));
  const expected = execute(oracle);
  const actual = execute(wasm);
  sameObservation(expected, actual);
  assert.deepEqual(actual.value.entries[0].base, ['outer\ud800']);
});

test('raw live WASM catches validation Error constructor throws and recovers (#8042)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const oracle = await currentMainOracle(context); if (!oracle) return;
  const sentinel = { failure: 'Error constructor' };
  const make = trace => {
    const constructor = globalThis.Error;
    globalThis.Error = function (message) { trace.push(message); throw sentinel; };
    return { value: init([{ base: 'b', here: 'h', reason: 0 }]), restore() { globalThis.Error = constructor; } };
  };
  const expected = observe(make, input => create(oracle, input.value, false));
  const actual = observe(make, input => wasm.diffCreateSidecarValue(input.value, false));
  sameObservation(expected, actual);
  assert.equal(actual.error, sentinel);
  assert.deepEqual(wasm.diffCreateSidecarValue(init([{ base: 'b', here: 'h', reason: 'recovered' }]), false).entries,
    [{ base: 'b', here: 'h', reason: 'recovered' }]);
});
