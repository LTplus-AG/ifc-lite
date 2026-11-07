/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diffModels, type DiffOptions, type EntityFingerprint } from '@ifc-lite/diff';
import { preparePairHandles, type BuiltPair } from '@/hooks/compare/comparePairCache';
import { comparePreparedPair } from './run-comparison';
import type { CompareRef } from './buildFingerprints';

// Stated invariant: resident comparison returns precisely the prior viewer's
// diffModels(JS-stripped arrays) rows, flags and union exclusions (#8042 A2).
const strip = (side: EntityFingerprint<CompareRef>[]) => side.map(row =>
  typeof row.geometryHash === 'string' && row.geometryHash.startsWith('p:')
    ? { ...row, geometryHash: undefined } : row);
const wire = (value: unknown) => JSON.stringify(value, (_key, item: unknown) =>
  item instanceof Map ? [...item] : typeof item === 'bigint' ? String(item) : item);

describe('viewer resident pair parity (#8042 A2)', () => {
  for (const [name, meshA, meshB] of [
    ['mesh symmetric', true, true], ['placement symmetric', false, false],
    ['mixed A', true, false], ['mixed B', false, true],
  ] as const) {
    it(`${name}: preserves rows across all scopes, exclusions, matching, and disposal`, () => {
      const row = (key: string, id: number, modelId: string, hash: bigint | string): EntityFingerprint<CompareRef> => ({
        key, ifcType: key === 'reclass' && modelId === 'B' ? 'IfcSlab' : 'IfcWall',
        dataHash: 'same', geometryHash: hash, ref: { modelId, localId: id, globalId: id },
        aabb: { min: [0, 0, 0], max: [1, 1, 1] },
      });
      const base = [row('same', 1, 'A', meshA ? 1n : 'p:one'), row('reclass', 2, 'A', 'p:one'),
        row('old', 3, 'A', meshA ? 3n : 'p:three')];
      const head = [row('same', 11, 'B', meshB ? 2n : 'p:two'), row('reclass', 12, 'B', 'p:two'),
        row('new', 13, 'B', meshB ? 3n : 'p:three')];
      const built: BuiltPair = { baseStore: undefined, headStore: undefined, baseModelId: 'A', headModelId: 'B', baseName: 'A', headName: 'B',
        base, head, keyProperty: undefined, contentVersion: 0, mutationVersion: 0,
        comparedStores: new Map(), duplicateAuthoredKeys: new Map(), ...preparePairHandles(base, head) };
      const mixed = meshA !== meshB;
      try {
        for (const scope of ['both', 'data', 'geometry'] as const) {
          for (const matchByContent of [false, true]) {
            for (const excludedTypes of [[], [' ifcslab ']]) {
              const result = comparePreparedPair(built, { scope, matchByContent, excludedTypes });
              const opts: DiffOptions = { scope, matchUnpairedByContent: matchByContent,
                excludeTypes: excludedTypes, detectSplitMerge: true, detectSuccessors: true, keyAliases: new Map() };
              const previous = diffModels(mixed ? strip(base) : base, mixed ? strip(head) : head, opts);
              assert.deepEqual(result.diff, previous);
              assert.equal(wire(result.diff), wire(previous), 'byte-identical serialized rows');
              assert.equal(result.geometryUnavailable, !meshA || !meshB);
              assert.equal(result.placementOnlyGeometry, !meshA && !meshB);
              assert.deepEqual([...result.excludedHiddenIds], excludedTypes.length ? [2, 12] : []);
            }
          }
        }
        const final = comparePreparedPair(built, { scope: 'both', excludedTypes: [], matchByContent: true });
        const serialized = wire(final.diff);
        built.dispose(); built.dispose();
        assert.equal(wire(final.diff), serialized, 'results remain intact after native release');
        for (const entry of final.diff.entries) {
          assert.equal(final.diff.byKey.get(entry.key), entry);
          if (entry.base) assert.equal(Object.isFrozen(entry.base), true);
        }
        assert.throws(() => comparePreparedPair(built, { scope: 'both', excludedTypes: [], matchByContent: true }), /disposed/);
      } finally { built.dispose(); }
    });
  }
});
