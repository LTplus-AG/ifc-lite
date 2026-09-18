/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4932 follow-up (Codex review, P1): actually DRAGS an endpoint handle on a
 * wall whose model has been both translated AND rotated, and asserts the
 * IFC-frame endpoint `resizeWall` receives matches what the user visually
 * dragged to — not just that the handle's rendered position looks right
 * (that was `WallEndpointOverlay.placementTransform.test.tsx`, the display
 * side only).
 *
 * Trace, so this test asserts the right thing:
 *   - The drag's floor-plane raycast goes through `cameraCallbacks.
 *     unprojectToFloor` — a plain camera/floor-plane intersection with NO
 *     knowledge of any model or its placement; its result is a genuine
 *     WORKSPACE point. `rendererPointToIfcStoreyLocal` inverting the
 *     model's placement on that result is therefore correct, not a double
 *     transform — Codex's literal claim that the unprojection happens "by
 *     ifcStoreyLocalToRenderer" doesn't match the code: that function is
 *     the separate, display-only draw path and the drag path never calls
 *     it.
 *   - The REAL bug was narrower: the floor-plane HEIGHT the drag raycasts
 *     against (`planeRenderY`, née `storeyElevation`) wasn't placement-aware,
 *     while the height `ifcStoreyLocalToRenderer` draws the handles at now
 *     is. Fixed by deriving both from the same `placementOf()` helper.
 *
 * This test drives the mocked `unprojectToFloor` to return the WORKSPACE
 * point a correctly-placed floor plane and an on-target cursor would
 * actually produce for a chosen model-frame drag destination — i.e. "what
 * the user visually dragged to" — and asserts `resizeWall` is called with
 * that exact model-frame point recovered, plus that the plane height it was
 * asked to unproject against matches the placed (not raw) elevation.
 */

import '@/test/setup-dom.js';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { render, cleanup } from '@/test/render.js';
import { WallEndpointOverlay } from './WallEndpointOverlay.js';
import type { PlacementState } from '@/lib/model-placement/state.js';
import type { Translation } from '@/lib/model-placement/translation.js';

const MODEL_ID = 'm-wall-drag';
const EXPRESS_ID = 9;
const STOREY_ELEVATION = 4;

/** Moved AND rotated — the combination the review asked for. */
const PLACEMENT: PlacementState = {
  frameKey: null,
  placements: new Map([[MODEL_ID, {
    translation: [10, 5, 3] as Translation,
    rotation: { angle: Math.PI / 2, pivot: [0, 0, 0] as Translation },
    locked: false,
  }]]),
  preview: null,
  undo: [],
  redo: [],
  revision: 1,
};

/** Forward placement transform, reimplemented (not imported — see
 * `selectionHandlers.placementPick.test.ts` for why) so this test exercises
 * the fix only through symbols that existed pre-fix. */
function placeForward(point: Translation): Translation {
  const { angle, pivot } = PLACEMENT.placements.get(MODEL_ID)!.rotation;
  const translation = PLACEMENT.placements.get(MODEL_ID)!.translation;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const dx = point[0] - pivot[0], dy = point[1] - pivot[1];
  const rotated: Translation = [pivot[0] + dx * cos - dy * sin, pivot[1] + dx * sin + dy * cos, point[2]];
  return [rotated[0] + translation[0], rotated[1] + translation[1], rotated[2] + translation[2]];
}
function toRender(point: Translation): { x: number; y: number; z: number } {
  return { x: point[0], y: point[2], z: -point[1] };
}

describe('dragging a wall-endpoint handle on a moved+rotated model writes the correct model-frame endpoint (#4932 follow-up)', () => {
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

  it('resizeWall receives the dragged-to point in the model frame, and the plane height matches the placed (not raw) elevation', () => {
    // Where the user visually dragged the START handle to, in the wall's
    // OWN model frame (Z = 0, on the storey floor — same convention
    // `rendererPointToIfcStoreyLocal` returns).
    const draggedToModel: Translation = [4, 8, 0];
    const unprojectHeights: number[] = [];

    let resized: { modelId: string; expressId: number; start: [number, number, number]; end: [number, number, number] } | null = null;
    useViewerStore.setState({
      modelPlacement: PLACEMENT,
      editEnabled: true,
      activeTool: 'select',
      selectedEntity: { modelId: MODEL_ID, expressId: EXPRESS_ID },
      models: new Map([[MODEL_ID, {
        ifcDataStore: {
          spatialHierarchy: {
            elementToStorey: new Map([[EXPRESS_ID, 1]]),
            storeyElevations: new Map([[1, STOREY_ELEVATION]]),
          },
        },
      }]]),
      readWallEndpoints: () => ({ start: [2, 3, 0], end: [6, 1, 0] }),
      resizeWall: (modelId: string, expressId: number, start: [number, number, number], end: [number, number, number]) => {
        resized = { modelId, expressId, start, end };
        return { ok: true };
      },
      mutationVersion: 1,
      cameraCallbacks: {
        projectToScreen: () => ({ x: 100, y: 100 }),
        getViewpoint: () => null,
        unprojectToFloor: (_clientX: number, _clientY: number, worldY: number) => {
          unprojectHeights.push(worldY);
          // The user's cursor is over `draggedToModel` (elevation carried
          // separately, per the wall-endpoint convention): the workspace
          // point a CORRECTLY-placed floor plane and an on-target cursor
          // would produce.
          const withElevation: Translation = [draggedToModel[0], draggedToModel[1], STOREY_ELEVATION];
          return toRender(placeForward(withElevation));
        },
      },
    } as unknown as Partial<ReturnType<typeof useViewerStore.getState>>);

    const container = render(<WallEndpointOverlay />);
    const hitCircles = container.querySelectorAll('circle');
    assert.ok(hitCircles.length >= 2, `expected at least 2 handle circles, got ${hitCircles.length}`);
    const startHitCircle = hitCircles[0]; // first `<g>`'s hit-area circle is the START handle

    startHitCircle.dispatchEvent(new window.PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, clientX: 100, clientY: 100, pointerId: 1,
    }));
    startHitCircle.dispatchEvent(new window.PointerEvent('pointermove', {
      bubbles: true, cancelable: true, clientX: 110, clientY: 90, pointerId: 1,
    }));

    assert.ok(resized, 'resizeWall was not called by the drag');
    const { start, end } = resized!;
    for (let i = 0; i < 2; i++) {
      assert.ok(Math.abs(start[i] - draggedToModel[i]) < 1e-9,
        `start[${i}]: got ${start[i]}, expected ${draggedToModel[i]} — the dragged-to point`);
    }
    assert.deepEqual(end, [6, 1, 0], 'the fixed (non-dragged) endpoint must be untouched');

    // The plane the drag unprojected against must be the PLACED elevation
    // (storey elevation + the model's vertical translation), matching what
    // the handle is drawn at — not the raw, un-placed elevation.
    assert.ok(unprojectHeights.length > 0, 'unprojectToFloor was never called');
    for (const h of unprojectHeights) {
      assert.ok(Math.abs(h - (STOREY_ELEVATION + 3)) < 1e-9, `plane height: got ${h}, expected ${STOREY_ELEVATION + 3}`);
    }
  });
});
