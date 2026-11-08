/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9202: Top of walls is how high a storey's walls reach above its floor,
 * whatever frame a wall's own placement hangs from.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { MODEL_ID, RAISED_STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { asRef, createStyleEntityReader } from '../../../../../../packages/create/src/in-store/style-entity-reader';
import { topOfWalls } from './top-of-walls.js';

describe('topOfWalls (#9202)', () => {
  it('measures a wall placed in world coordinates from its storey, not from the world', async () => {
    await seedModelingSession({ raisedStorey: true });
    const added = useViewerStore.getState().addWall(MODEL_ID, RAISED_STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
    assert.ok('expressId' in added, 'error' in added ? added.error : '');
    const top = () => topOfWalls(useViewerStore.getState(), MODEL_ID, RAISED_STOREY);
    assert.ok(Math.abs(top() - 3) < 1e-9, `drawn on the storey, 3 m up its floor: ${top()}`);

    // As some exporters write it: the wall's placement hangs from the world, at the storey's 3 m.
    const target = modelEditTarget(useViewerStore.getState(), MODEL_ID)!;
    const read = createStyleEntityReader(target.dataStore, target.editor);
    const placement = asRef(read(added.expressId)!.attributes[5])!;
    const point = asRef(read(asRef(read(placement)!.attributes[1])!)!.attributes[0])!;
    target.editor.setPositionalAttribute(placement, 0, null);
    target.editor.setPositionalAttribute(point, 0, [0, 0, 3]);
    assert.ok(Math.abs(top() - 3) < 1e-9, `still 3 m above its floor, not 6: ${top()}`);
  });

  it('falls back to the reader\'s height, not an error, when the storey placement tilts', async () => {
    await seedModelingSession({ raisedStorey: true });
    const added = useViewerStore.getState().addWall(MODEL_ID, RAISED_STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
    assert.ok('expressId' in added, 'error' in added ? added.error : '');
    const target = modelEditTarget(useViewerStore.getState(), MODEL_ID)!;
    const read = createStyleEntityReader(target.dataStore, target.editor);
    // The storey's axis placement turned off the vertical.
    const axis = asRef(read(asRef(read(RAISED_STOREY)!.attributes[5])!)!.attributes[1])!;
    const tilted = target.editor.addEntity('IfcDirection', [[0, 0.5, 0.866025403784]]).expressId;
    target.editor.setPositionalAttribute(axis, 1, `#${tilted}`);
    const top = topOfWalls(useViewerStore.getState(), MODEL_ID, RAISED_STOREY);
    assert.ok(Math.abs(top - 3) < 1e-9, `the reader's own top: ${top}`);
  });

  it('keeps the reader\'s own start height for a wall placed off its storey', async () => {
    await seedModelingSession({ raisedStorey: true });
    const added = useViewerStore.getState().addWall(MODEL_ID, RAISED_STOREY, { Start: [0, 0, 1], End: [4, 0, 1], Thickness: 0.2, Height: 3 });
    assert.ok('expressId' in added, 'error' in added ? added.error : '');
    const top = topOfWalls(useViewerStore.getState(), MODEL_ID, RAISED_STOREY);
    assert.ok(Math.abs(top - 4) < 1e-9, `a wall starting 1 m up its floor reaches 4 m: ${top}`);
  });
});
