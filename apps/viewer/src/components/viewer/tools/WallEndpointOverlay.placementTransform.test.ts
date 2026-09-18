/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4932 follow-up (review note on PR #4953): `ifcStoreyLocalToRenderer` —
 * the DRAW direction used to place a wall's resize handles on screen — was
 * left as a bare axis swap when the PICK direction (`rendererPointToIfcStoreyLocal`)
 * was fixed to invert a model's reposition placement. That asymmetry meant
 * a wall's resize handles rendered off the actual wall on a moved/rotated
 * model, AND (once the pick side alone was fixed) a drag would jump the
 * wall on the first frame, because the handle's start position and the
 * drag's computed new position disagreed about which frame they were in.
 *
 * This test drives `ifcStoreyLocalToRenderer` — reimplementing the forward
 * transform inline rather than importing `modelPointToWorkspacePoint`, so
 * it exercises the fix through a symbol (`ifcStoreyLocalToRenderer` itself)
 * that already existed pre-fix, per the repo's revert-oracle convention.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { ifcStoreyLocalToRenderer } from './WallEndpointOverlay.js';
import type { PlacementState } from '@/lib/model-placement/state.js';
import type { Translation } from '@/lib/model-placement/translation.js';

const MODEL_ID = 'm-wall-endpoint';

/** A model moved +10/+5 (workspace X/Y) and turned 90° CCW about the
 * origin — same fixture shape as `selectionHandlers.placementPick.test.ts`. */
const PLACEMENT: PlacementState = {
  frameKey: null,
  placements: new Map([[MODEL_ID, {
    translation: [10, 5, 0] as Translation,
    rotation: { angle: Math.PI / 2, pivot: [0, 0, 0] as Translation },
    locked: false,
  }]]),
  preview: null,
  undo: [],
  redo: [],
  revision: 1,
};

describe('WallEndpointOverlay draw transform undoes the model reposition placement (#4932)', () => {
  it('renders a storey-local endpoint at the same point a repositioned pick would recover', () => {
    useViewerStore.setState({ modelPlacement: PLACEMENT } as Partial<ReturnType<typeof useViewerStore.getState>>);
    // Wall endpoint at IFC storey-local [2, 3, 0], storey elevation 4.
    const world = ifcStoreyLocalToRenderer([2, 3, 0], 4, MODEL_ID);
    // Forward: [2,3,4] turned 90° CCW about the origin -> [-3,2,4];
    // translated by [10,5,0] -> [7,7,4]. Engineering->render: [x,z,-y].
    assert.ok(Math.abs(world.x - 7) < 1e-9, `x: got ${world.x}`);
    assert.ok(Math.abs(world.y - 4) < 1e-9, `y: got ${world.y}`);
    assert.ok(Math.abs(world.z - (-7)) < 1e-9, `z: got ${world.z}`);
  });

  it('matches the plain axis swap for an un-repositioned model', () => {
    useViewerStore.setState({
      modelPlacement: { frameKey: null, placements: new Map(), preview: null, undo: [], redo: [], revision: 0 },
    } as Partial<ReturnType<typeof useViewerStore.getState>>);
    const world = ifcStoreyLocalToRenderer([3, 9, 0], 4, 'unplaced');
    assert.deepEqual(world, { x: 3, y: 4, z: -9 });
  });
});
