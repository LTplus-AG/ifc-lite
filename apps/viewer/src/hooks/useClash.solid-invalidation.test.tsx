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
 */

import '@/test/setup-dom.js';
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

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

/** Seed the store as if a prior `focusClash` had already resolved a solid and
 *  applied the BIMcollab-style full-model ghost (see useClash.ts L456-L491). */
function seedResolvedSolidPresentation(): void {
  useViewerStore.setState({
    models: new Map(),
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

describe('useClash solid-presentation invalidation on detection replace (#2574 CodeRabbit)', () => {
  it('run() discards a stale solid + full-model ghost before the new detection flow starts', async () => {
    const api = await renderHook();
    seedResolvedSolidPresentation();
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
    seedResolvedSolidPresentation();
    assert.equal(useViewerStore.getState().clashSolidStatus, 'solid', 'setup sanity: a solid must be showing before runDuplicates()');
    assert.ok(useViewerStore.getState().ghostExceptEntities, 'setup sanity: the model must be ghosted before runDuplicates()');

    await act(async () => { await api.runDuplicates(); });

    const s = useViewerStore.getState();
    assert.equal(s.clashSolidStatus, 'none', 'runDuplicates() must drop the PRIOR solid before/while replacing results');
    assert.equal(s.clashSolidMesh, null, 'the stale mesh must not survive a new duplicate scan');
    assert.equal(s.ghostExceptEntities, null, 'the full-model ghost from the old solid must be cleared');
  });
});
