/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4932: placement clicks and split-cut picks ignored a model's reposition
 * transform (a workspace translation, and — after #4873 — a heading about a
 * pivot). `rendererPointToIfcStoreyLocal` converted a renderer-frame pick
 * straight to IFC storey-local coordinates with a bare axis swap, so on a
 * moved or rotated model the point handed to `addWall` / `splitWallAtDistance`
 * / etc. was the click's un-repositioned twin, not the point the user
 * actually clicked.
 *
 * Both tests build a real workspace point by running a KNOWN model-frame
 * point forward through the model's placement (heading about the pivot,
 * then translation — the same order `useModelPlacementSync`/
 * `ModelRotationBaker` render with) and the pre-existing engineering→render
 * axis swap, feed that renderer-frame point in as the "click", and assert
 * the model-frame point the action receives is the ORIGINAL one — i.e. the
 * pick correctly undid the placement rather than passing the workspace
 * point straight through.
 *
 * The forward transform is reimplemented inline (not imported from
 * `rotation.ts`) so this test exercises the fix through symbols that exist
 * on both sides of a revert — `rotation.ts`'s own new export would not.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { handleSelectionClick, rendererPointToIfcStoreyLocal } from './selectionHandlers.js';
import { toRenderTranslation, type Translation } from '@/lib/model-placement/translation.js';
import type { PlacementState } from '@/lib/model-placement/state.js';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';

const MODEL_ID = 'm-repositioned';

/** A model moved +10/+5 (workspace X/Y) and turned 90° CCW about the origin —
 * a translation AND a heading, matching the issue's "whether a translation
 * … or a heading" wording. */
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

/** Forward placement transform, reimplemented (see file doc) rather than
 * imported from production — heading about the pivot, then translation. */
function placeForward(point: Translation, placement: { translation: Translation; rotation: { angle: number; pivot: Translation } }): Translation {
  const { angle, pivot } = placement.rotation;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const dx = point[0] - pivot[0], dy = point[1] - pivot[1];
  const rotated: Translation = [pivot[0] + dx * cos - dy * sin, pivot[1] + dx * sin + dy * cos, point[2]];
  return [rotated[0] + placement.translation[0], rotated[1] + placement.translation[1], rotated[2] + placement.translation[2]];
}

/** Renderer-frame render point a click on `modelPoint` (model's own IFC
 * frame) would actually land on, given `PLACEMENT`. */
function renderPointFor(modelPoint: Translation): { x: number; y: number; z: number } {
  const workspace = placeForward(modelPoint, PLACEMENT.placements.get(MODEL_ID)!);
  const [x, y, z] = toRenderTranslation(workspace);
  return { x, y, z };
}

describe('placement/split-cut picks undo the model reposition transform (#4932)', () => {
  it('rendererPointToIfcStoreyLocal recovers the model-frame point a workspace pick was placed from', () => {
    useViewerStore.setState({ modelPlacement: PLACEMENT } as Partial<ReturnType<typeof useViewerStore.getState>>);
    const modelPoint: Translation = [4, -2.5, 0];
    const ifc = rendererPointToIfcStoreyLocal(renderPointFor(modelPoint), MODEL_ID);
    assert.ok(Math.abs(ifc[0] - modelPoint[0]) < 1e-9, `x: got ${ifc[0]}, expected ${modelPoint[0]}`);
    assert.ok(Math.abs(ifc[1] - modelPoint[1]) < 1e-9, `y: got ${ifc[1]}, expected ${modelPoint[1]}`);
    assert.equal(ifc[2], 0);
  });

  it('an un-repositioned model (identity placement) is unaffected — the axis swap alone', () => {
    useViewerStore.setState({
      modelPlacement: { realignedFrameKey: null, placements: new Map(), preview: null, undo: [], redo: [], revision: 0 },
    } as Partial<ReturnType<typeof useViewerStore.getState>>);
    const ifc = rendererPointToIfcStoreyLocal({ x: 3, y: 9, z: -4 }, 'unplaced');
    assert.deepEqual(ifc, [3, 4, 0]);
  });
});

describe('placement-tool click: addWall receives model-frame coordinates on a moved+rotated model (#4932)', () => {
  const original = useViewerStore.getState();
  let captured: { modelId: string; storeyId: number; params: { Start: unknown; End: unknown } } | null;

  beforeEach(() => {
    captured = null;
    useViewerStore.setState({
      ...fixtureModels(fixtureModel(MODEL_ID, {
        entities: [{ expressId: 1, type: 'IfcBuildingStorey' }],
      })),
      mutationViews: new Map(),
      modelPlacement: PLACEMENT,
      addElementType: 'wall',
      addElementModelId: MODEL_ID,
      addElementStoreyId: 1,
      addElementWallParams: { Thickness: 0.2, Height: 3 },
      addElementPendingPoints: [],
      addElementHoverPoint: null,
      addWall: (modelId: string, storeyId: number, params: { Start: unknown; End: unknown }) => {
        captured = { modelId, storeyId, params };
        return { expressId: 501 };
      },
    } as Partial<ReturnType<typeof useViewerStore.getState>>);
  });

  afterEach(() => {
    useViewerStore.setState({
      modelPlacement: original.modelPlacement,
      models: original.models,
      activeModelId: original.activeModelId,
      mutationViews: original.mutationViews,
      addElementType: original.addElementType,
      addElementModelId: original.addElementModelId,
      addElementStoreyId: original.addElementStoreyId,
      addElementWallParams: original.addElementWallParams,
      addElementPendingPoints: original.addElementPendingPoints,
      addElementHoverPoint: original.addElementHoverPoint,
      addWall: original.addWall,
    } as Partial<ReturnType<typeof useViewerStore.getState>>);
  });

  it('a two-click wall placement lands at the clicked model-frame points, not their un-repositioned twins', async () => {
    const startModel: Translation = [2, 3, 0];
    const endModel: Translation = [6, 1, 0];
    const clicks = [renderPointFor(startModel), renderPointFor(endModel)];
    let callIndex = 0;
    const ctx = {
      canvas: document.createElement('canvas'),
      renderer: {
        raycastSceneMagnetic: () => ({
          intersection: { point: clicks[callIndex++], expressId: null },
          snapTarget: null,
          edgeLock: { shouldRelease: false, shouldLock: false },
        }),
      },
      mouseState: { isDragging: false, isPanning: false, lastX: 0, lastY: 0, button: 0, startX: 0, startY: 0, didDrag: false },
      activeToolRef: { current: 'addElement' },
      edgeLockStateRef: { current: { edge: null, meshExpressId: null, lockStrength: 0 } },
      snapEnabledRef: { current: false },
      hiddenEntitiesRef: { current: new Set<number>() },
      isolatedEntitiesRef: { current: null },
    } as unknown as MouseHandlerContext;
    const clickEvent = { clientX: 0, clientY: 0 } as MouseEvent;

    await handleSelectionClick(ctx, clickEvent); // start — latched, no dispatch yet
    assert.equal(captured === null, true, 'first click should only latch the start point');
    await handleSelectionClick(ctx, clickEvent); // end — dispatches addWall

    if (!captured) throw new Error('addWall was not called');
    const { Start, End } = captured.params as { Start: [number, number, number]; End: [number, number, number] };
    for (let i = 0; i < 2; i++) {
      assert.ok(Math.abs(Start[i] - startModel[i]) < 1e-9, `Start[${i}]: got ${Start[i]}, expected ${startModel[i]}`);
      assert.ok(Math.abs(End[i] - endModel[i]) < 1e-9, `End[${i}]: got ${End[i]}, expected ${endModel[i]}`);
    }
  });
});
