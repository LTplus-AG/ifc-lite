/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { engine, currentMainOracle, split, rekey, row, observe, sameObservation } from './diff-host-helpers.mjs';

test('raw WASM every preserves falsy predicate operands across custom methods (#8042, R134-02)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const oracle = await currentMainOracle(context); if (!oracle) return;
  for (const left of [false, 0, -0, 0n, null, undefined, '', NaN]) {
    for (const mode of ['builtin', 'inspect-value', 'force-falsy', 'force-truthy']) {
      const make = trace => {
        const descriptor = Object.getOwnPropertyDescriptor(Number, 'isFinite');
        Object.defineProperty(Number, 'isFinite', { configurable: true, value(share) {
          trace.push(['finite', share]); return left;
        } });
        const shares = [0.4, 0.6];
        if (mode !== 'builtin') shares.every = callback => {
          const actual = callback(0.4);
          trace.push(['callback', actual]);
          if (mode === 'inspect-value') return Object.is(actual, left);
          return mode === 'force-truthy' ? {} : 0;
        };
        return { entry: split(shares), restore() { Object.defineProperty(Number, 'isFinite', descriptor); } };
      };
      const expected = observe(make, input => oracle.rekeyByLineage(['source'], [input.entry], 'largest-share'));
      const actual = observe(make, input => rekey(wasm, input.entry));
      sameObservation(expected, actual);
      assert.deepEqual(actual.value, row(['inspect-value', 'force-truthy'].includes(mode) ? ['b'] : []));
    }
  }
});

test('raw WASM retained every returns original falsy values after return/throw/GC (#8042, R134-02)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const oracle = await currentMainOracle(context); if (!oracle) return;
  const sentinel = { failure: 'retained value callback' };
  for (const run of [
    (entry, policy = 'largest-share') => oracle.rekeyByLineage(['source'], [entry], policy),
    (entry, policy = 'largest-share') => rekey(wasm, entry, ['source'], policy),
  ]) {
    for (const left of [0, -0, 0n, null, undefined, '', NaN]) {
      for (const throws of [false, true]) {
        const descriptor = Object.getOwnPropertyDescriptor(Number, 'isFinite');
        try {
          Object.defineProperty(Number, 'isFinite', { configurable: true, value: () => left });
          let retained;
          const shares = [0.4, 0.6];
          shares.every = callback => { retained = callback; if (throws) throw sentinel; return true; };
          if (throws) assert.throws(() => run(split(shares)), error => error === sentinel);
          else assert.deepEqual(run(split(shares)), row(['b']));
          if (globalThis.gc) for (let i = 0; i < 3; i++) globalThis.gc();
          assert.ok(Object.is(retained(0.4), left), 'including retained callback .returns 0');
          assert.ok(Object.is(retained(-1), left), 'falsy finite result prevents >=');
          Object.defineProperty(Number, 'isFinite', { configurable: true, value: () => true });
          assert.equal(retained(0.4), true);
          assert.equal(retained(-1), false);
          Object.defineProperty(Number, 'isFinite', { configurable: true, value() {
            assert.deepEqual(run(split([0, 1]), 'copy-to-all'), row(['a', 'b']));
            throw sentinel;
          } });
          assert.throws(() => retained(0.4), error => error === sentinel);
        } finally { Object.defineProperty(Number, 'isFinite', descriptor); }
        assert.deepEqual(run(split([0.4, 0.6])), row(['b']));
      }
    }
  }
});

test('raw WASM retained filter keeps JS context, dynamic getters and reentry (#8042, R134 resource review)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const oracle = await currentMainOracle(context); if (!oracle) return;
  const sentinel = { failure: 'retained filter' };
  for (const run of [
    entry => oracle.rekeyByLineage(['source'], [entry], 'largest-share'),
    entry => rekey(wasm, entry),
  ]) {
    for (const throws of [false, true]) {
      let retained;
      let failGetter = false;
      let reenter = false;
      let reentries = 0;
      const shares = [0.4, 0.6];
      let current = shares;
      const entry = { base: ['source'], head: ['a', 'b'], relation: 'split', get shares() {
        if (failGetter) throw sentinel;
        if (reenter) { reentries++; assert.deepEqual(run(split([0, 1])), row(['b'])); }
        return current;
      } };
      shares.filter = function (callback) {
        this.saved = callback; retained = callback;
        assert.equal(callback(0.6), true);
        assert.deepEqual(run(split([0, 1])), row(['b']), 'reenter while filter is active');
        if (throws) throw sentinel;
        return Array.prototype.filter.call(this, callback);
      };
      if (throws) assert.throws(() => run(entry), error => error === sentinel);
      else assert.deepEqual(run(entry), row(['b']));
      if (globalThis.gc) for (let i = 0; i < 3; i++) globalThis.gc();
      current = [0.1, 0.9]; reenter = true;
      assert.equal(shares.saved(0.9), true, 'retained callback reads current entry.shares');
      assert.equal(retained(0.6), false);
      assert.equal(reentries, 2);
      failGetter = true;
      assert.throws(() => retained(0.9), error => error === sentinel);
      failGetter = false; reenter = false;
      assert.equal(retained(0.9), true, 'usable after later caught getter failure');
      assert.deepEqual(run(split([0.4, 0.6])), row(['b']));
      // This covers survival, not post-release reclamation. Parent measures
      // closure/externref release using the existing decode-leak harness.
    }
  }
});
