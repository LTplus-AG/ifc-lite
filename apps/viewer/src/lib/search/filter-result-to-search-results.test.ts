/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure-helper coverage for the Filter tab -> vim-cycle bridge. Before this
 * helper existed, running `n`/`N` after clicking a Filter-tab row was
 * impossible: `enterVimCycle` requires `SearchResult[]`, and the Filter
 * tab only ever produced `SearchFilterResult` (`unknown[][]` rows +
 * `columns: string[]`) — nothing converted between the two shapes. See the
 * "does not exist" assertions below and PR #2396's "Deliberately not done"
 * note (`SearchModal.filter.tsx`'s row click never called `enterVimCycle`).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filterResultToSearchResults } from './filter-result-to-search-results.js';

describe('filterResultToSearchResults', () => {
  it('converts single-model rows (no model_id column) using the fallback modelId', () => {
    const result = {
      columns: ['express_id', 'global_id', 'name', 'type'],
      rows: [
        [101, 'GUID-A', 'Wall A', 'IfcWall'],
        [102, 'GUID-B', 'Wall B', 'IfcWall'],
      ],
    };
    const out = filterResultToSearchResults(result, 'model-1');
    assert.equal(out.length, 2);
    assert.deepEqual(
      out.map((r) => [r.modelId, r.expressId, r.name, r.typeName, r.globalId]),
      [
        ['model-1', 101, 'Wall A', 'IfcWall', 'GUID-A'],
        ['model-1', 102, 'Wall B', 'IfcWall', 'GUID-B'],
      ],
    );
  });

  it('uses each row\'s own model_id in a federated (multi-model) result, ignoring the fallback', () => {
    const result = {
      columns: ['express_id', 'global_id', 'name', 'type', 'model_id'],
      rows: [
        [1, 'GUID-A', 'Door A', 'IfcDoor', 'model-a'],
        [2, 'GUID-B', 'Door B', 'IfcDoor', 'model-b'],
      ],
    };
    const out = filterResultToSearchResults(result, 'model-a');
    assert.deepEqual(out.map((r) => r.modelId), ['model-a', 'model-b']);
  });

  it('skips a row with no usable express id (non-numeric, zero, or negative)', () => {
    const result = {
      columns: ['express_id', 'global_id', 'name', 'type'],
      rows: [
        ['not-a-number', 'GUID-A', 'Bad', 'IfcWall'],
        [0, 'GUID-B', 'Zero', 'IfcWall'],
        [-5, 'GUID-C', 'Negative', 'IfcWall'],
        [7, 'GUID-D', 'Good', 'IfcWall'],
      ],
    };
    const out = filterResultToSearchResults(result, 'model-1');
    assert.equal(out.length, 1);
    assert.equal(out[0].expressId, 7);
  });

  it('falls back to fallbackModelId for a multi-model row whose model_id cell is missing/non-string — same rule SearchModalFilter.handleRowClick already uses for a single click', () => {
    const result = {
      columns: ['express_id', 'global_id', 'name', 'type', 'model_id'],
      rows: [
        [1, 'GUID-A', 'A', 'IfcWall', 'model-a'],
        [2, 'GUID-B', 'B', 'IfcWall', null],
      ],
    };
    const out = filterResultToSearchResults(result, 'active-model');
    assert.deepEqual(out.map((r) => r.modelId), ['model-a', 'active-model']);
  });

  it('returns an empty array when the result has no recognised selection-key column', () => {
    const result = { columns: ['name', 'type'], rows: [['Wall A', 'IfcWall']] };
    assert.deepEqual(filterResultToSearchResults(result, 'model-1'), []);
  });

  it('returns an empty array (never throws) with no fallback modelId and no model_id column', () => {
    const result = {
      columns: ['express_id', 'global_id', 'name', 'type'],
      rows: [[101, 'GUID-A', 'Wall A', 'IfcWall']],
    };
    assert.deepEqual(filterResultToSearchResults(result, null), []);
  });

  it('recognises entity_id as a selection-key column alias', () => {
    const result = {
      columns: ['entity_id', 'name'],
      rows: [[55, 'Slab A']],
    };
    const out = filterResultToSearchResults(result, 'model-1');
    assert.equal(out.length, 1);
    assert.equal(out[0].expressId, 55);
  });

  it('produces entries directly consumable by enterVimCycle / applySelection: only modelId + expressId matter for stepping', () => {
    const result = {
      columns: ['express_id', 'global_id', 'name', 'type'],
      rows: [[1, 'G1', 'A', 'IfcWall'], [2, 'G2', 'B', 'IfcWall'], [3, 'G3', 'C', 'IfcWall']],
    };
    const out = filterResultToSearchResults(result, 'm');
    // Simulates SearchInline's applySelection, which reads only these two fields.
    const stepped = out.map((r) => ({ modelId: r.modelId, expressId: r.expressId }));
    assert.deepEqual(stepped, [
      { modelId: 'm', expressId: 1 },
      { modelId: 'm', expressId: 2 },
      { modelId: 'm', expressId: 3 },
    ]);
  });
});
