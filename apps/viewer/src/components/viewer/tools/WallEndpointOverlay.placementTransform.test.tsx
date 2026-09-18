/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4932 follow-up (review note on PR #4953): the PICK direction
 * (`rendererPointToIfcStoreyLocal`) was fixed to invert a model's
 * reposition placement, but `WallEndpointOverlay`'s DRAW direction
 * (`ifcStoreyLocalToRenderer`, used to place a selected wall's resize
 * handles) was left as a bare axis swap. Pre-#4953 both directions were
 * symmetrically naive, so a handle rendered off the wall but a drag at
 * least stayed self-consistent. Post-#4953 alone that broke: the handle
 * still rendered off the wall, but grabbing and dragging it computed the
 * new endpoint in the CORRECT model frame — a resize drag could jump the
 * wall on its first frame on a moved/rotated model.
 *
 * Drives the real, already-exported `WallEndpointOverlay` component (not
 * a newly-exported internal) through the store, and captures the world
 * point it hands `cameraCallbacks.projectToScreen` for the wall's start
 * endpoint — the actual screen-placement seam. Reimplements the forward
 * placement transform inline rather than importing it, so — per the
 * repo's revert-oracle convention — this test exercises the fix only
 * through symbols that existed pre-fix.
 */

import '@/test/setup-dom.js';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { render, cleanup } from '@/test/render.js';
import { WallEndpointOverlay } from './WallEndpointOverlay.js';
import type { PlacementState } from '@/lib/model-placement/state.js';
import type { Translation } from '@/lib/model-placement/translation.js';

const MODEL_ID = 'm-wall-endpoint';

/** A model moved +10/+5 (workspace X/Y) and turned 90° CCW about the
 * origin — same fixture shape as `selectionHandlers.placementPick.test.ts`. */
const PLACEMENT: PlacementState = {
  realignedFrameKey: null,
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

describe('WallEndpointOverlay draw position undoes the model reposition placement (#4932)', () => {
  const original = useViewerStore.getState();

  afterEach(() => {
    cleanup();
    useViewerStore.setState({
      modelPlacement: original.modelPlacement,
      editEnabled: original.editEnabled,
      activeTool: original.activeTool,
      selectedEntity: original.selectedEntity,
      cameraCallbacks: original.cameraCallbacks,
      readWallEndpoints: original.readWallEndpoints,
      resizeWall: original.resizeWall,
      mutationVersion: original.mutationVersion,
      models: original.models,
    } as Partial<ReturnType<typeof useViewerStore.getState>>);
  });

  it("projects the start handle at the wall's actual (repositioned) location, not its un-repositioned twin", () => {
    const projected: Array<{ x: number; y: number; z: number }> = [];
    useViewerStore.setState({
      modelPlacement: PLACEMENT,
      editEnabled: true,
      activeTool: 'select',
      selectedEntity: { modelId: MODEL_ID, expressId: 7 },
      models: new Map(),
      readWallEndpoints: () => ({ start: [2, 3, 0], end: [6, 1, 0] }),
      resizeWall: () => ({ ok: true }),
      mutationVersion: 1,
      cameraCallbacks: {
        projectToScreen: (p: { x: number; y: number; z: number }) => { projected.push(p); return { x: 0, y: 0 }; },
        getViewpoint: () => null,
        unprojectToFloor: undefined,
      },
    } as unknown as Partial<ReturnType<typeof useViewerStore.getState>>);

    render(<WallEndpointOverlay />);

    assert.ok(projected.length >= 2, `expected both endpoints projected, got ${projected.length}`);
    const [startWorld] = projected;
    // Forward: IFC [2,3,0] turned 90° CCW about the origin -> [-3,2,0];
    // translated by [10,5,0] -> [7,7,0]. Engineering→render: [x,z,-y].
    assert.ok(Math.abs(startWorld.x - 7) < 1e-9, `x: got ${startWorld.x}`);
    assert.ok(Math.abs(startWorld.y - 0) < 1e-9, `y: got ${startWorld.y}`);
    assert.ok(Math.abs(startWorld.z - (-7)) < 1e-9, `z: got ${startWorld.z}`);
  });
});
