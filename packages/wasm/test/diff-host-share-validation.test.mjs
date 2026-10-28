/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { engine, currentMainOracle, init, split, observe, sameObservation } from './diff-host-helpers.mjs';

const problem = 'shares must be one finite non-negative number per key on the k side of a split or merge';
const sidecar = entry => ({ ...init([entry]), format: 'ifc-lite/lineage', version: 1, deleted: [] });

test('raw live validate/create uses host finite truthiness before >= with builtin every (#8042, R134-03)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const oracle = await currentMainOracle(context); if (!oracle) return;
  for (const left of [false, 0, null, undefined, '', 'truthy']) {
    for (const [shares, validWhenTruthy] of [[[0.4, 0.6], true], [[-0.1, 0.6], false], [[NaN, 0.6], false], [[Infinity, 0.6], true]]) {
      const descriptor = Object.getOwnPropertyDescriptor(Number, 'isFinite');
      try {
        Object.defineProperty(Number, 'isFinite', { configurable: true, value: () => left });
        const value = sidecar(split(shares));
        const valid = left === 'truthy' && validWhenTruthy;
        assert.deepEqual(oracle.validateLineageSidecar(value), valid ? [] : [problem]);
        assert.deepEqual(wasm.diffValidateSidecarValue(value, true), valid ? [] : [problem]);
        if (valid) assert.deepEqual(wasm.diffCreateSidecarValue(value, true), oracle.createLineageSidecar(value));
        else for (const create of [() => oracle.createLineageSidecar(value), () => wasm.diffCreateSidecarValue(value, true)]) {
          assert.throws(create, error => {
            assert.ok(error instanceof Error); assert.equal(error.message, `Invalid lineage sidecar: ${problem}`); return true;
          });
        }
      } finally { Object.defineProperty(Number, 'isFinite', descriptor); }
      assert.deepEqual(wasm.diffValidateSidecarValue(sidecar(split([0.4, 0.6])), true), []);
    }
  }
});

test('raw live validate/create observes current finite getter/call throws and recovers (#8042, R134-03)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const oracle = await currentMainOracle(context); if (!oracle) return;
  const sentinel = { failure: 'live validation finite observation' };
  for (const operation of ['validate', 'create']) {
    for (const stage of ['getter', 'call']) {
      const make = trace => {
        const descriptor = Object.getOwnPropertyDescriptor(Number, 'isFinite');
        Object.defineProperty(Number, 'isFinite', { configurable: true, get() {
          trace.push('finite:get');
          if (stage === 'getter') throw sentinel;
          return function (share) { assert.equal(this, Number); trace.push(['finite:call', share]); throw sentinel; };
        } });
        return { value: sidecar(split([0.4, 0.6])), restore() { Object.defineProperty(Number, 'isFinite', descriptor); } };
      };
      const expected = observe(make, input => operation === 'validate'
        ? oracle.validateLineageSidecar(input.value) : oracle.createLineageSidecar(input.value));
      const actual = observe(make, input => operation === 'validate'
        ? wasm.diffValidateSidecarValue(input.value, true) : wasm.diffCreateSidecarValue(input.value, true));
      sameObservation(expected, actual);
      assert.equal(actual.error, sentinel);
      const valid = sidecar(split([0.4, 0.6]));
      assert.deepEqual(wasm.diffValidateSidecarValue(valid, true), []);
      assert.deepEqual(wasm.diffCreateSidecarValue(valid, true), oracle.createLineageSidecar(valid));
    }
  }
});

test('raw live validate/create keeps the noncoercive number type gate (#8042, R134-03)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const oracle = await currentMainOracle(context); if (!oracle) return;
  const sentinel = { failure: 'number gate must prevent host observation' };
  const coercible = { [Symbol.toPrimitive]() { throw sentinel; } };
  for (const share of ['0.4', true, null, undefined, 0n, Symbol('share'), new Number(0.4), coercible]) {
    const descriptor = Object.getOwnPropertyDescriptor(Number, 'isFinite');
    try {
      Object.defineProperty(Number, 'isFinite', { configurable: true, get() { throw sentinel; } });
      const value = sidecar(split([share, 0.6]));
      assert.deepEqual(oracle.validateLineageSidecar(value), [problem]);
      assert.deepEqual(wasm.diffValidateSidecarValue(value, true), [problem]);
      for (const create of [() => oracle.createLineageSidecar(value), () => wasm.diffCreateSidecarValue(value, true)]) {
        assert.throws(create, error => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, `Invalid lineage sidecar: ${problem}`);
          return true;
        });
      }
    } finally { Object.defineProperty(Number, 'isFinite', descriptor); }
    assert.deepEqual(wasm.diffValidateSidecarValue(sidecar(split([0.4, 0.6])), true), []);
  }
});

test('raw live validate/create preserves && values seen by custom every and retained callbacks (#8042, R134-03)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const oracle = await currentMainOracle(context); if (!oracle) return;
  for (const operation of ['validate', 'create']) {
    for (const left of [false, 0, -0, 0n, null, undefined, '', NaN]) {
      const execute = api => observe(trace => {
        const finiteDescriptor = Object.getOwnPropertyDescriptor(Number, 'isFinite');
        const everyDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'every');
        let retained;
        Object.defineProperty(Number, 'isFinite', { configurable: true, value(share) {
          trace.push(['finite', share]); return left;
        } });
        // Creation projects shares into a fresh array. Override the method on
        // its prototype as well as observing direct live validation.
        Object.defineProperty(Array.prototype, 'every', { configurable: true, value(callback, ...args) {
          if (this.length === 2 && this[0] === 0.4 && this[1] === 0.6) {
            retained = callback;
            const returned = callback(this[0]); trace.push(['callback', returned]);
            return Object.is(returned, left);
          }
          return Reflect.apply(everyDescriptor.value, this, [callback, ...args]);
        } });
        return { value: sidecar(split([0.4, 0.6])), retained: () => retained,
          restore() { Object.defineProperty(Number, 'isFinite', finiteDescriptor); Object.defineProperty(Array.prototype, 'every', everyDescriptor); } };
      }, input => {
        const value = operation === 'validate'
          ? api === wasm ? wasm.diffValidateSidecarValue(input.value, true) : oracle.validateLineageSidecar(input.value)
          : api === wasm ? wasm.diffCreateSidecarValue(input.value, true) : oracle.createLineageSidecar(input.value);
        if (globalThis.gc) for (let i = 0; i < 3; i++) globalThis.gc();
        const returned = input.retained()(0.6);
        assert.ok(Object.is(returned, left));
        return { value, returned };
      });
      const expected = execute(oracle);
      const actual = execute(wasm);
      sameObservation(expected, actual);
      if (operation === 'validate') assert.deepEqual(actual.value.value, []);
      else assert.deepEqual(actual.value.value.entries[0].shares, [0.4, 0.6]);
    }
  }
});

test('raw live validation respects an own custom every without coercing its callback input (#8042, R134-03)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const oracle = await currentMainOracle(context); if (!oracle) return;
  const sentinel = { failure: 'non-number callback must short circuit' };
  const make = trace => {
    const descriptor = Object.getOwnPropertyDescriptor(Number, 'isFinite');
    Object.defineProperty(Number, 'isFinite', { configurable: true, get() { throw sentinel; } });
    const shares = [0.4, 0.6];
    shares.every = callback => {
      for (const value of ['0.4', true, null, undefined, 0n, Symbol('share'), new Number(0.4)]) {
        const returned = callback(value); assert.equal(returned, false); trace.push(typeof value);
      }
      return 'accepted by custom every';
    };
    return { value: sidecar(split(shares)), restore() { Object.defineProperty(Number, 'isFinite', descriptor); } };
  };
  const expected = observe(make, input => oracle.validateLineageSidecar(input.value));
  const actual = observe(make, input => wasm.diffValidateSidecarValue(input.value, true));
  sameObservation(expected, actual);
  assert.deepEqual(actual.value, []);
});
