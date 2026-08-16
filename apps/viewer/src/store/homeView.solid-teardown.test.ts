/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression for the #2574 adversarial re-review
 * (https://github.com/LTplus-AG/ifc-lite/pull/2574#issuecomment-5306157639):
 * `resetVisibilityForHomeFromStore()` (the Home button / "Show all" reset)
 * resets selection, isolation, ghost, pair colours, the contact overlay and
 * `clashSelectedId` by hand — the same fields `useClash.clearHighlight()`
 * resets — but was written before the on-demand intersection-solid feature
 * landed and never learned about it. `Viewport.tsx` renders the solid purely
 * off `clashSolidStatus === 'solid' && clashSolidMesh`. If this reset doesn't
 * drop the solid presentation, an opaque intersection-solid mesh (plus, if in
 * flight, a since-superseded compute that can still land) keeps rendering
 * after the user clicks Home / "Show all", with the rest of the model back to
 * fully visible/opaque and nothing selected.
 *
 * This seeds the store exactly as `useClash.solid-invalidation.test.tsx` does
 * for `run()`/`runDuplicates()` (a resolved solid + full-model ghost, as
 * `focusClash` leaves it — useClash.ts L487-L533), then calls the REAL
 * `resetVisibilityForHomeFromStore()` and asserts the solid presentation is
 * gone afterward.
 */

import '@/test/setup-dom.js';
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { useViewerStore } from './index.js';
import { resetVisibilityForHomeFromStore } from './homeView.js';

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

describe('resetVisibilityForHomeFromStore drops the intersection-solid presentation (#2574 review)', () => {
  it('clears clashSolidStatus/clashSolidMesh left by a resolved focusClash solid', () => {
    seedResolvedSolidPresentation();
    assert.equal(useViewerStore.getState().clashSolidStatus, 'solid', 'setup sanity: a solid must be showing before Home reset');

    resetVisibilityForHomeFromStore();

    const s = useViewerStore.getState();
    assert.equal(s.clashSolidStatus, 'none', 'Home / "Show all" reset must drop the intersection-solid presentation');
    assert.equal(s.clashSolidMesh, null, 'the stale solid mesh must not survive the Home reset');
  });

  it('invalidates an in-flight solid compute (clashSolidRequestSeq bumps)', () => {
    useViewerStore.setState({ clashSelectedId: 'clash-old', clashSolidStatus: 'computing', clashSolidMesh: null });
    const seqBefore = useViewerStore.getState().clashSolidRequestSeq;

    resetVisibilityForHomeFromStore();

    const seqAfter = useViewerStore.getState().clashSolidRequestSeq;
    assert.notEqual(
      seqAfter, seqBefore,
      'the Home reset must invalidate any in-flight focusClash solid compute (clashSolidRequestSeq), ' +
      'or a since-superseded compute can still land and repaint the solid + full-model ghost',
    );
  });
});
