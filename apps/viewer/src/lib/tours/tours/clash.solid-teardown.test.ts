/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression for the #2574 adversarial re-review
 * (https://github.com/LTplus-AG/ifc-lite/pull/2574#issuecomment-5306157639):
 * the clash tour's "zoom-to-clash" step `cleanup()` (clash.ts:106-117) resets
 * selection, isolation, ghost, pair colours, the contact overlay and
 * `clashSelectedId` by hand — the same fields `useClash.clearHighlight()`
 * resets — but was written before the on-demand intersection-solid feature
 * landed and never learned about it. `Viewport.tsx` renders the solid purely
 * off `clashSolidStatus === 'solid' && clashSolidMesh`, independent of
 * `clashSelectedId` at the time of the review (now additionally gated, see
 * Viewport.tsx). If `cleanup()` doesn't drop the solid presentation, an
 * opaque intersection-solid mesh (plus, if in flight, a since-superseded
 * compute that can still land) keeps rendering after the tour ends with
 * nothing selected and no clash focus.
 *
 * This seeds the store exactly as `useClash.solid-invalidation.test.tsx`
 * does for `run()`/`runDuplicates()` (a resolved solid + full-model ghost, as
 * `focusClash` leaves it — useClash.ts L487-L533), then calls the REAL
 * `cleanup()` from `CLASH_TOUR`'s "zoom-to-clash" step and asserts the solid
 * presentation is gone afterward.
 */

import '@/test/setup-dom.js';
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { useViewerStore } from '@/store';
import { CLASH_TOUR } from './clash.js';

const originalState = useViewerStore.getState();
after(() => { useViewerStore.setState(originalState, true); });

/** Seed the store as if a prior `focusClash` had already resolved a solid and
 *  applied the BIMcollab-style full-model ghost (see useClash.ts L487-L533). */
function seedResolvedSolidPresentation(): void {
  useViewerStore.setState({
    clashSelectedId: 'clash-old',
    clashSolidStatus: 'solid',
    clashSolidMesh: { positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) },
    clashSolidVolumeM3: 0.42,
    ghostExceptEntities: new Set<number>(), // full-model ghost, as focusClash applies
    clashHighlightColors: null,
    clashOverlapBox: null,
    clashContactLines: null,
  });
}

describe('clash tour "zoom-to-clash" cleanup drops the intersection-solid presentation (#2574 review)', () => {
  it('cleanup() clears clashSolidStatus/clashSolidMesh left by a resolved focusClash solid', () => {
    const zoomStep = CLASH_TOUR.steps.find((s) => s.id === 'zoom-to-clash');
    assert.ok(zoomStep?.cleanup, 'zoom-to-clash step must have a cleanup()');

    seedResolvedSolidPresentation();
    assert.equal(useViewerStore.getState().clashSolidStatus, 'solid', 'setup sanity: a solid must be showing before cleanup()');

    // hadResultAtEntry === 0: no PRE-EXISTING result, so cleanup must actually run
    // (the tour skips cleanup entirely when a result predated it).
    zoomStep!.cleanup!(useViewerStore, { baseline: { hadResultAtEntry: 0 }, artifacts: new Map() });

    const s = useViewerStore.getState();
    assert.equal(s.clashSolidStatus, 'none', 'tour cleanup must drop the intersection-solid presentation');
    assert.equal(s.clashSolidMesh, null, 'the stale solid mesh must not survive tour cleanup');
  });

  it('cleanup() invalidates an in-flight solid compute (clashSolidRequestSeq bumps)', () => {
    const zoomStep = CLASH_TOUR.steps.find((s) => s.id === 'zoom-to-clash');
    assert.ok(zoomStep?.cleanup);

    useViewerStore.setState({ clashSelectedId: 'clash-old', clashSolidStatus: 'computing', clashSolidMesh: null });
    const seqBefore = useViewerStore.getState().clashSolidRequestSeq;

    zoomStep!.cleanup!(useViewerStore, { baseline: { hadResultAtEntry: 0 }, artifacts: new Map() });

    const seqAfter = useViewerStore.getState().clashSolidRequestSeq;
    assert.notEqual(
      seqAfter, seqBefore,
      'cleanup() must invalidate any in-flight focusClash solid compute (clashSolidRequestSeq), ' +
      'or a since-superseded compute can still land and repaint the solid + full-model ghost',
    );
  });
});
