/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9848: on a blank model nothing registers a mutation view before the first
 * element. Markup restore used to register one for every active model; since
 * #9621 it skips sources without markup, so `addWall` found no view and the
 * Wall tool reverted every commit. The write actions now create the view on
 * first use; inspection (a dry run) still registers nothing (#8947).
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { createBlankIfcFile } from '@/utils/createBlankIfc';
import { MODEL_ID, seedModelingSession } from '@/test/modeling-session-fixture';

let storey = 0;

/** The state `loadFile` leaves after "Start blank": the model, and no view. */
async function seedBlankModel(): Promise<void> {
  await seedModelingSession({ step: await createBlankIfcFile().text() });
  useViewerStore.setState({ mutationViews: new Map(), storeEditors: new Map() });
  const dataStore = useViewerStore.getState().models.get(MODEL_ID)?.ifcDataStore;
  const storeys = dataStore?.entityIndex.byType.get('IFCBUILDINGSTOREY') ?? [];
  assert.equal(storeys.length, 1, 'the blank file has exactly one storey');
  storey = storeys[0];
}

const s = () => useViewerStore.getState();
const created = (result: { expressId: number } | { error: string }): number => {
  assert.ok('expressId' in result, 'error' in result ? result.error : '');
  return result.expressId;
};

describe('drawing on a blank model with no registered mutation view (#9848)', () => {
  beforeEach(seedBlankModel);

  it('a wall, a slab and a beam commit, and the first one registers the view', () => {
    assert.equal(s().getMutationView(MODEL_ID), null, 'precondition: no view, as after a blank load');
    const wall = created(s().addWall(MODEL_ID, storey, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 }));
    const view = s().getMutationView(MODEL_ID);
    assert.ok(view, 'the wall registered the view the rest of the app reads');
    const slab = created(s().addSlab(MODEL_ID, storey, { Position: [0, 0, 0], Width: 4, Depth: 3, Thickness: 0.2 }));
    const beam = created(s().addBeam(MODEL_ID, storey, { Start: [0, 0, 3], End: [4, 0, 3], Width: 0.2, Height: 0.3 }));
    assert.equal(s().getMutationView(MODEL_ID), view, 'later adds reuse the same view');
    assert.deepEqual(view.getNewEntities().map(e => e.expressId).filter(id => [wall, slab, beam].includes(id)).sort(),
      [wall, slab, beam].sort((a, b) => a - b));
    assert.ok(s().dirtyModels.has(MODEL_ID), 'the model shows unsaved changes');
    assert.equal(s().undoStacks.get(MODEL_ID)?.length, 3, 'one undo step per element');
  });

  it('a roof commits on a blank model', () => {
    created(s().addRoof(MODEL_ID, storey, {
      Position: [0, 0, 3], Width: 10, Depth: 8, Thickness: 0.25, EdgeSlopes: Array(4).fill(Math.PI / 6),
    }));
    assert.ok(s().getMutationView(MODEL_ID));
  });

  it('a dry-run room detection inspects without registering a view', () => {
    const result = s().generateSpacesFromWalls(MODEL_ID, storey, { dryRun: true });
    assert.ok(!('error' in result), 'error' in result ? result.error : '');
    assert.equal(s().getMutationView(MODEL_ID), null);
  });
});
