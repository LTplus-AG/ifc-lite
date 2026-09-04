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

  // #3426, correcting #3382: the previous test's `emptyResolver` stood in for
  // EVERY reason a resolver answers `[]`, including a geometry-less assembly
  // whose parts genuinely never render — but for that case, falling back to
  // the raw (parent) id is the bug: the assembly has no mesh either, so
  // isolating `[ASSEMBLY_GLOBAL_ID]` blanks the viewport exactly as isolating
  // `[]` would have, just with an extra step. `expandToGeometryBearingIds`
  // (`utils/aggregation.ts`) no longer answers `[]` for this case: when none
  // of an assembly's parts currently render, the real `resolveHighlightIds`
  // now falls back to ALL of the assembly's aggregated parts rather than
  // dropping it — this mock mirrors that corrected contract.
  it('a resolver that expands to un-rendered aggregated parts is unioned in, not discarded (#3426)', () => {
    const structuralResolver = (ids: number[]) =>
      ids.flatMap((id) => (id === ASSEMBLY_GLOBAL_ID ? [PART_A_GLOBAL_ID, PART_B_GLOBAL_ID] : []));
    const store = makeStore(structuralResolver);
    const adapter = createVisibilityAdapter(store);

    adapter.isolate([{ modelId: MODEL_ID, expressId: ASSEMBLY_EXPRESS_ID }]);

    const calls = (store.getState().isolateEntities as unknown as { calls: number[][] }).calls;
    assert.equal(calls.length, 1);
    assert.deepEqual(
      [...calls[0]].sort((a, b) => a - b),
      [ASSEMBLY_GLOBAL_ID, PART_A_GLOBAL_ID, PART_B_GLOBAL_ID],
      'isolating a geometry-less assembly must install its parts, not just the ' +
      'parent id the parts belong to — the parent alone has no mesh to render',
    );
  });
});

/**
 * #3338, the SAME gap in the SIBLING channels of the `isolate()` fixed above.
 *
 * `hide()` and `show()` write `hiddenEntities`, which the renderer matches
 * against MESH ids exactly as it matches `isolatedEntities`. A geometry-less
 * `IfcElementAssembly` id owns no mesh, so `hide([assemblyRef])` adds an id
 * nothing ever matches: the assembly's parts stay fully visible and the call
 * is a silent no-op. Quieter than the blank viewport `isolate()` produced,
 * and wrong in the same way and for the same reason.
 *
 * `show()` has to expand for a second reason on top of that one: once `hide()`
 * expands, `hiddenEntities` holds the PARTS, so a `show()` that only removes
 * the parent id can never undo its own `hide()`.
 */
describe('SDK visibility adapter: hide()/show() and #3338 assembly expansion', () => {
  const MODEL_ID = 'm1';
  const ASSEMBLY_EXPRESS_ID = 42;
  const ASSEMBLY_GLOBAL_ID = 42; // idOffset 0
  const PART_A_GLOBAL_ID = 9001;
  const PART_B_GLOBAL_ID = 9002;

  const assemblyResolver = (ids: number[]) =>
    ids.flatMap((id) => (id === ASSEMBLY_GLOBAL_ID ? [PART_A_GLOBAL_ID, PART_B_GLOBAL_ID] : [id]));

  function makeStore(resolveHighlightIds?: (ids: number[]) => number[]) {
    const hideCalls: number[][] = [];
    const showCalls: number[][] = [];
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
      hideEntities: (ids: number[]) => { hideCalls.push(ids); },
      showEntities: (ids: number[]) => { showCalls.push(ids); },
      showAllInAllModels: () => {},
      cameraCallbacks: { ...(resolveHighlightIds ? { resolveHighlightIds } : {}) },
    } as unknown as ViewerState;

    const store: StoreApi = { getState: () => state, subscribe: () => () => {} };
    return { store, hideCalls, showCalls };
  }

  it('hiding a geometry-less assembly ref hides its geometry-bearing parts (RED without the fix)', () => {
    const { store, hideCalls } = makeStore(assemblyResolver);
    createVisibilityAdapter(store).hide([{ modelId: MODEL_ID, expressId: ASSEMBLY_EXPRESS_ID }]);

    assert.equal(hideCalls.length, 1, 'hide() must call hideEntities exactly once');
    assert.deepEqual(
      [...hideCalls[0]].sort((a, b) => a - b),
      [ASSEMBLY_GLOBAL_ID, PART_A_GLOBAL_ID, PART_B_GLOBAL_ID],
      'hide() must route through the same presentation resolver isolate() uses — hiding the ' +
      'bare assembly id hides nothing, because no mesh carries that id',
    );
  });

  it('showing a geometry-less assembly ref shows the parts a hide() put away (RED without the fix)', () => {
    const { store, showCalls } = makeStore(assemblyResolver);
    createVisibilityAdapter(store).show([{ modelId: MODEL_ID, expressId: ASSEMBLY_EXPRESS_ID }]);

    assert.equal(showCalls.length, 1, 'show() must call showEntities exactly once');
    assert.deepEqual(
      [...showCalls[0]].sort((a, b) => a - b),
      [ASSEMBLY_GLOBAL_ID, PART_A_GLOBAL_ID, PART_B_GLOBAL_ID],
      'show() must expand too, or it can never undo the hide() above: hiddenEntities holds the ' +
      'PARTS, and removing only the parent id leaves every one of them hidden',
    );
  });

  it('a plain element ref is untouched by the expansion (no over-reach)', () => {
    const { store, hideCalls } = makeStore(assemblyResolver);
    createVisibilityAdapter(store).hide([{ modelId: MODEL_ID, expressId: PART_A_GLOBAL_ID }]);

    assert.deepEqual(hideCalls[0], [PART_A_GLOBAL_ID], 'a mesh-bearing id resolves to itself');
  });

  it('with no resolver wired, hide() still hides the raw ids rather than nothing', () => {
    const { store, hideCalls } = makeStore(undefined);
    createVisibilityAdapter(store).hide([{ modelId: MODEL_ID, expressId: ASSEMBLY_EXPRESS_ID }]);

    assert.deepEqual(
      hideCalls[0],
      [ASSEMBLY_GLOBAL_ID],
      'before the renderer mounts there is nothing to resolve against; the union policy keeps ' +
      'the raw ids so the call is never silently dropped',
    );
  });
});
