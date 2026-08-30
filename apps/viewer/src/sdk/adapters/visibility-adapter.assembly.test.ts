/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createVisibilityAdapter } from './visibility-adapter.js';
import type { StoreApi } from './types.js';
import type { ViewerState } from '../../store/index.js';

/**
 * #3338: `expandToGeometryBearingIds` (assembly → geometry-bearing parts)
 * has exactly one production call site the rest of the codebase knows
 * about — `Viewport.tsx`'s `resolveHighlightIds`, wired into
 * `cameraCallbacks.resolveHighlightIds` and used by LensPanel,
 * PropertiesPanel and both SearchModal isolate paths.
 *
 * This SDK adapter is a FIFTH channel, not named in #3338: scripts and the
 * MCP `viewer_isolate` tool call `ifc.isolate(refs)`, which reaches here.
 * `isolate()` already expands a SPATIAL-structure ref (storey, building) to
 * its contained elements (`expandSpatialRef`), but never routes the result
 * through `cameraCallbacks.resolveHighlightIds` — so isolating a geometry-less
 * `IfcElementAssembly` by ref isolates an id with no mesh, and the viewport
 * shows nothing, exactly the #2532 failure mode #3338 describes, just in a
 * channel nobody enumerated yet.
 *
 * `state.cameraCallbacks.resolveHighlightIds` is reachable from here — it
 * lives on the same store `StoreApi` already reads — so nothing structural
 * stops this adapter from using it; the only thing missing was remembering
 * to call it, which is the exact "one call site every channel must
 * remember to use" shape #3338 is about.
 */
describe('SDK visibility adapter: isolate() and #3338 assembly expansion', () => {
  const MODEL_ID = 'm1';
  const ASSEMBLY_EXPRESS_ID = 42;
  const ASSEMBLY_GLOBAL_ID = 42; // idOffset 0
  const PART_A_GLOBAL_ID = 9001;
  const PART_B_GLOBAL_ID = 9002;

  function makeStore(resolveHighlightIds?: (ids: number[]) => number[]): StoreApi {
    const isolateEntities = (() => {
      let calls: number[][] = [];
      const fn = (ids: number[]) => { calls.push(ids); };
      (fn as unknown as { calls: number[][] }).calls = calls;
      return fn as unknown as ((ids: number[]) => void) & { calls: number[][] };
    })();

    const state = {
      models: new Map([[MODEL_ID, {
        id: MODEL_ID,
        name: 'model',
        ifcDataStore: null,
        schemaVersion: 'IFC4',
        fileSize: 0,
        loadedAt: 0,
        idOffset: 0,
        maxExpressId: 1000,
      }]]),
      isolateEntities,
      showAllInAllModels: () => {},
      cameraCallbacks: {
        ...(resolveHighlightIds ? { resolveHighlightIds } : {}),
      },
    } as unknown as ViewerState;

    return {
      getState: () => state,
      subscribe: () => () => {},
    };
  }

  /** Mirrors the real resolver's contract: the geometry-less assembly is
   *  replaced by its geometry-bearing parts, never passed through as-is. */
  const assemblyResolver = (ids: number[]) =>
    ids.flatMap((id) => (id === ASSEMBLY_GLOBAL_ID ? [PART_A_GLOBAL_ID, PART_B_GLOBAL_ID] : [id]));

  it('isolating a geometry-less assembly ref resolves to its geometry-bearing parts (RED without the fix)', () => {
    const store = makeStore(assemblyResolver);
    const adapter = createVisibilityAdapter(store);

    adapter.isolate([{ modelId: MODEL_ID, expressId: ASSEMBLY_EXPRESS_ID }]);

    const calls = (store.getState().isolateEntities as unknown as { calls: number[][] }).calls;
    assert.equal(calls.length, 1, 'isolate() must call isolateEntities exactly once');
    assert.deepEqual(
      [...calls[0]].sort((a, b) => a - b),
      // The resolved parts, unioned with the raw (pre-resolution) id — the
      // same union every other selection channel (LensPanel, PropertiesPanel,
      // SearchModal) performs, harmless here since the raw assembly id has
      // no geometry of its own to draw.
      [ASSEMBLY_GLOBAL_ID, PART_A_GLOBAL_ID, PART_B_GLOBAL_ID],
      'isolate() must route through cameraCallbacks.resolveHighlightIds, the same aggregation ' +
      'resolver every other selection channel (LensPanel, PropertiesPanel, SearchModal) uses, ' +
      'instead of isolating the raw geometry-less assembly id',
    );
  });

  it('proves the assertion is not vacuous: with no resolver wired, the un-fixed behaviour isolates the raw id', () => {
    // Same scenario, but no cameraCallbacks.resolveHighlightIds registered
    // (mirrors a renderer that has not mounted yet) — demonstrates what
    // "forgetting to route through the resolver" actually looks like: the
    // caller falls back to the unexpanded ids rather than isolating nothing.
    const store = makeStore(undefined);
    const adapter = createVisibilityAdapter(store);

    adapter.isolate([{ modelId: MODEL_ID, expressId: ASSEMBLY_EXPRESS_ID }]);

    const calls = (store.getState().isolateEntities as unknown as { calls: number[][] }).calls;
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0],
      [ASSEMBLY_GLOBAL_ID],
      'without a resolver, isolate() falls back to the raw (unexpanded) id — the pre-fix shape',
    );
  });

  it('an empty resolve keeps the raw ids rather than isolating nothing (#3389)', () => {
    // `[]` does not mean "geometry is in and nothing here renders": the
    // resolver bounds-checks against the type-visibility FILTERED mesh list,
    // so an IfcSpace at the shipped `typeVisibility.spaces === false` default,
    // and a mesh that has not streamed in yet, both answer `[]` too. Dropping
    // the isolate there makes `viewer.visibility.isolate()` a silent no-op for
    // a space ref; keeping the raw ids costs nothing (an id with no mesh never
    // matches the renderer's whitelist) and starts showing the right thing the
    // moment the toggle flips or the batch lands.
    const emptyResolver = (_ids: number[]) => [];
    const store = makeStore(emptyResolver);
    const adapter = createVisibilityAdapter(store);

    adapter.isolate([{ modelId: MODEL_ID, expressId: ASSEMBLY_EXPRESS_ID }]);

    const calls = (store.getState().isolateEntities as unknown as { calls: number[][] }).calls;
    assert.equal(calls.length, 1, 'isolate() must still install an isolation');
    assert.deepEqual(calls[0], [ASSEMBLY_GLOBAL_ID], 'an empty resolve falls back to the raw ids');
  });
});
