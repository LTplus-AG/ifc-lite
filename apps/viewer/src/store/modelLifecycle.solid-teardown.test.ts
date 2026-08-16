/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression for the #2654 adversarial review
 * (https://github.com/LTplus-AG/ifc-lite/pull/2654#issuecomment-5307246294):
 * the MODEL-LIFECYCLE teardown paths ended clash focus without touching any
 * clash field.
 *
 * `#2574`'s fix routes every *clash-focus* teardown through the three seq-
 * bumping setters, so those are covered by construction. But the paths that
 * replace or unload the MODEL the presentation belongs to were not:
 *
 *  - `resetViewerState()` (`store/index.ts`) — the primary-file "open another
 *    model" reset. It drops selection, isolation, ghost, `compareResult`,
 *    `zoneAssignments`, `searchIndexes` … all for the same reason (they
 *    reference the OUTGOING model's ids) and touched no clash field at all.
 *  - `clearAllModels()` (`modelSlice.ts`) — full federation teardown.
 *  - `removeModel()` (`modelSlice.ts`) — one model leaves a federation.
 *
 * A resolved solid plus a non-null `clashSelectedId` survived all three, so
 * the defence-in-depth gate in `Viewport.tsx` passed too and the effect never
 * pushed `null` — leaving the previous model's intersection solid eligible to
 * be re-pushed into the new scene when the renderer re-initialises.
 *
 * Seeds the store exactly as `homeView.solid-teardown.test.ts` does (a
 * resolved solid as `focusClash` leaves it, useClash.ts L487-L533), then calls
 * the REAL actions.
 */

import '@/test/setup-dom.js';
import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { useViewerStore } from './index.js';
import type { FederatedModel } from './types.js';

const originalState = useViewerStore.getState();
after(() => { useViewerStore.setState(originalState, true); });

/** A minimal federated pair, so "one model leaves a federation" is actually
 *  exercised: with an EMPTY `models` map `removeModel` deletes nothing, and a
 *  future `if (!models.has(id)) return` guard above the teardown would leave
 *  every assertion below green (#2654 second review / CodeRabbit). */
function seedFederation(): void {
  const model = (id: string, idOffset: number): FederatedModel => ({
    id,
    name: id,
    fileName: `${id}.ifc`,
    ifcDataStore: null,
    geometryResult: null,
    visible: true,
    collapsed: false,
    loadedAt: 0,
    idOffset,
    maxExpressId: 1000,
  } as unknown as FederatedModel);
  useViewerStore.setState({
    models: new Map([['modelA', model('modelA', 0)], ['modelB', model('modelB', 10_000)]]),
    activeModelId: 'modelA',
  });
}

/** The tint `focusClash` paints — the RECORD (`clashHighlightColors`) and the
 *  albedo override actually pushed to the renderer (`pendingColorUpdates`). */
const PAIR_TINT = new Map<number, [number, number, number, number]>([
  [12, [1, 0.6, 0, 1]],
  [34, [0, 0.8, 1, 1]],
]);

function seedResolvedSolidPresentation(): void {
  seedFederation();
  useViewerStore.setState({
    clashSelectedId: 'rule-1 modelA:12 modelB:34',
    clashSolidStatus: 'solid',
    clashSolidMesh: { positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) },
    clashSolidVolumeM3: 0.42,
    ghostExceptEntities: new Set<number>(),
    isolatedEntities: null,
    lensAppliedColors: null,
    // The channel that actually carries the colour to the GPU.
    pendingColorUpdates: new Map(PAIR_TINT),
    // The rest of what `focusClash` paints into the SAME scene: the A/B pair
    // tint and the contact marker (real contact lines, or the AABB fallback).
    // `Viewport.tsx` draws the marker off `clashContactLines`/`clashOverlapBox`
    // alone — its effect never reads `clashSelectedId` or `clashSolidStatus` —
    // so a teardown that drops only the solid leaves the wireframe hanging in
    // world space over models that are gone.
    clashHighlightColors: new Map(PAIR_TINT),
    clashOverlapBox: { min: [0, 0, 0], max: [1, 1, 1] },
    clashContactLines: { vertices: [0, 0, 0, 1, 0, 0], color: [1, 0, 1, 1] },
  });
}

/**
 * The A/B tint is painted through `pendingColorUpdates` → an effect in
 * `useGeometryStreaming.ts:906-923` → `scene.setColorOverrides`, fire-and-
 * forget: the effect drains the field and the override survives on the GPU
 * until a LATER push replaces it. `clashHighlightColors` is only a RECORD
 * (read by `Viewport.tsx` for framing and by `useAnimationLoop`), so nulling
 * it does not unpaint anything.
 *
 * Note the effect RETURNS on `null` — only a non-null EMPTY map reaches
 * `scene.clearColorOverrides()`. So "released" here means a real Map, either
 * empty or exactly whatever owned the channel before clash took it (an active
 * lens), which is what `useClash.clearHighlight` / `clearAll` /
 * `ClashPanel`'s unmount / the clash tour all push.
 */
function assertPaintChannelReleased(where: string): void {
  const s = useViewerStore.getState();
  const actual = s.pendingColorUpdates;
  assert.ok(
    actual !== null,
    `${where} must PUSH the paint channel, not null it — a null pendingColorUpdates is a no-op in useGeometryStreaming and leaves the A/B tint on the GPU`,
  );
  const expected = s.lensAppliedColors ?? new Map();
  assert.deepEqual(
    [...actual!.entries()].sort(),
    [...expected.entries()].sort(),
    `${where} must restore the colour-override channel to its prior owner (an active lens, else empty), not leave the A/B pair tint painted`,
  );
}

/** Every field the Viewport draw gate and the solid state machine read. */
function assertPresentationGone(where: string): void {
  const s = useViewerStore.getState();
  assert.equal(s.clashSolidStatus, 'none', `${where} must drop the intersection-solid presentation`);
  assert.equal(s.clashSolidMesh, null, `${where} must not leave the previous model's solid mesh behind`);
  assert.equal(s.clashSelectedId, null, `${where} must not leave a clash focused on an unloaded model`);
  // The marker geometry is drawn by an effect keyed ONLY on these fields, so
  // clearing the solid + the selected id is not enough to make it disappear.
  assert.equal(s.clashContactLines, null, `${where} must not leave the contact-line overlay drawn`);
  assert.equal(s.clashOverlapBox, null, `${where} must not leave the overlap wireframe box drawn`);
  assert.equal(s.clashHighlightColors, null, `${where} must not leave the A/B pair-tint RECORD set`);
  // `focusClash` takes ownership of the shared ghost channel too — the X-Ray
  // focus mode ghosts the pair's context, and the resolved-solid path ghosts
  // the ENTIRE model (`installClashGhost(new Set())`, useClash.ts). It is in a
  // different slice from every field above, so no clash action clears it: the
  // teardown dropped the selected id and the solid and left the survivors
  // fully translucent with nothing selected and no way to tell why (#2654
  // review, second report). `Set()` here means "ghost everything", so a
  // surviving EMPTY set is the worst case, not the harmless one.
  assert.equal(s.ghostExceptEntities, null, `${where} must not leave the scene ghosted with nothing selected`);
}

describe('model-lifecycle teardown drops the intersection-solid presentation (#2654 review)', () => {
  beforeEach(() => {
    seedResolvedSolidPresentation();
    assert.equal(useViewerStore.getState().clashSolidStatus, 'solid', 'setup sanity: a solid must be showing');
  });

  it('resetViewerState() drops it — opening another file must not inherit the previous model\'s solid', () => {
    const seq = useViewerStore.getState().clashSolidRequestSeq;
    useViewerStore.getState().resetViewerState();
    assertPresentationGone('opening another file (resetViewerState)');
    assert.ok(
      useViewerStore.getState().clashSolidRequestSeq > seq,
      'resetViewerState must also invalidate an in-flight compute (seq bump)',
    );
  });

  it('clearAllModels() drops it — a full federation teardown leaves nothing to draw a solid against', () => {
    const seq = useViewerStore.getState().clashSolidRequestSeq;
    useViewerStore.getState().clearAllModels();
    assertPresentationGone('clearAllModels');
    assert.ok(
      useViewerStore.getState().clashSolidRequestSeq > seq,
      'clearAllModels must also invalidate an in-flight compute (seq bump)',
    );
  });

  it('removeModel() drops the FOCUS presentation — the solid is drawn against a model set that just changed', () => {
    const seq = useViewerStore.getState().clashSolidRequestSeq;
    useViewerStore.getState().removeModel('modelA');
    assert.deepEqual(
      [...useViewerStore.getState().models.keys()],
      ['modelB'],
      'setup sanity: one model must actually have LEFT a real federation',
    );
    assertPresentationGone('removeModel');
    assertPaintChannelReleased('removeModel');
    assert.ok(
      useViewerStore.getState().clashSolidRequestSeq > seq,
      'removeModel must also invalidate an in-flight compute (seq bump)',
    );
  });

  it('clearAllModels() releases the paint channel too — the tint outlives the record', () => {
    useViewerStore.getState().clearAllModels();
    assertPaintChannelReleased('clearAllModels');
  });

  it('removeModel() restores an ACTIVE LENS rather than blanking the colour channel', () => {
    // The channel has a prior owner in the common case: focusClash overwrites a
    // lens colouring with the pair tint, and every user-initiated end of a focus
    // puts the lens back (`useClash.clearHighlight`). Blanking it would silently
    // switch the lens off on an unrelated model removal.
    const lens = new Map<number, [number, number, number, number]>([[7, [0.2, 0.4, 0.6, 1]]]);
    useViewerStore.setState({ lensAppliedColors: lens });
    useViewerStore.getState().removeModel('modelA');
    assertPaintChannelReleased('removeModel with an active lens');
    assert.deepEqual(
      [...(useViewerStore.getState().pendingColorUpdates ?? new Map()).entries()],
      [...lens.entries()],
      'the lens colouring must be the thing pushed back',
    );
  });

  it('removeModel() drops a clash ISOLATION — the other half of the same focus (#2654 second review)', () => {
    // `focusClash` writes ONE of two channels (`applyFocusMode`): ghost, or
    // `installClashIsolation`. Isolate is one click from every panel row. Left
    // behind, `isEntityVisible` hides everything outside the pair — and if the
    // pair lived in the removed model, everything full stop.
    useViewerStore.setState({
      ghostExceptEntities: null,
      isolatedEntities: new Set<number>([12, 34]),
    });
    useViewerStore.getState().removeModel('modelA');
    assert.equal(
      useViewerStore.getState().isolatedEntities,
      null,
      'removeModel must not leave the viewport isolated to a clash pair that may no longer be loaded',
    );
  });

  it('clearAllModels() drops a clash ISOLATION — nothing is left to isolate to', () => {
    useViewerStore.setState({
      ghostExceptEntities: null,
      isolatedEntities: new Set<number>([12, 34]),
    });
    useViewerStore.getState().clearAllModels();
    assert.equal(useViewerStore.getState().isolatedEntities, null, 'clearAllModels must drop the isolation');
  });

  it('removeModel() keeps the clash RESULT — only the focused presentation goes', () => {
    // Removing a sibling model must not throw away the run the user is reading:
    // the result is a list, the solid is a mesh drawn into the live scene, and
    // only the second is invalidated by the model set changing under it.
    const result = { clashes: [], summary: null } as unknown as NonNullable<
      ReturnType<typeof useViewerStore.getState>['clashResult']
    >;
    useViewerStore.setState({ clashResult: result });
    useViewerStore.getState().removeModel('modelA');
    assert.equal(useViewerStore.getState().clashResult, result, 'removeModel must not discard the clash run');
  });
});
