/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The lens runtime (`useLens`, mounted once by `LensRuntimeHost`): evaluation
 * + hide sync, for the viewer's lifetime rather than the Lens panel's (#5877).
 *
 * #5206: the hide-sync effect used to depend on `lensHiddenIds.size`, a
 * subscription meant for the footer's "N hidden" count. `useLens.ts` replaces
 * `lensHiddenIds` with a FRESH `Set` on every recompute (a rule edit via
 * `handleSaveLens` -> `updateLens`, or a model-set change) rather than
 * mutating one in place, so when a rule edit swaps WHICH ids match while the
 * COUNT stays the same, `.size` does not change, the component does not
 * re-render, the effect never re-runs, and the sync goes stale: old hides
 * never lift, new hides never apply.
 *
 * These tests mount the real `useLens` against the real Zustand store and
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
import { resolveExportVisibility } from '@/store/exportVisibility';
import { useLens } from './useLens.js';

/** What `LensRuntimeHost` mounts: `useLens()` and nothing else. */
function LensRuntimeProbe(): null {
  useLens();
  return null;
}

const LENS: Lens = {
  id: 'lens-under-test',
  name: 'Test lens',
  rules: [],
};

let initialState: ReturnType<typeof useViewerStore.getState>;

/** Seeds the minimal store shape `useLens` and the host need, with no
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

describe('useLens: hide-sync effect resyncs on content change, not just size (#5206)', () => {
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
    render(<LensRuntimeProbe />);

    assert.deepEqual(
      [...useViewerStore.getState().hiddenEntities].sort((a, b) => a - b),
      [1, 2, 3],
    );
  });

  it('resyncs on a SAME-SIZE content swap: old ids lift, new ids apply', () => {
    seedLens(new Set([1, 2, 3]));
    render(<LensRuntimeProbe />);
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

  it('a Visible Only export after a same-size swap excludes exactly the new matches', () => {
    // The consequence that leaves the building: the export denylist unions
    // `hiddenEntities` with `lensHiddenIds`, so a stale hide of 1,2,3 left in
    // `hiddenEntities` would silently drop those entities from the file.
    seedLens(new Set([1, 2, 3]));
    render(<LensRuntimeProbe />);
    act(() => {
      useViewerStore.setState({ lensHiddenIds: new Set([4, 5, 6]) });
    });

    const visibility = resolveExportVisibility(useViewerStore.getState(), '__legacy__');
    assert.deepEqual(
      [...visibility.hiddenLocalIds].sort((a, b) => a - b),
      [4, 5, 6],
      'entities 1,2,3 no longer match the lens and must be exported; 4,5,6 must not',
    );
  });

  it('never claims or shows a manually-hidden id outside the lens\'s applied set', () => {
    // A user hid 999 by hand before the lens ever touched it.
    seedLens(new Set([1, 2, 3]), new Set([999]));
    render(<LensRuntimeProbe />);
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
