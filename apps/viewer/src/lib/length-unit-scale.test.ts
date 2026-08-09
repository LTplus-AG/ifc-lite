/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { IfcDataStore } from '@ifc-lite/parser';
import { getModelLengthUnitScale } from './length-unit-scale.js';

/**
 * Build a stub IfcDataStore with just the fields
 * `getModelLengthUnitScale` reads. Other fields are typed as `unknown` so
 * the cast doesn't pollute production code with test shims (mirrors the
 * pattern in `level-offsets.test.ts`).
 */
function makeStore(fields: {
  lengthUnitScale?: number;
  source?: Uint8Array;
  entityIndex?: { byId: { get(id: number): unknown }; byType: Map<string, number[]> };
}): IfcDataStore {
  return fields as unknown as IfcDataStore;
}

// entityIndex with no IFCPROJECT entries — `extractLengthUnitScale` returns
// its documented default of 1.0 without needing a real STEP buffer.
const emptyEntityIndex = { byId: { get: () => undefined }, byType: new Map<string, number[]>() };

describe('getModelLengthUnitScale', () => {
  it('returns 1 for a null/undefined data store', () => {
    assert.strictEqual(getModelLengthUnitScale(null), 1);
    assert.strictEqual(getModelLengthUnitScale(undefined), 1);
  });

  it('uses dataStore.lengthUnitScale directly when it is a positive finite number', () => {
    const store = makeStore({ lengthUnitScale: 0.001 });
    assert.strictEqual(getModelLengthUnitScale(store), 0.001);
  });

  it('falls back to 1 when lengthUnitScale is invalid and there is no source buffer to extract from', () => {
    const store = makeStore({ lengthUnitScale: NaN });
    assert.strictEqual(getModelLengthUnitScale(store), 1);
  });

  it('treats a non-positive lengthUnitScale as invalid (boundary: 0 and negative both reject)', () => {
    assert.strictEqual(getModelLengthUnitScale(makeStore({ lengthUnitScale: 0 })), 1);
    assert.strictEqual(getModelLengthUnitScale(makeStore({ lengthUnitScale: -5 })), 1);
  });

  it('falls back to extraction (and its 1.0 default with no IFCPROJECT) when lengthUnitScale is missing', () => {
    const store = makeStore({
      source: new Uint8Array([1, 2, 3]),
      entityIndex: emptyEntityIndex,
    });
    assert.strictEqual(getModelLengthUnitScale(store), 1);
  });

  it('memoises per data store — a later mutation of lengthUnitScale is not re-read', () => {
    const store = makeStore({ lengthUnitScale: 0.01 });
    assert.strictEqual(getModelLengthUnitScale(store), 0.01);
    // Mutate after the first (cached) read.
    (store as unknown as { lengthUnitScale: number }).lengthUnitScale = 1000;
    assert.strictEqual(getModelLengthUnitScale(store), 0.01, 'expected the cached value, not the mutated one');
  });

  it('caches per-instance — a second, distinct store with the same shape is read independently', () => {
    const storeA = makeStore({ lengthUnitScale: 0.001 });
    const storeB = makeStore({ lengthUnitScale: 1 });
    assert.strictEqual(getModelLengthUnitScale(storeA), 0.001);
    assert.strictEqual(getModelLengthUnitScale(storeB), 1);
  });
});
