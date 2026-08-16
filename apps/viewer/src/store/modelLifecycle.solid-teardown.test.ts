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

const originalState = useViewerStore.getState();
after(() => { useViewerStore.setState(originalState, true); });

function seedResolvedSolidPresentation(): void {
  useViewerStore.setState({
    clashSelectedId: 'rule-1 modelA:12 modelB:34',
    clashSolidStatus: 'solid',
    clashSolidMesh: { positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) },
    clashSolidVolumeM3: 0.42,
    ghostExceptEntities: new Set<number>(),
    // The rest of what `focusClash` paints into the SAME scene: the A/B pair
    // tint and the contact marker (real contact lines, or the AABB fallback).
    // `Viewport.tsx` draws the marker off `clashContactLines`/`clashOverlapBox`
    // alone — its effect never reads `clashSelectedId` or `clashSolidStatus` —
    // so a teardown that drops only the solid leaves the wireframe hanging in
    // world space over models that are gone.
    clashHighlightColors: new Map<number, [number, number, number, number]>([[12, [1, 0.6, 0, 1]]]),
    clashOverlapBox: { min: [0, 0, 0], max: [1, 1, 1] },
    clashContactLines: { vertices: [0, 0, 0, 1, 0, 0], color: [1, 0, 1, 1] },
  });
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
  assert.equal(s.clashHighlightColors, null, `${where} must not leave the A/B pair tint applied`);
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
    assertPresentationGone('removeModel');
    assert.ok(
      useViewerStore.getState().clashSolidRequestSeq > seq,
      'removeModel must also invalidate an in-flight compute (seq bump)',
    );
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
