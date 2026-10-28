/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { engine, currentMainOracle, init, observe, sameObservation } from './diff-host-helpers.mjs';

const problem = 'created must be an ISO 8601 timestamp when present';
function value(lineage, created = '2026-10-25T12:00:00Z') {
  const entries = [lineage ? { base: ['b'], head: ['h'], relation: 'identity', reason: 'first' }
    : { base: 'b', here: 'h', reason: 'first' }];
  return { ...init(entries), format: lineage ? 'ifc-lite/lineage' : 'ifc-lite/identity-map',
    version: 1, ...(lineage ? { deleted: [] } : {}), created };
}
function tsRun(api, input, lineage, operation) {
  if (operation === 'validate') return lineage ? api.validateLineageSidecar(input) : api.validateIdentityMapSidecar(input);
  return lineage ? api.createLineageSidecar(input) : api.createIdentityMapSidecar(input);
}
function rawRun(wasm, input, lineage, operation) {
  return operation === 'validate' ? wasm.diffValidateSidecarValue(input, lineage) : wasm.diffCreateSidecarValue(input, lineage);
}

test('raw live date validation preserves NaN/parse callee order, throws and reuse (#8042, R135 date follow-up)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const oracle = await currentMainOracle(context); if (!oracle) return;
  const sentinel = { failure: 'date observation' };
  const stages = ['nan-get', 'parse-get', 'parse-call', 'nan-call'];
  const order = ['nan:get', 'parse:get', 'parse:call', 'nan:call'];
  for (const lineage of [false, true]) for (const operation of ['validate', 'create']) {
    for (const stage of stages) {
      const make = trace => {
        const nanDescriptor = Object.getOwnPropertyDescriptor(Number, 'isNaN');
        const parseDescriptor = Object.getOwnPropertyDescriptor(Date, 'parse');
        const token = { valueOf() { throw new Error('parse result must not be coerced'); } };
        Object.defineProperty(Number, 'isNaN', { configurable: true, get() {
          trace.push('nan:get'); if (stage === 'nan-get') throw sentinel;
          return function (parsed) {
            assert.equal(this, Number); assert.equal(parsed, token); trace.push('nan:call'); throw sentinel;
          };
        } });
        Object.defineProperty(Date, 'parse', { configurable: true, get() {
          trace.push('parse:get'); if (stage === 'parse-get') throw sentinel;
          return function (text) {
            assert.equal(this, Date); assert.equal(text, '2026-10-25T12:00:00Z'); trace.push('parse:call');
            if (stage === 'parse-call') throw sentinel;
            return token;
          };
        } });
        return { value: value(lineage), restore() {
          Object.defineProperty(Number, 'isNaN', nanDescriptor); Object.defineProperty(Date, 'parse', parseDescriptor);
        } };
      };
      const expected = observe(make, input => tsRun(oracle, input.value, lineage, operation));
      const actual = observe(make, input => rawRun(wasm, input.value, lineage, operation));
      sameObservation(expected, actual);
      assert.equal(actual.error, sentinel);
      assert.deepEqual(actual.trace, order.slice(0, stages.indexOf(stage) + 1));
      assert.deepEqual(rawRun(wasm, value(lineage), lineage, 'validate'), []);
      assert.deepEqual(rawRun(wasm, value(lineage), lineage, 'create'), tsRun(oracle, value(lineage), lineage, 'create'));
    }
  }
});

test('raw live date validation captures NaN callee before parse mutation and observes return truthiness (#8042, R135 date follow-up)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const oracle = await currentMainOracle(context); if (!oracle) return;
  for (const lineage of [false, true]) for (const operation of ['validate', 'create']) {
    for (const [returned, invalid] of [[false, false], [0, false], [null, false], [undefined, false], ['', false], [NaN, false], ['truthy', true], [{}, true]]) {
      const make = trace => {
        const nanDescriptor = Object.getOwnPropertyDescriptor(Number, 'isNaN');
        const parseDescriptor = Object.getOwnPropertyDescriptor(Date, 'parse');
        const token = Symbol('uncoerced parse result');
        Object.defineProperty(Number, 'isNaN', { configurable: true, get() {
          trace.push('nan:get');
          return function (parsed) { assert.equal(this, Number); assert.equal(parsed, token); trace.push('nan:call'); return returned; };
        } });
        Object.defineProperty(Date, 'parse', { configurable: true, get() {
          trace.push('parse:get');
          Object.defineProperty(Number, 'isNaN', { configurable: true, value() { throw new Error('late NaN lookup'); } });
          return function () { assert.equal(this, Date); trace.push('parse:call'); return token; };
        } });
        return { value: value(lineage), restore() {
          Object.defineProperty(Number, 'isNaN', nanDescriptor); Object.defineProperty(Date, 'parse', parseDescriptor);
        } };
      };
      // Validation errors are independently constructed Error instances.
      const outcome = run => {
        try { return { value: run() }; } catch (error) {
          assert.ok(error instanceof Error); return { message: error.message };
        }
      };
      const expected = observe(make, input => outcome(() => tsRun(oracle, input.value, lineage, operation)));
      const actual = observe(make, input => outcome(() => rawRun(wasm, input.value, lineage, operation)));
      sameObservation(expected, actual);
      assert.deepEqual(actual.trace, ['nan:get', 'parse:get', 'parse:call', 'nan:call']);
      if (operation === 'validate') assert.deepEqual(actual.value, { value: invalid ? [problem] : [] });
      else if (invalid) assert.deepEqual(actual.value, { message: `Invalid ${lineage ? 'lineage' : 'identity-map'} sidecar: ${problem}` });
      else assert.equal(actual.value.value.created, '2026-10-25T12:00:00Z');
    }
  }
});

test('raw live date validation skips host methods for absent/non-string created values (#8042, R135 date follow-up)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const oracle = await currentMainOracle(context); if (!oracle) return;
  const sentinel = { failure: 'date method must not be read' };
  for (const lineage of [false, true]) for (const created of [undefined, null, 0, true, {}, Symbol('stamp')]) {
    const descriptor = Object.getOwnPropertyDescriptor(Number, 'isNaN');
    try {
      Object.defineProperty(Number, 'isNaN', { configurable: true, get() { throw sentinel; } });
      const input = { ...value(lineage), created };
      const expected = created === undefined ? [] : [problem];
      assert.deepEqual(tsRun(oracle, input, lineage, 'validate'), expected);
      assert.deepEqual(rawRun(wasm, input, lineage, 'validate'), expected);
      if (created === undefined) assert.deepEqual(rawRun(wasm, input, lineage, 'create'), tsRun(oracle, input, lineage, 'create'));
      else for (const create of [() => tsRun(oracle, input, lineage, 'create'), () => rawRun(wasm, input, lineage, 'create')]) {
        assert.throws(create, error => {
          assert.ok(error instanceof Error); assert.equal(error.message, `Invalid ${lineage ? 'lineage' : 'identity-map'} sidecar: ${problem}`); return true;
        });
      }
    } finally { Object.defineProperty(Number, 'isNaN', descriptor); }
    assert.deepEqual(rawRun(wasm, value(lineage), lineage, 'validate'), []);
  }
});
