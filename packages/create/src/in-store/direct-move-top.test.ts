/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, it } from 'vitest';
import { IfcCreator } from '../ifc-creator.js';
import { addOrdinaryElementInStore } from './ordinary-element.js';
import { addSlabToStore } from './slab.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { resolvePlacementChain, translateProduct } from './edit/placement-core.js';
import { readStoreyInventory } from './storey/storey-model.js';
import { setTopConstraintInStore } from './storey/storey-top-constraint.js';
import { readAttachedTop } from './storey/storey-attached.js';
import { parse, session } from './__test__/storey-fixtures.oracle.js';

for (const kind of ['column', 'beam', 'member'] as const) {
  it.each([false, true])(`#9352 ${kind} refits its slab-bound top on a direct move (reopen=%s)`, async reopen => {
    const creator = new IfcCreator({ Name: 'Direct move' });
    creator.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
    let s = session(await parse(creator.toIfc().content));
    const storey = readStoreyInventory(s.store, s.view).storeys[0].expressId;
    const anchor = resolveSpatialAnchor(s.store, storey, s.view);
    const slab = addSlabToStore(s.editor, anchor, { Position: [0, 0, 4], Width: 10, Depth: 8, Thickness: .3, ExtrudedDirection: [0, 0, -1] }).slabId;
    const id = addOrdinaryElementInStore(s.editor, draft => resolveSpatialAnchor(s.store, storey, draft.getMutationView()),
      kind === 'column'
        ? { kind, params: { Position: [1, 2, 0], Width: .3, Depth: .3, Height: 3 } }
        : { kind, params: { Start: [1, 2, 0], End: [1, 2, 3], Width: .3, Height: .3 } });
    setTopConstraintInStore(s.store, s.editor, id, { kind: 'slab', slabId: slab });
    if (reopen) s = session(await parse(s.text()));
    const result = translateProduct(s.store, s.view, s.editor, id, [1, 0, 1]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const top = readAttachedTop({ dataStore: s.store, view: s.view, editor: s.editor }, id, kind === 'column' ? 'column' : 'linear');
    expect(top).toBeCloseTo(kind === 'column' ? 2.7 : 3.7, 8);
    expect(result.remesh ?? []).toContain(id);
    const reopened = session(await parse(s.text()));
    const after = readAttachedTop({ dataStore: reopened.store, view: reopened.view, editor: reopened.editor }, id, kind === 'column' ? 'column' : 'linear');
    expect(after).toBeCloseTo(top!, 8);
  });
}

for (const kind of ['beam', 'member'] as const) {
  it.each([false, true])(`#9352 a moved level ${kind} returns its final refitted coordinates (reopen=%s)`, async reopen => {
    const creator = new IfcCreator({ Name: 'Move result' });
    creator.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
    let s = session(await parse(creator.toIfc().content));
    const home = readStoreyInventory(s.store, s.view).storeys[0].expressId;
    const anchor = resolveSpatialAnchor(s.store, home, s.view);
    const slab = addSlabToStore(s.editor, anchor, { Position: [0, 0, 4], Width: 10, Depth: 8, Thickness: .3, ExtrudedDirection: [0, 0, -1] }).slabId;
    const id = addOrdinaryElementInStore(s.editor, draft => resolveSpatialAnchor(s.store, home, draft.getMutationView()),
      { kind, params: { Start: [1, 2, 2], End: [5, 2, 2], Width: .3, Height: .3 } });
    setTopConstraintInStore(s.store, s.editor, id, { kind: 'slab', slabId: slab });
    if (reopen) s = session(await parse(s.text()));
    const before = resolvePlacementChain(s.store, s.view, s.editor, id)!.coordinates;
    const originalTop = s.worldZ(id) + .15;
    const result = translateProduct(s.store, s.view, s.editor, id, [1, 0, 1]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.oldCoordinates).toEqual(before);
    // The whole level section is lifted back under the slab, cancelling Z.
    expect(result.newCoordinates).toEqual(resolvePlacementChain(s.store, s.view, s.editor, id)!.coordinates);
    expect(result.newCoordinates[0]).toBeCloseTo(before[0] + 1, 8);
    expect(result.newCoordinates[2]).toBeCloseTo(before[2], 8);
    expect(s.worldZ(id) + .15).toBeCloseTo(originalTop, 8);
    s = session(await parse(s.text()));
    expect(resolvePlacementChain(s.store, s.view, s.editor, id)!.coordinates).toEqual(result.newCoordinates);
    expect(s.worldZ(id) + .15).toBeCloseTo(originalTop, 8);
  });
}
