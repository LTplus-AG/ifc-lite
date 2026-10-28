/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { engine, currentMainOracle, sameObservation } from './diff-host-helpers.mjs';
import { deletedFilterObservation } from './diff-host-deleted-filter-cases.mjs';

test('raw live deleted.filter retains its Set context across success/throw/reentry (#8042, R141)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const oracle = await currentMainOracle(context); if (!oracle) return;
  const sentinel = { failure: 'retained deleted.filter' };
  for (const throws of [false, true]) {
    const expected = deletedFilterObservation(value => oracle.validateLineageSidecar(value), throws, sentinel);
    const actual = deletedFilterObservation(value => wasm.diffValidateSidecarValue(value, true), throws, sentinel);
    sameObservation(expected, actual);
    assert.deepEqual(actual.trace, [
      ['base.every', true], ['filter.get', true], ['filter.call', true, 1],
      ['active', true, false, false, false], ['active.reentry', true, false],
      ['retained', true, false, false, false], ['mutated', true, false, false, false],
      ['later.reentry', true, false], ['later.throw', true, false],
      ['recovered', true, false, false, false],
    ]);
  }
  // Survival observations here do not measure post-release reclamation. The
  // separate decode-leak-test feature harness requires real GC and finalizers.
});
