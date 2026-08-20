/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `overlaySlice.overlayLayers` — the P4 overlay-layer registry
 * `useConstructionSequence.ts` writes the 'animation' layer into — is never
 * touched by `removeModel` or `clearAllModels`.
 *
 * Each layer's `hiddenIds` / `colorOverrides` are stored as already-
 * translated GLOBAL ids: `useConstructionSequence.ts` converts local
 * `productExpressIds` via `toGlobalIdFromModels` at REGISTRATION time, not
 * at read time (`store/globalId.ts:21`). So a layer registered before a
 * `clearAllModels()` keeps naming those exact numbers afterward — and
 * `federationRegistry.clear()` (called by `clearAllModels`, unlike
 * `removeModel`'s `unregisterModel` which burns the offset instead of
 * reclaiming it) resets the offset counter to 0, so the very next model
 * registered can be handed the exact offset a stale layer's ids describe.
 *
 * `useConstructionSequence.ts`'s registration effect deps
 * (`[animationEnabled, playbackTime, scheduleData, activeWorkScheduleId,
 * animationSettings]`) exclude `models`, and `scheduleData` is untouched by
 * `clearAllModels` (`scheduleSlice.ts` has no `clearAllModels`/`removeModel`
 * hook). So a PAUSED animation (no `playbackTime` advance to re-trigger the
 * effect) leaves the 'animation' layer registered with its pre-clear ids
 * indefinitely — exactly the reachability gap the task names.
 *
 * `useOverlayCompositor.ts` applies `computeCompositeOverlay()`'s output
 * straight to `hideEntities` / `setPendingColorUpdates` by global id (no
 * re-resolution), so once federated offsets are reused a live entity in the
 * reloaded federation can inherit a hide/colour that was never meant for it.
 *
 * These run against the REAL combined store, same harness shape as
 * `removeModel-compare-stale.test.ts` / `removeModel-lens-stale.test.ts`
 * (#2854), which reproduced the identical `GeoreferencingPanel.tsx`
 * `reloadModelsForAlignment` → `clearAllModels()` (no `resetViewerState()`)
 * → reload shape.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { federationRegistry } from '@ifc-lite/renderer';
import { useViewerStore } from './index.js';
import { fromGlobalIdFromModels } from './globalId.js';
import type { FederatedModel } from './types.js';
import type { OverlayLayer } from './slices/overlaySlice.js';

function model(id: string, idOffset: number, maxExpressId: number): FederatedModel {
  return { id, name: id, visible: true, idOffset, maxExpressId } as unknown as FederatedModel;
}

/** Mirrors what `useConstructionSequence.ts` registers for a PAUSED
 *  animation frame: local product id 42 in model 'B' (offset 1000),
 *  translated to global id 1042 at registration time. */
function seedPausedAnimationLayer(): OverlayLayer {
  return {
    id: 'animation',
    priority: 100,
    hiddenIds: new Set([1042]),
    colorOverrides: new Map([[1042, [1, 0, 0, 1]]]),
  };
}

describe('overlaySlice.overlayLayers survives clearAllModels as a dangling — and, after a georef reload, misresolvable — reference', () => {
  it('clearAllModels drops the animation layer instead of leaving it registered with pre-clear global ids', () => {
    federationRegistry.clear();
    federationRegistry.registerModel('A', 100);
    federationRegistry.registerModel('B', 100);
    useViewerStore.setState({
      models: new Map([
        ['A', model('A', 0, 100)],
        ['B', model('B', 1000, 1100)],
      ]),
      activeModelId: 'A',
    });
    useViewerStore.getState().registerOverlayLayer(seedPausedAnimationLayer());

    useViewerStore.getState().clearAllModels();

    const afterClear = useViewerStore.getState();
    console.log('overlayLayers after clearAllModels:', afterClear.overlayLayers);
    assert.strictEqual(
      afterClear.overlayLayers.size,
      0,
      'clearAllModels must drop every overlay layer — every id any layer describes is stale once every model is gone',
    );
  });

  it('misresolution: a stale animation layer left behind lands its hide+colour on a reloaded, unrelated model\'s LIVE entity', () => {
    // Same repro shape as removeModel-compare-stale.test.ts: clearAllModels()
    // resets the offset counter, so the very first model registered
    // afterward can land on offset 1000 again — the exact number the stale
    // layer's global id 1042 was computed against.
    federationRegistry.clear();
    federationRegistry.registerModel('A', 100);
    federationRegistry.registerModel('B', 100);
    useViewerStore.setState({
      models: new Map([
        ['A', model('A', 0, 100)],
        ['B', model('B', 1000, 1100)],
      ]),
      activeModelId: 'A',
    });
    useViewerStore.getState().registerOverlayLayer(seedPausedAnimationLayer());

    useViewerStore.getState().clearAllModels();

    // Reload: two fresh, UNRELATED models — offset space was reset, so the
    // second one can land on 1000 again, same as `newOffsetC === 0` in
    // removeModel-compare-stale.test.ts.
    const offsetX = federationRegistry.registerModel('X', 999);
    const offsetC = federationRegistry.registerModel('C', 50);
    assert.strictEqual(offsetC, 1000, 'offset space is not burned across a full clear — confirms the hazard is real');
    useViewerStore.getState().addModel(model('X', offsetX, 999));
    useViewerStore.getState().addModel(model('C', offsetC, 50));

    const afterReload = useViewerStore.getState();
    // If the fix did its job the layer is gone and there is nothing left to
    // misresolve. If it did not, the layer (and its stale global id 1042)
    // is still sitting in the registry, and the compositor
    // (`useOverlayCompositor.ts`) would apply it verbatim.
    const stillRegistered = afterReload.overlayLayers.get('animation');
    if (stillRegistered) {
      const { hiddenIds, colorOverrides } = afterReload.computeCompositeOverlay();
      assert.ok(hiddenIds.has(1042), 'sanity: composite still carries the stale global id');
      // Resolve global id 1042 against the RELOADED federation — this is
      // exactly what a global-id-keyed hide/colour channel means once
      // applied to the renderer.
      const resolved = fromGlobalIdFromModels(afterReload.models, 1042);
      console.log('global id 1042 resolves, post-reload, to:', resolved);
      assert.deepStrictEqual(
        resolved,
        { modelId: 'C', expressId: 42 },
        'global id 1042 now names a LIVE entity in the reloaded model C — a task from the pre-clear schedule ' +
          'would hide/tint an entity that has nothing to do with it',
      );
      assert.ok(colorOverrides.has(1042), 'and the stale RED colour override would land on that same live entity');
      assert.fail(
        'DEFECT: clearAllModels left the animation overlay layer registered; its stale global id 1042 now ' +
          'misresolves onto model C\'s live entity 42 — same shape as the compareResult/lens defects fixed in #2854',
      );
    }
    // Fix applied: the layer is gone, nothing to misresolve.
    assert.strictEqual(stillRegistered, undefined);
  });

  it('negative control: removeModel does NOT need to (and should not) touch overlayLayers — unregisterModel burns the offset instead of reclaiming it, so a stale layer left behind cannot misresolve', () => {
    federationRegistry.clear();
    federationRegistry.registerModel('A', 100);
    federationRegistry.registerModel('B', 100);
    useViewerStore.setState({
      models: new Map([
        ['A', model('A', 0, 100)],
        ['B', model('B', 1000, 1100)],
      ]),
      activeModelId: 'A',
    });
    const layer = seedPausedAnimationLayer();
    useViewerStore.getState().registerOverlayLayer(layer);

    useViewerStore.getState().removeModel('B');

    const after = useViewerStore.getState();
    assert.strictEqual(
      after.overlayLayers.get('animation'),
      layer,
      'removeModel must NOT clear overlayLayers — doing so would be a blanket clear, not a scoped fix, and is ' +
        'unnecessary: unregisterModel burns the freed offset range rather than reclaiming it',
    );

    // Prove the "cannot misresolve" half: register a brand new model and
    // confirm the federation never hands out offset 1000 again.
    const offsetC = federationRegistry.registerModel('C', 50);
    assert.notStrictEqual(
      offsetC,
      1000,
      'unregisterModel burns the offset space — a new model can never be handed the range the removed model owned, ' +
        'so the still-registered stale layer names a global id no live model can ever claim again',
    );
  });
});
