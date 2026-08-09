/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { collectFilterResultGlobalIds, type FilterResultLike } from './isolate-filter-result.js';

/** Fake `toGlobalId` mirroring `toGlobalIdFromModels`'s per-model offset. */
function fakeToGlobalId(offsets: Record<string, number>) {
  return (modelId: string, expressId: number) => expressId + (offsets[modelId] ?? 0);
}

describe('collectFilterResultGlobalIds', () => {
  test('resolves single-model rows through the default model id', () => {
    const result: FilterResultLike = {
      columns: ['express_id', 'global_id', 'name', 'type'],
      rows: [
        [10, 'g10', 'Wall A', 'IfcWall'],
        [20, 'g20', 'Wall B', 'IfcWall'],
      ],
    };
    const ids = collectFilterResultGlobalIds(result, 'modelA', fakeToGlobalId({}));
    assert.deepEqual(ids, [10, 20], 'both rows must resolve, in row order');
  });

  test('routes federated rows through their own model_id column, not the default', () => {
    const result: FilterResultLike = {
      columns: ['express_id', 'global_id', 'name', 'type', 'model_id'],
      rows: [
        [1, 'g1', 'Wall A', 'IfcWall', 'modelA'],
        [1, 'g1', 'Wall X', 'IfcWall', 'modelB'],
      ],
    };
    // Same local express_id (1) in two models must NOT collapse to one
    // global id — the whole point of federation is that they diverge.
    const ids = collectFilterResultGlobalIds(result, 'modelA', fakeToGlobalId({ modelA: 0, modelB: 1000 }));
    assert.deepEqual(
      ids,
      [1, 1001],
      'each row must resolve through ITS OWN model_id, not the default model',
    );
  });

  test('deduplicates repeated (model, express_id) pairs', () => {
    const result: FilterResultLike = {
      columns: ['express_id', 'global_id', 'name', 'type'],
      rows: [
        [10, 'g10', 'Wall A', 'IfcWall'],
        [10, 'g10', 'Wall A', 'IfcWall'],
        [20, 'g20', 'Wall B', 'IfcWall'],
      ],
    };
    const ids = collectFilterResultGlobalIds(result, 'modelA', fakeToGlobalId({}));
    assert.deepEqual(ids, [10, 20], 'a repeated row must not duplicate the isolated set');
  });

  test('skips rows with a non-positive or non-numeric express_id', () => {
    const result: FilterResultLike = {
      columns: ['express_id', 'global_id', 'name', 'type'],
      rows: [
        [0, 'g0', 'Bogus', 'IfcWall'],
        [-5, 'g-5', 'Bogus', 'IfcWall'],
        ['not-a-number', 'g?', 'Bogus', 'IfcWall'],
        [30, 'g30', 'Wall C', 'IfcWall'],
      ],
    };
    const ids = collectFilterResultGlobalIds(result, 'modelA', fakeToGlobalId({}));
    assert.deepEqual(ids, [30], 'only the one valid row should survive');
  });

  test('returns empty when the result has no express_id column', () => {
    const result: FilterResultLike = { columns: ['name', 'type'], rows: [['Wall A', 'IfcWall']] };
    const ids = collectFilterResultGlobalIds(result, 'modelA', fakeToGlobalId({}));
    assert.deepEqual(ids, [], 'a result without express_id must yield no ids, not throw');
  });

  test('returns empty for an empty result', () => {
    const result: FilterResultLike = { columns: ['express_id'], rows: [] };
    const ids = collectFilterResultGlobalIds(result, 'modelA', fakeToGlobalId({}));
    assert.deepEqual(ids, [], 'zero rows must yield zero ids');
  });
});
