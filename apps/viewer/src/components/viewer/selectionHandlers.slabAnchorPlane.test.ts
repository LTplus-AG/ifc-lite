/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4932 follow-up (Codex review, P2): the split tool's slab two-click cut
 * raycasts the FIRST click (the anchor) against `slabFootprint.storeyElevation`
 * directly, but the SECOND click (the cut point, `selectionHandlers.ts` around
 * line 140) goes through `resolveSlabFloorY`, which — after the #4932 fix —
 * adds the model's vertical placement translation. On a slab moved vertically,
 * that left the two clicks raycasting against DIFFERENT floor-plane heights:
 * under an oblique camera a wrong plane height shifts where the ray lands in
 * X/Z too, not just Y, so the anchor and the cut point would disagree even for
 * two clicks at the exact same screen position.
 *
 * This test drives the real two-click flow through `handleSelectionClick`
 * with an OBLIQUE unprojection ray (so plane-height drift is actually
 * observable in the resulting X, the coordinate that survives into the IFC
 * point) and the SAME screen position for both clicks. Before the fix the two
 * clicks' IFC-frame points disagree by exactly the plane-height mismatch;
 * after the fix, with both planes now placement-aware, they agree.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { handleSelectionClick } from './selectionHandlers.js';
import type { PlacementState } from '@/lib/model-placement/state.js';
import type { Translation } from '@/lib/model-placement/translation.js';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';

const MODEL_ID = 'm-slab-anchor';
const EXPRESS_ID = 55;
const STOREY_ID = 3;
const RAW_ELEVATION = 10;

/** A model moved vertically ONLY (+5 in Z) — isolates the plane-height bug
 * from the already-covered horizontal translation/rotation inversion. */
const PLACEMENT: PlacementState = {
  frameKey: null,
  placements: new Map([[MODEL_ID, {
    translation: [0, 0, 5] as Translation,
    rotation: { angle: 0, pivot: [0, 0, 0] as Translation },
    locked: false,
  }]]),
  preview: null,
  undo: [],
  redo: [],
  revision: 1,
};

const FOOTPRINT = {
  footprint: [[0, 0], [10, 0], [10, 10], [0, 10]] as [number, number][],
  elementType: 'IfcSlab' as const,
  storeyElevation: RAW_ELEVATION,
  thickness: 0.3,
};

/** An oblique camera ray, fixed regardless of screen position, so the ONLY
 * thing that can move the raycast's X between the two clicks is a different
 * floor-plane height (`t = (planeY - origin.y) / direction.y`, `x = origin.x
 * + direction.x * t`) — the exact quantity the two click sites disagreed on. */
function fakeCtx(): MouseHandlerContext {
  return {
    canvas: document.createElement('canvas'),
    renderer: {
      getCamera: () => ({
        unprojectToRay: () => ({ origin: { x: 0, y: 100, z: 0 }, direction: { x: 0.5, y: -1, z: 0 } }),
      }),
      getCanvas: () => document.createElement('canvas'),
    },
    mouseState: { isDragging: false, isPanning: false, lastX: 0, lastY: 0, button: 0, startX: 0, startY: 0, didDrag: false },
    activeToolRef: { current: 'split' },
  } as unknown as MouseHandlerContext;
}

describe("split-tool anchor and cut clicks raycast the same floor plane (#4932 follow-up)", () => {
  const original = useViewerStore.getState();
  let cutCall: { cutA: [number, number]; cutB: [number, number] } | null;

  beforeEach(() => {
    cutCall = null;
    useViewerStore.setState({
      modelPlacement: PLACEMENT,
      splitTargetModelId: MODEL_ID,
      splitTargetExpressId: EXPRESS_ID,
      splitMode: 'aiming',
      splitHoverDistance: null,
      slabCutAnchor: null,
      slabCutFootprint: null,
      slabCutStoreyElevation: null,
      models: new Map([[MODEL_ID, {
        ifcDataStore: {
          spatialHierarchy: {
            elementToStorey: new Map([[EXPRESS_ID, STOREY_ID]]),
            storeyElevations: new Map([[STOREY_ID, RAW_ELEVATION]]),
          },
        },
      }]]) as unknown as ReturnType<typeof useViewerStore.getState>['models'],
      readSlabFootprint: () => FOOTPRINT,
      splitSlabByLine: (_modelId: string, _expressId: number, cutA: [number, number], cutB: [number, number]) => {
        cutCall = { cutA, cutB };
        return { ok: true, left: { expressId: 1, globalId: 101 }, right: { expressId: 2, globalId: 102 } };
      },
      setSelectedEntityId: () => {},
      clearSplitHover: () => {},
    } as Partial<ReturnType<typeof useViewerStore.getState>>);
  });

  afterEach(() => {
    useViewerStore.setState({
      modelPlacement: original.modelPlacement,
      splitTargetModelId: original.splitTargetModelId,
      splitTargetExpressId: original.splitTargetExpressId,
      splitMode: original.splitMode,
      splitHoverDistance: original.splitHoverDistance,
      slabCutAnchor: original.slabCutAnchor,
      slabCutFootprint: original.slabCutFootprint,
      slabCutStoreyElevation: original.slabCutStoreyElevation,
      models: original.models,
      readSlabFootprint: original.readSlabFootprint,
      splitSlabByLine: original.splitSlabByLine,
      setSelectedEntityId: original.setSelectedEntityId,
      clearSplitHover: original.clearSplitHover,
    } as Partial<ReturnType<typeof useViewerStore.getState>>);
  });

  it('two clicks at the identical screen position produce the identical IFC-frame point', async () => {
    const ctx = fakeCtx();
    const clickEvent = { clientX: 40, clientY: 40 } as MouseEvent;

    await handleSelectionClick(ctx, clickEvent); // first click — latches the anchor
    const anchorAfterFirst = useViewerStore.getState().slabCutAnchor;
    assert.ok(anchorAfterFirst, 'first click should have latched a slab-cut anchor');

    await handleSelectionClick(ctx, clickEvent); // second click, SAME screen position — commits the cut

    assert.ok(cutCall, 'splitSlabByLine was not called');
    // The anchor (cutA, from the first click) and the cut point (cutB, from
    // the second click) came from the SAME screen position through the SAME
    // oblique ray. If both clicks raycast the same floor plane, they must
    // agree exactly. Pre-fix, the first click's un-placed plane sat 5m below
    // the second click's placed plane, and the oblique ray put point.x 2.5m
    // apart between the two (0.5 * 5m elevation delta) — this assertion
    // catches that with a tight epsilon, not a coincidence-sized one.
    assert.ok(Math.abs(cutCall!.cutA[0] - cutCall!.cutB[0]) < 1e-9,
      `cutA=${cutCall!.cutA} cutB=${cutCall!.cutB} disagree — the two clicks raycast different floor planes`);
    assert.ok(Math.abs(cutCall!.cutA[1] - cutCall!.cutB[1]) < 1e-9,
      `cutA=${cutCall!.cutA} cutB=${cutCall!.cutB} disagree — the two clicks raycast different floor planes`);
  });
});
