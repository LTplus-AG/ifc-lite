/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { useViewerStore } from './index.js';
import type { FederatedModel } from './types.js';

function model(id: string, idOffset: number, maxExpressId: number): FederatedModel {
  return { id, name: id, visible: true, idOffset, maxExpressId } as unknown as FederatedModel;
}

/**
 * The one deliberate behaviour change in the teardown-seam refactor, pinned.
 *
 * `removeModel` used to gate `selectedModelId` behind the entity-ref checks, so
 * removing a model that was selected in the hierarchy with NO entity selected
 * under it left `selectedModelId` naming a model that no longer exists. The
 * resync purge (`purgeStaleEntityState`) already cleared it unconditionally, so
 * the two paths disagreed. Unifying them took the purge's reading.
 *
 * Every existing fixture sets `selectedEntity` to the removed model as well, so
 * the old gate covers those too and deleting the clause leaves them all green
 * (measured: 1105 tests under src/store + src/lib/sources). This is the case
 * that separates the two readings, and nothing else exercises it.
 */
describe('removeModel clears selectedModelId when only the hierarchy selection names the model', () => {
  it('drops a dangling selectedModelId with no entity selected under it', () => {
    useViewerStore.setState({
      models: new Map([
        ['A', model('A', 0, 100)],
        ['B', model('B', 1000, 1100)],
      ]),
      activeModelId: 'B',
      // The discriminating fixture: A is selected in the hierarchy, and NOTHING
      // else names it. Every entity-ref channel is empty or points elsewhere.
      selectedModelId: 'A',
      selectedEntity: null,
      selectedEntities: [],
      selectedEntitiesSet: new Set<string>(),
      activeStorey: null,
      selectedEntityIds: new Set<number>(),
      hiddenEntities: new Set<number>(),
    });

    useViewerStore.getState().removeModel('A');

    const after = useViewerStore.getState();
    assert.strictEqual(
      after.selectedModelId,
      null,
      'selectedModelId must not survive the removal of the model it names, even when no entity ref does',
    );
  });
});
