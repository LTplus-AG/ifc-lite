/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `removeModel` must drop selection state that keys off the removed model,
 * and must NOT touch a federated sibling's.
 *
 * Selection is keyed by `modelId`, so after a removal `models.get(...)`
 * returns undefined for the stale ref: `PropertiesPanel` renders nothing
 * rather than re-resolving, and `activeStorey` stays pinned to a storey in a
 * model that no longer exists (Solo level display, floorplan). Nothing
 * re-resolves it until the user clicks elsewhere.
 *
 * `syncSourceModel`'s `purgeStaleReferences` already does this for the
 * same-modelId resync path; full removal never got the same treatment.
 *
 * These run against the REAL combined store rather than the slice harness in
 * `modelSlice.test.ts`, which stubs `set`/`get` and only wires the
 * mutation/IDS/source-tag cross-slice calls `removeModel` already made — it
 * could not observe selection state at all.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { useViewerStore } from './index.js';
import type { FederatedModel } from './types.js';

function model(id: string, idOffset: number): FederatedModel {
  return { id, name: id, visible: true, idOffset } as unknown as FederatedModel;
}

function seedTwoModelsWithSelection(): void {
  useViewerStore.setState({
    models: new Map([
      ['A', model('A', 0)],
      ['B', model('B', 100000)],
    ]),
    activeModelId: 'A',
    selectedEntity: { modelId: 'A', expressId: 42 },
    activeStorey: { modelId: 'A', expressId: 7 },
    selectedEntities: [
      { modelId: 'A', expressId: 42 },
      { modelId: 'B', expressId: 99 },
    ],
    selectedEntitiesSet: new Set(['A:42', 'B:99']),
    selectedModelId: 'A',
  });
}

describe('removeModel purges selection state for the removed model', () => {
  it('clears refs pointing at the removed model', () => {
    seedTwoModelsWithSelection();
    useViewerStore.getState().removeModel('A');
    const s = useViewerStore.getState();

    assert.strictEqual(s.selectedEntity, null, 'selectedEntity must not survive its model');
    assert.strictEqual(s.activeStorey, null, 'activeStorey must not survive its model');
    assert.strictEqual(s.selectedModelId, null);
  });

  it('preserves a federated sibling\'s selection', () => {
    seedTwoModelsWithSelection();
    useViewerStore.getState().removeModel('A');
    const s = useViewerStore.getState();

    // The half that makes this a purge rather than a reset: clearing
    // wholesale would be just as green against the assertions above while
    // silently dropping every other loaded model's selection.
    assert.deepStrictEqual(s.selectedEntities, [{ modelId: 'B', expressId: 99 }]);
    assert.deepStrictEqual([...s.selectedEntitiesSet], ['B:99']);
  });

  it('leaves selection untouched when an unrelated model is removed', () => {
    seedTwoModelsWithSelection();
    useViewerStore.getState().removeModel('B');
    const s = useViewerStore.getState();

    assert.deepStrictEqual(s.selectedEntity, { modelId: 'A', expressId: 42 });
    assert.deepStrictEqual(s.activeStorey, { modelId: 'A', expressId: 7 });
    assert.deepStrictEqual([...s.selectedEntitiesSet], ['A:42']);
    assert.strictEqual(s.selectedModelId, 'A');
  });
});
