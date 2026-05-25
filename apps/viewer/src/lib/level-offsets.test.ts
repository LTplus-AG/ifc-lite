/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  computeStoreyOffsets,
  diffStoreyOffsets,
  entitiesInStorey,
  buildEntityTranslations,
} from './level-offsets.js';

/**
 * Build a stub IfcDataStore with just the spatialHierarchy bits
 * the offset helpers read. Other fields are typed as `unknown` so
 * the cast doesn't pollute production code with test shims.
 */
function makeStore(
  storeyElevations: Map<number, number>,
  elementToStorey?: Map<number, number>,
): Parameters<typeof computeStoreyOffsets>[0] {
  return {
    spatialHierarchy: {
      storeyElevations,
      elementToStorey: elementToStorey ?? new Map(),
    },
  } as unknown as Parameters<typeof computeStoreyOffsets>[0];
}

describe('level-offsets', () => {
  describe('computeStoreyOffsets', () => {
    it('returns empty for a missing data store', () => {
      assert.strictEqual(computeStoreyOffsets(undefined, 4).size, 0);
    });

    it('returns empty when gap is zero', () => {
      const store = makeStore(new Map([[1, 0], [2, 3]]));
      assert.strictEqual(computeStoreyOffsets(store, 0).size, 0);
    });

    it('lifts higher storeys to index * gap', () => {
      // Three storeys at elevations 0, 3, 6; with gap=5 they
      // should land at 0, 5, 10 (offsets 0, +2, +4).
      const store = makeStore(new Map([[10, 0], [20, 3], [30, 6]]));
      const offsets = computeStoreyOffsets(store, 5);
      assert.strictEqual(offsets.get(10), undefined); // zero — omitted
      assert.strictEqual(offsets.get(20), 2);
      assert.strictEqual(offsets.get(30), 4);
    });

    it('handles basement-style negative elevations', () => {
      // Storeys at -3, 0, 3 with gap=4 → indices 0,1,2 → targets
      // -3, 1, 5. Offsets 0, +1, +2.
      const store = makeStore(new Map([[1, -3], [2, 0], [3, 3]]));
      const offsets = computeStoreyOffsets(store, 4);
      assert.strictEqual(offsets.get(1), undefined);
      assert.strictEqual(offsets.get(2), 1);
      assert.strictEqual(offsets.get(3), 2);
    });

    it('preserves elevation ordering with equal gaps', () => {
      // Storeys with non-uniform original spacing should still
      // become uniformly spaced under Exploded.
      const store = makeStore(new Map([[1, 0], [2, 4], [3, 5], [4, 12]]));
      const offsets = computeStoreyOffsets(store, 3);
      // Targets: 0, 3, 6, 9. Deltas: 0, -1, +1, -3.
      assert.strictEqual(offsets.get(1), undefined);
      assert.strictEqual(offsets.get(2), -1);
      assert.strictEqual(offsets.get(3), 1);
      assert.strictEqual(offsets.get(4), -3);
    });
  });

  describe('diffStoreyOffsets', () => {
    it('returns the per-storey delta between target and previous', () => {
      const target = new Map([[1, 2], [2, 5]]);
      const previous = new Map([[1, 1], [2, 6]]);
      const diff = diffStoreyOffsets(target, previous);
      assert.strictEqual(diff.get(1), 1); // 2 - 1
      assert.strictEqual(diff.get(2), -1); // 5 - 6
    });

    it('treats missing target as revert to zero', () => {
      const target = new Map<number, number>();
      const previous = new Map([[1, 3], [2, 4]]);
      const diff = diffStoreyOffsets(target, previous);
      assert.strictEqual(diff.get(1), -3);
      assert.strictEqual(diff.get(2), -4);
    });

    it('treats new target with no previous as full lift', () => {
      const target = new Map([[1, 5]]);
      const previous = new Map<number, number>();
      const diff = diffStoreyOffsets(target, previous);
      assert.strictEqual(diff.get(1), 5);
    });

    it('omits zero-delta entries', () => {
      const target = new Map([[1, 3]]);
      const previous = new Map([[1, 3]]);
      const diff = diffStoreyOffsets(target, previous);
      assert.strictEqual(diff.size, 0);
    });
  });

  describe('entitiesInStorey', () => {
    it('returns globalIds of every entity in the storey', () => {
      const store = makeStore(
        new Map(),
        new Map([
          [100, 1],
          [101, 1],
          [200, 2],
        ]),
      );
      const ids = entitiesInStorey(store, 1, (id) => id + 10000);
      ids.sort();
      assert.deepStrictEqual(ids, [10100, 10101]);
    });

    it('returns empty when the storey has no children', () => {
      const store = makeStore(new Map(), new Map([[100, 2]]));
      assert.deepStrictEqual(entitiesInStorey(store, 1, (id) => id), []);
    });
  });

  describe('buildEntityTranslations', () => {
    it('emits per-entity Y deltas for every entity in an offset-bearing storey', () => {
      const store = makeStore(
        new Map(),
        new Map([
          [100, 1], // storey 1, dy=2
          [101, 1],
          [200, 2], // storey 2, dy=5
          [300, 3], // storey 3, no offset → skipped
        ]),
      );
      const offsets = new Map([[1, 2], [2, 5]]);
      const translations = buildEntityTranslations(store, offsets, (id) => id + 1000);
      assert.deepStrictEqual(translations.get(1100), [0, 2, 0]);
      assert.deepStrictEqual(translations.get(1101), [0, 2, 0]);
      assert.deepStrictEqual(translations.get(1200), [0, 5, 0]);
      assert.strictEqual(translations.get(1300), undefined);
    });

    it('omits zero offsets', () => {
      const store = makeStore(new Map(), new Map([[100, 1]]));
      const offsets = new Map([[1, 0]]);
      assert.strictEqual(buildEntityTranslations(store, offsets, (id) => id).size, 0);
    });
  });
});
