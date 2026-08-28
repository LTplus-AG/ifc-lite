/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `clearAllModels()` (the `all-models-cleared` teardown scope) clears the
 * global-id half of selection state (`selectedEntityId`, `selectedEntityIds`,
 * `selectedStoreys`) but left the `EntityRef`-keyed half (`selectedEntity`,
 * `selectedEntities`, `selectedEntitiesSet`, `selectedModelId`,
 * `activeStorey`) untouched.
 *
 * `resetViewerState()` clears both halves, so the asymmetry only shows on a
 * path that calls `clearAllModels()` without `resetViewerState()` —
 * `GeoreferencingPanel.tsx`'s `reloadModelsForAlignment`, same shape as
 * `clearAllModels-overlay-stale.test.ts` (#2854) and
 * `removeModel-compare-stale.test.ts`.
 *
 * #3348.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { useViewerStore } from './index.js';
import type { FederatedModel } from './types.js';

function model(id: string, idOffset: number, maxExpressId: number): FederatedModel {
  return { id, name: id, visible: true, idOffset, maxExpressId } as unknown as FederatedModel;
}

describe('clearAllModels drops the EntityRef-keyed half of selection, not just the global-id half', () => {
  it('leaves nothing pointing at a removed model after clearAllModels()', () => {
    useViewerStore.setState({
      models: new Map([['A', model('A', 0, 100)]]),
      activeModelId: 'A',
    });

    // A distinctly non-default, clearly-stale ref: model 'A' is the only
    // model in the store and gets removed by clearAllModels(), so if any of
    // this survives it can only be because the field was never cleared.
    useViewerStore.getState().setSelectedEntity({ modelId: 'A', expressId: 42 });
    useViewerStore.getState().setSelectedEntities([{ modelId: 'A', expressId: 42 }]);
    useViewerStore.getState().addEntityToSelection({ modelId: 'A', expressId: 42 });
    useViewerStore.setState({ selectedModelId: 'A' });
    useViewerStore.getState().setActiveStorey({ modelId: 'A', expressId: 44 });

    const before = useViewerStore.getState();
    assert.notStrictEqual(before.selectedEntity, null, 'precondition: an entity is selected');
    assert.strictEqual(before.selectedEntities.length, 1, 'precondition: selectedEntities is populated');
    assert.strictEqual(before.selectedEntitiesSet.size, 1, 'precondition: selectedEntitiesSet is populated');
    assert.strictEqual(before.selectedModelId, 'A', 'precondition: selectedModelId is set');
    assert.notStrictEqual(before.activeStorey, null, 'precondition: activeStorey is set');

    useViewerStore.getState().clearAllModels();

    const after = useViewerStore.getState();
    assert.strictEqual(after.selectedEntity, null, 'selectedEntity must not point at a removed model');
    assert.deepStrictEqual(after.selectedEntities, [], 'selectedEntities must not list a removed model');
    assert.strictEqual(after.selectedEntitiesSet.size, 0, 'selectedEntitiesSet must not key a removed model');
    assert.strictEqual(after.selectedModelId, null, 'selectedModelId must not name a removed model');
    assert.strictEqual(after.activeStorey, null, 'activeStorey must not point into a removed model');
  });
});
