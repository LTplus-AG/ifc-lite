/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression for the CodeRabbit #2574 review thread on `useClash.ts`
 * (apps/viewer/src/hooks/useClash.ts around L443-L487): "`run()` and
 * `runDuplicates()` clear `clashSelectedId` after producing a new result, but
 * neither invalidates `solidRequestGuard` nor clears the solid state. A prior
 * request can then pass the staleness check and restore its mesh plus full-
 * model ghosting after the old clash is no longer selected."
 *
 * This mounts the REAL `useClash()` hook (not a mock) through the shared
 * Zustand store, exactly as `ClashPanel` does, and seeds the store as if a
 * PRIOR `focusClash` had already resolved a solid + full-model ghost (the
 * observable end state that stale async resolve would (re)produce). It then
 * calls `run()` / `runDuplicates()` with no models loaded, so the detection
 * flow fails fast on "no geometry" — deliberately, since the finding is about
 * invalidation happening at the START of a new detection flow, before it is
 * even known whether the new run will find anything. If the old solid/ghost
 * presentation is still standing after that call, the flow never invalidated
 * it.
 *
 * The ghost is established THROUGH the hook (`focusClash` in ghost mode), not
 * by writing `ghostExceptEntities` into the store directly: since the #2574
 * unconditional-clear regression fix, clash releases only the isolation/ghost
 * presentation it itself installed (a user's isolation/ghost in the same
 * shared channels survives a run — see useClash.run-preserves-isolation.test),
 * so a raw seed would test state clash never owned.
 */

import '@/test/setup-dom.js';
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Clash } from '@ifc-lite/clash';

import { useViewerStore } from '@/store';
import { useClash } from './useClash.js';

type ClashApi = ReturnType<typeof useClash>;

/** Render `useClash()` once and capture the live api object it returns. */
async function renderHook(): Promise<ClashApi> {
  let result: ClashApi | null = null;
  function Harness(): null {
    result = useClash();
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  try {
    await act(async () => { root = createRoot(container); root.render(<Harness />); });
    assert.ok(result, 'harness never rendered — the hook was not called');
    return result!;
  } finally {
    if (root) await act(async () => { root!.unmount(); });
    container.remove();
  }
}

const originalState = useViewerStore.getState();
after(() => { useViewerStore.setState(originalState, true); });

/** The clash a prior run would have focused. Refs resolve through the
 *  federation registry (model 'A' registers at offset 0, so the global id
 *  equals the express id). */
const OLD_CLASH: Clash = {
  id: 'clash-old',
  a: { key: 'A:1', ref: 1, model: 'A', tag: 'IfcWall' },
  b: { key: 'A:2', ref: 2, model: 'A', tag: 'IfcWall' },
  rule: 'all-clashes',
  status: 'hard',
  distance: -0.5,
  point: [0.75, 0.5, 0.5],
  bounds: { min: [0.5, 0, 0], max: [1, 1, 1] },
  severity: 'major',
};

/** Put the presentation in the state a prior `focusClash` leaves once its
 *  solid compute has resolved: focus the clash in ghost mode THROUGH the hook
 *  — so the ghost is recorded as clash-installed, exactly as a real focus is —
 *  then overlay the resolved-solid fields the async compute would have
 *  written. */
async function seedResolvedSolidPresentation(api: ClashApi): Promise<void> {
  useViewerStore.setState({
    models: new Map(),
    clashSelectedId: null,
    isolatedEntities: null,
    ghostExceptEntities: null,
    clashHighlightColors: null,
    clashOverlapBox: null,
    clashContactLines: null,
  });
  useViewerStore.getState().registerModelOffset('A', 100);
  await act(async () => { api.focusClash(OLD_CLASH, 'ghost'); });
  useViewerStore.setState({
    clashSolidStatus: 'solid',
    clashSolidMesh: { positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) },
    clashSolidVolumeM3: 0.42,
  });
}

describe('useClash solid-presentation invalidation on detection replace (#2574 CodeRabbit)', () => {
  it('run() discards a stale solid + full-model ghost before the new detection flow starts', async () => {
    const api = await renderHook();
    await seedResolvedSolidPresentation(api);
    assert.equal(useViewerStore.getState().clashSolidStatus, 'solid', 'setup sanity: a solid must be showing before run()');
    assert.ok(useViewerStore.getState().ghostExceptEntities, 'setup sanity: the model must be ghosted before run()');

    await act(async () => { await api.run([]); });

    const s = useViewerStore.getState();
    assert.equal(s.clashSolidStatus, 'none', 'run() must drop the PRIOR solid before/while replacing results');
    assert.equal(s.clashSolidMesh, null, 'the stale mesh must not survive a new detection run');
    assert.equal(s.ghostExceptEntities, null, 'the full-model ghost from the old solid must be cleared');
  });

  it('runDuplicates() discards a stale solid + full-model ghost before the new scan starts', async () => {
    const api = await renderHook();
    await seedResolvedSolidPresentation(api);
    assert.equal(useViewerStore.getState().clashSolidStatus, 'solid', 'setup sanity: a solid must be showing before runDuplicates()');
    assert.ok(useViewerStore.getState().ghostExceptEntities, 'setup sanity: the model must be ghosted before runDuplicates()');

    await act(async () => { await api.runDuplicates(); });

    const s = useViewerStore.getState();
    assert.equal(s.clashSolidStatus, 'none', 'runDuplicates() must drop the PRIOR solid before/while replacing results');
    assert.equal(s.clashSolidMesh, null, 'the stale mesh must not survive a new duplicate scan');
    assert.equal(s.ghostExceptEntities, null, 'the full-model ghost from the old solid must be cleared');
  });
});
