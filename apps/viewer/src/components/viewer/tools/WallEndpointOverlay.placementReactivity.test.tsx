/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4932 follow-up (Macroscope review on #4953, WallEndpointOverlay.tsx:67):
 * none of the store fields WallEndpointOverlay subscribed to (editEnabled,
 * activeTool, selectedEntity, mutationVersion, ...) change when a model is
 * repositioned. So if a wall is selected and its endpoint handles are
 * showing, moving or rotating that wall's model (Reposition panel) would
 * not re-render this component, even though the wall itself moves
 * immediately (`useModelPlacementSync`, a separate subscription). The
 * handles would sit at their last-rendered screen position until some
 * UNRELATED update forced a re-render.
 *
 * Traced whether this corrupts a drag, not just the display: `startDrag`
 * and `screenToFloorIfc` both call `placementOf()` / `rendererPointToIfc
 * StoreyLocal`, which read `useViewerStore.getState()` FRESH at drag time,
 * not from a stale render-time closure. So a drag's WRITTEN result was
 * always correct for whatever screen point the user actually clicked —
 * this was a rendering-lag bug (the handle drawn in the wrong place),
 * not a data-corruption bug (the same click producing the wrong model-frame
 * point). Real and worth fixing on its own: a user grabbing a
 * visually-stale handle drags from/to a screen position that no longer
 * corresponds to where they think the wall is.
 *
 * This test renders the real component, changes ONLY `modelPlacement`
 * (every other subscribed field is left untouched), and asserts the
 * overlay re-projects the handle at the NEW placed position without any
 * other trigger.
 */

import '@/test/setup-dom.js';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { render, cleanup } from '@/test/render.js';
import { WallEndpointOverlay } from './WallEndpointOverlay.js';
import type { PlacementState } from '@/lib/model-placement/state.js';
import type { Translation } from '@/lib/model-placement/translation.js';

const MODEL_ID = 'm-wall-reactivity';
const EXPRESS_ID = 3;

const IDENTITY_PLACEMENT: PlacementState = {
  frameKey: null,
  placements: new Map(),
  preview: null,
  undo: [],
  redo: [],
  revision: 0,
};

/** Translated +10 workspace X only, no rotation, to keep the expected
 * screen shift simple to assert. */
const MOVED_PLACEMENT: PlacementState = {
  frameKey: null,
  placements: new Map([[MODEL_ID, {
    translation: [10, 0, 0] as Translation,
    rotation: { angle: 0, pivot: [0, 0, 0] as Translation },
    locked: false,
  }]]),
  preview: null,
  undo: [],
  redo: [],
  revision: 1,
};

describe('WallEndpointOverlay re-projects its handles when modelPlacement changes alone (#4932 follow-up)', () => {
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

  it('the start handle projects at the repositioned point after modelPlacement alone changes', () => {
    const projected: Array<{ x: number; y: number; z: number }> = [];
    useViewerStore.setState({
      modelPlacement: IDENTITY_PLACEMENT,
      editEnabled: true,
      activeTool: 'select',
      selectedEntity: { modelId: MODEL_ID, expressId: EXPRESS_ID },
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
    assert.ok(projected.length >= 2, `expected an initial projection, got ${projected.length}`);
    const beforeStart = projected[0];
    // Identity placement: the un-placed IFC point [2, 3, 0] renders directly
    // (engineering -> render axis swap only).
    assert.ok(Math.abs(beforeStart.x - 2) < 1e-9 && Math.abs(beforeStart.z - (-3)) < 1e-9,
      `expected the un-repositioned start handle, got ${JSON.stringify(beforeStart)}`);
    projected.length = 0;

    // Change ONLY modelPlacement — none of the overlay's other subscribed
    // fields (editEnabled, activeTool, selectedEntity, mutationVersion,
    // cameraCallbacks, models) move.
    act(() => {
      useViewerStore.setState({ modelPlacement: MOVED_PLACEMENT } as Partial<ReturnType<typeof useViewerStore.getState>>);
    });

    assert.ok(projected.length >= 2,
      `expected the overlay to re-render and re-project after modelPlacement alone changed, got ${projected.length} projections`);
    const afterStart = projected[0];
    // Forward-placed: [2, 3, 0] + translation [10, 0, 0] = [12, 3, 0].
    assert.ok(Math.abs(afterStart.x - 12) < 1e-9,
      `expected the handle to follow the reposition (x=12), got ${JSON.stringify(afterStart)} — stale handle position`);
  });
});
