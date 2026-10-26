/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { engine, currentMainOracle, split, rekey, row, observe, sameObservation } from './diff-host-helpers.mjs';

test('raw live WASM largest-share accepts exactly current-main evidence (#8042, #8131, #8084)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const cases = [
    ['missing', undefined, []], ['null', null, []], ['empty', [], []],
    ['mismatch', [0.4], []], ['NaN', [NaN, 0.6], []],
    ['+Infinity', [0.4, Infinity], []], ['-Infinity', [-Infinity, 0.6], []],
    ['negative', [-0.1, 0.6], []], ['tie', [0.5, 0.5], []], ['zero tie', [0, -0], []],
    ['valid', [0.4, 0.6], ['b']], ['unnormalized', [2, 6], ['b']],
    ['zero', [-0, 1], ['b']], ['first', [1, 0], ['a']],
    // These literal holes distinguish missing shares from explicit undefined (#8042).
    // eslint-disable-next-line no-sparse-arrays
    ['first hole', [, 0.6], ['a']], ['last hole', [0.4, ,], ['a']],
    ['all holes', new Array(2), ['a']],
  ];
  const primitiveSentinel = { failure: 'must not coerce' };
  const boxed = { [Symbol.toPrimitive]() { throw primitiveSentinel; } };
  for (const value of ['0.4', true, null, undefined, 0n, Symbol('share'), new Number(0.4), boxed]) {
    cases.push([`non-number ${typeof value}`, [value, 0.6], []]);
  }
  // The inherited index must start as a genuine own-property hole (#8042).
  // eslint-disable-next-line no-sparse-arrays
  const inherited = [, 0.6];
  Object.setPrototypeOf(inherited, Object.create(Array.prototype, { 0: { value: 0.4 } }));
  cases.push(['inherited index', inherited, ['b']]);
  const overridden = [NaN, 0.6];
  overridden.every = () => 'accepted by custom every';
  cases.push(['custom every retains original ranking', overridden, ['a']]);
  for (const [name, shares, successors] of cases) {
    const entry = split(shares);
    assert.deepEqual(rekey(wasm, entry), row(successors), name);
    assert.deepEqual(rekey(wasm, entry, ['source'], 'copy-to-all'), row(['a', 'b']), `${name}: copy-to-all`);
    assert.deepEqual(rekey(wasm, entry, ['source'], 'orphan-on-split'), row([]), `${name}: orphan-on-split`);
  }
  assert.deepEqual(rekey(wasm, split([], [])), row([]), 'empty heads and evidence');
  const entry = split([NaN, 0.6]);
  assert.deepEqual(wasm.diffRekeyByLineage(['source', 'gone', 'same'], [entry, split([0.4, 0.6])], ['gone'], 'largest-share'), [
    ...row([]), { key: 'gone', successors: [], orphan: true },
    { key: 'same', successors: ['same'], relation: 'unchanged', orphan: false },
  ], 'first entry, deleted omission and unchanged passthrough');
});

test('raw live WASM share reads and custom every follow built current-main TS (#8042, #8131)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const oracle = await currentMainOracle(context); if (!oracle) return;
  for (const mode of ['normal', 'changing', 'every-falsy', 'every-truthy', 'empty', 'mismatch', 'sparse', 'inherited']) {
    const make = trace => {
      let reads = 0;
      // The sparse branch exercises native every() hole skipping (#8042).
      // eslint-disable-next-line no-sparse-arrays
      const values = mode === 'sparse' ? [, 0.6] : mode === 'empty' ? [] : mode === 'mismatch' ? [0.4] : [0.4, 0.6];
      if (mode === 'inherited') {
        delete values[0];
        Object.setPrototypeOf(values, Object.create(Array.prototype, { 0: { get() { trace.push('inherited:0'); return 0.4; } } }));
      }
      if (mode.startsWith('every-')) values.every = function (callback) {
        trace.push('custom:every'); assert.equal(this, shares);
        trace.push(`predicate:${callback(NaN)}`);
        return mode === 'every-truthy' ? {} : 0;
      };
      const shares = new Proxy(values, { get(target, key, receiver) {
        trace.push(`shares:${String(key)}`);
        return Reflect.get(target, key, receiver);
      } });
      return { entry: { base: ['source'], relation: 'split', get shares() {
        trace.push(`entry:shares:${++reads}`);
        return mode === 'changing' && reads === 3 ? { length: 1 } : shares;
      }, get head() { trace.push('entry:head'); return ['a', 'b']; } } };
    };
    const expected = observe(make, input => oracle.rekeyByLineage(['source'], [input.entry], 'largest-share'));
    const actual = observe(make, input => rekey(wasm, input.entry));
    sameObservation(expected, actual);
    if (['empty', 'mismatch'].includes(mode)) assert.ok(!actual.trace.includes('shares:every'), mode);
    if (mode === 'every-falsy') assert.ok(!actual.trace.includes('shares:filter'));
  }
});

test('raw live WASM noncoercive finite predicate and >= preserve host short circuits (#8042, #8131)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const oracle = await currentMainOracle(context); if (!oracle) return;
  const sentinel = { failure: 'predicate or relational operator' };
  for (const mode of ['finite-false', 'finite-get-throw', 'finite-throw', 'finite-truthy', 'coercion-throw', 'symbol-throw']) {
    const make = trace => {
      const descriptor = Object.getOwnPropertyDescriptor(Number, 'isFinite');
      const value = mode === 'symbol-throw' ? Symbol('share') : { [Symbol.toPrimitive](hint) {
        trace.push(`coerce:${hint}`);
        if (mode === 'coercion-throw') throw sentinel;
        return 0.4;
      } };
      Object.defineProperty(Number, 'isFinite', { configurable: true, value(item) {
        trace.push(`finite:${item === value ? 'object' : item}`);
        assert.equal(this, Number);
        if (mode === 'finite-throw') throw sentinel;
        return mode === 'finite-false' ? 0 : 'truthy';
      } });
      if (mode === 'finite-get-throw') Object.defineProperty(Number, 'isFinite', { configurable: true, get() {
        trace.push('finite:get'); throw sentinel;
      } });
      return { entry: split([value, 0.6]), restore() { Object.defineProperty(Number, 'isFinite', descriptor); } };
    };
    const expected = observe(make, input => oracle.rekeyByLineage(['source'], [input.entry], 'largest-share'));
    const actual = observe(make, input => rekey(wasm, input.entry));
    // TypeErrors have independent identity; user-thrown values must be identical.
    if (mode === 'symbol-throw') {
      assert.ok(expected.error instanceof TypeError);
      assert.ok(actual.error instanceof TypeError);
      assert.deepEqual(actual.trace, expected.trace);
    } else sameObservation(expected, actual);
    if (mode === 'finite-false') assert.deepEqual(actual.trace, ['finite:object']);
    if (mode.endsWith('-throw') && mode !== 'symbol-throw') assert.equal(actual.error, sentinel);
    assert.deepEqual(rekey(wasm, split([0.4, 0.6])), row(['b']), 'usable after caught predicate/relational failure');
  }
});

test('raw live WASM closes key iterator on each share observation throw (#8042, #8131)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const oracle = await currentMainOracle(context); if (!oracle) return;
  const sentinel = { failure: 'share observation' };
  for (const stage of ['shares', 'head', 'length', 'every-get', 'every-call', 'index', 'filter-get', 'filter-call']) {
    const make = trace => {
      const values = [0.4, 0.6];
      if (stage === 'every-call') values.every = () => { trace.push('throw:every-call'); throw sentinel; };
      if (stage === 'filter-call') values.filter = () => { trace.push('throw:filter-call'); throw sentinel; };
      const shares = new Proxy(values, { get(target, key, receiver) {
        if ((stage === 'length' && key === 'length') || (stage === 'every-get' && key === 'every')
          || (stage === 'filter-get' && key === 'filter') || (stage === 'index' && key === '0')) {
          trace.push(`throw:${stage}`); throw sentinel;
        }
        return Reflect.get(target, key, receiver);
      } });
      return { entry: { base: ['source'], relation: 'split', get shares() {
        if (stage === 'shares') { trace.push('throw:shares'); throw sentinel; } return shares;
      }, get head() { if (stage === 'head') { trace.push('throw:head'); throw sentinel; } return ['a', 'b']; } },
      keys: (function* () { try { trace.push('keys:next'); yield 'source'; trace.push('unexpected'); } finally { trace.push('keys:close'); } })() };
    };
    const expected = observe(make, input => oracle.rekeyByLineage(input.keys, [input.entry], 'largest-share'));
    const actual = observe(make, input => rekey(wasm, input.entry, input.keys));
    sameObservation(expected, actual);
    assert.equal(actual.error, sentinel, stage);
    assert.equal(actual.trace.at(-1), 'keys:close', stage);
    assert.deepEqual(rekey(wasm, split([0.4, 0.6])), row(['b']));
  }
});

test('raw live WASM every callbacks survive return, throw, GC and reentry (#8042, #8131)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const oracle = await currentMainOracle(context); if (!oracle) return;
  const sentinel = { failure: 'retained callback' };
  for (const api of [
    { run: (entry, policy = 'largest-share') => oracle.rekeyByLineage(['source'], [entry], policy) },
    { run: (entry, policy = 'largest-share') => rekey(wasm, entry, ['source'], policy) },
  ]) {
    for (const throws of [false, true]) {
      let retained;
      const shares = [0.4, 0.6];
      shares.every = callback => {
        retained = callback;
        assert.equal(callback(NaN), false);
        assert.deepEqual(api.run(split([0, 1])), row(['b']), 'reenter active operation');
        if (throws) throw sentinel;
        return true;
      };
      if (throws) assert.throws(() => api.run(split(shares)), error => error === sentinel);
      else assert.deepEqual(api.run(split(shares)), row(['b']));
      // Parent qualification runs this file with --expose-gc as well as the
      // ordinary root test graph; GC is not claimed when this hook is absent.
      if (globalThis.gc) for (let i = 0; i < 3; i++) globalThis.gc();
      for (const [value, expected] of [[NaN, false], [Infinity, false], [-1, false], [0, true], [2, true], ['2', false], [Symbol('v'), false]]) {
        assert.equal(retained(value), expected);
      }
      const descriptor = Object.getOwnPropertyDescriptor(Number, 'isFinite');
      try {
        Object.defineProperty(Number, 'isFinite', { configurable: true, value() {
          assert.deepEqual(api.run(split([0, 1]), 'copy-to-all'), row(['a', 'b']));
          throw sentinel;
        } });
        assert.throws(() => retained(0), error => error === sentinel);
      } finally { Object.defineProperty(Number, 'isFinite', descriptor); }
      assert.equal(retained(0), true, 'retained callback recovers after caught host throw');
      assert.deepEqual(api.run(split([0.4, 0.6])), row(['b']));
    }
  }
});
