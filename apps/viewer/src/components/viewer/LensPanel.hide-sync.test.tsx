/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5206: the hide-sync effect used to depend on `lensHiddenIds.size`, a
 * subscription meant for the footer's "N hidden" count. `useLens.ts` replaces
 * `lensHiddenIds` with a FRESH `Set` on every recompute (a rule edit via
 * `handleSaveLens` -> `updateLens`, or a model-set change) rather than
 * mutating one in place, so when a rule edit swaps WHICH ids match while the
 * COUNT stays the same, `.size` does not change, the component does not
 * re-render, the effect never re-runs, and the sync goes stale: old hides
 * never lift, new hides never apply.
 *
 * These tests mount the real `LensPanel` against the real Zustand store and
 * drive the resync the way `useLens.ts` actually does it: replacing the
 * `lensHiddenIds` Set object via `setState`, never mutating the existing one.
 */

import '@/test/setup-dom.js';
import { act } from 'react';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup } from '@/test/render.js';
import { useViewerStore } from '@/store';
import type { Lens } from '@/store/slices/lensSlice';
import { LensPanel } from './LensPanel.js';

const LENS: Lens = {
  id: 'lens-under-test',
  name: 'Test lens',
  rules: [],
};

let initialState: ReturnType<typeof useViewerStore.getState>;

/** Seeds the minimal store shape `useLens` and `LensPanel` need, with no
 *  models loaded so `useLens`'s own recompute effect never fires and the
 *  seeded `lensHiddenIds` is the only thing driving the sync under test. */
function seedLens(lensHiddenIds: Set<number>, hiddenEntities: Set<number> = new Set()) {
  useViewerStore.setState({
    savedLenses: [LENS],
    activeLensId: LENS.id,
    lensRuleCounts: new Map(),
    lensRuleEntityIds: new Map(),
    lensRuleIsolation: null,
    lensHiddenIds,
    lensAppliedHiddenIds: [],
    lensColorMap: new Map(),
    lensAutoColorLegend: [],
    hiddenEntities,
    isolatedEntities: null,
    models: new Map(),
    activeModelId: null,
    ifcDataStore: null,
  });
}

describe('LensPanel: hide-sync effect resyncs on content change, not just size (#5206)', () => {
  before(() => {
    initialState = useViewerStore.getState();
  });

  afterEach(() => {
    cleanup();
    useViewerStore.setState(initialState, true);
  });

  after(() => {
    useViewerStore.setState(initialState, true);
  });

  it('applies the initial lensHiddenIds on mount', () => {
    seedLens(new Set([1, 2, 3]));
    render(<LensPanel onClose={() => {}} />);

    assert.deepEqual(
      [...useViewerStore.getState().hiddenEntities].sort((a, b) => a - b),
      [1, 2, 3],
    );
  });

  it('resyncs on a SAME-SIZE content swap: old ids lift, new ids apply', () => {
    seedLens(new Set([1, 2, 3]));
    render(<LensPanel onClose={() => {}} />);
    assert.deepEqual(
      [...useViewerStore.getState().hiddenEntities].sort((a, b) => a - b),
      [1, 2, 3],
      'precondition: the initial hides applied',
    );

    // Exactly what useLens.ts does after a rule edit that changes matches but
    // not the count: a FRESH Set, same size, disjoint content.
    act(() => {
      useViewerStore.setState({ lensHiddenIds: new Set([4, 5, 6]) });
    });

    assert.deepEqual(
      [...useViewerStore.getState().hiddenEntities].sort((a, b) => a - b),
      [4, 5, 6],
      'stale hides (1,2,3) must lift and the newly matched ids (4,5,6) must apply',
    );
  });

  it('never claims or shows a manually-hidden id outside the lens\'s applied set', () => {
    // A user hid 999 by hand before the lens ever touched it.
    seedLens(new Set([1, 2, 3]), new Set([999]));
    render(<LensPanel onClose={() => {}} />);
    assert.deepEqual(
      [...useViewerStore.getState().hiddenEntities].sort((a, b) => a - b),
      [1, 2, 3, 999],
      'precondition: the manual hide survives the initial apply untouched',
    );

    act(() => {
      useViewerStore.setState({ lensHiddenIds: new Set([4, 5, 6]) });
    });

    const hidden = [...useViewerStore.getState().hiddenEntities].sort((a, b) => a - b);
    assert.deepEqual(
      hidden,
      [4, 5, 6, 999],
      'the manual hide of 999 must remain hidden across the resync; the lens must not claim or release it',
    );
  });
});
