/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4264 / #4266: the three camera methods on `ViewerBackendMethods` were
 * stubs that ignored the data flowing through them —
 *
 *   - `getCamera()` returned `{ mode }` only, so the SDK's own documented
 *     `bim.bcf.createViewpoint({ camera: bim.viewer.getCamera() })` pattern
 *     always built a positionless viewpoint (#4264).
 *   - `setCamera(state)` applied only `state.mode`; `position`/`target`/`up`
 *     were silently dropped (noted on #4264).
 *   - `flyTo(refs)` was a complete no-op (`flyTo.length === 0` — it did not
 *     even declare a parameter) whose comment falsely claimed it was "wired
 *     via useBimHost" (#4266).
 *
 * All three now go through `cameraCallbacks` (`store/types.ts`) — the same
 * non-React entry point `lib/tours/snapshot.ts`, `store/basket
 * /basketViewActivator.ts` and `store/slices/pinboardSlice.ts` already use to
 * read/apply a live camera pose, and the same `frameEntities` callback
 * `SearchModal.filter.tsx` already uses to frame a resolved id set.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createViewerAdapter } from './viewer-adapter.js';
import type { StoreApi } from './types.js';

const MODEL_ID = 'default';
const ASSEMBLY_ID = 42;
const PART_A = 9001;
const PART_B = 9002;

type Viewpoint = {
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  up: { x: number; y: number; z: number };
  fov: number;
  projectionMode: 'perspective' | 'orthographic';
  orthoSize?: number;
};

/** Mirrors the real resolver: a geometry-less assembly becomes its
 *  geometry-bearing parts; anything else resolves to itself (#3338). */
const assemblyResolver = (ids: number[]) =>
  ids.flatMap((id) => (id === ASSEMBLY_ID ? [PART_A, PART_B] : [id]));

function makeStore(initial?: Partial<Viewpoint>) {
  let viewpoint: Viewpoint = {
    position: { x: 1, y: 2, z: 3 },
    target: { x: 4, y: 5, z: 6 },
    up: { x: 0, y: 1, z: 0 },
    fov: 0.9,
    projectionMode: 'perspective',
    ...initial,
  };
  const applyViewpointCalls: Array<[Viewpoint, boolean | undefined]> = [];
  const frameEntitiesCalls: number[][] = [];
  const resolverCalls: number[][] = [];

  const state = {
    models: new Map([[MODEL_ID, { idOffset: 0 }]]),
    get projectionMode() {
      return viewpoint.projectionMode;
    },
    setProjectionMode: (mode: 'perspective' | 'orthographic') => {
      viewpoint = { ...viewpoint, projectionMode: mode };
    },
    cameraCallbacks: {
      getViewpoint: () => viewpoint,
      applyViewpoint: (next: Viewpoint, animate?: boolean) => {
        applyViewpointCalls.push([next, animate]);
        viewpoint = next;
      },
      frameEntities: (ids: number[]) => {
        frameEntitiesCalls.push(ids);
      },
      resolveHighlightIds: (ids: number[]) => {
        resolverCalls.push(ids);
        return assemblyResolver(ids);
      },
    },
  };
  const store = {
    getState: () => state,
    subscribe: () => () => {},
  } as unknown as StoreApi;
  return { store, applyViewpointCalls, frameEntitiesCalls, resolverCalls, getViewpoint: () => viewpoint };
}

describe('getCamera()', () => {
  it('returns real position/target/up from cameraCallbacks.getViewpoint, not just mode', () => {
    const { store } = makeStore({
      position: { x: 10, y: 20, z: 30 },
      target: { x: -1, y: -2, z: -3 },
      up: { x: 0, y: 0, z: 1 },
    });
    const adapter = createViewerAdapter(store);

    const camera = adapter.getCamera();

    assert.equal(camera.mode, 'perspective');
    assert.deepEqual(camera.position, [10, 20, 30]);
    assert.deepEqual(camera.target, [-1, -2, -3]);
    assert.deepEqual(camera.up, [0, 0, 1]);
  });

  it('falls back to { mode } only when no viewport is mounted', () => {
    const { store } = makeStore();
    store.getState().cameraCallbacks.getViewpoint = undefined as unknown as () => Viewpoint;
    const adapter = createViewerAdapter(store);

    const camera = adapter.getCamera();

    assert.deepEqual(camera, { mode: 'perspective' });
  });
});

describe('setCamera()', () => {
  it('applies position/target/up, not only mode', () => {
    const { store, applyViewpointCalls, getViewpoint } = makeStore();
    const adapter = createViewerAdapter(store);

    adapter.setCamera({
      mode: 'orthographic',
      position: [100, 200, 300],
      target: [7, 8, 9],
      up: [0, 0, -1],
    });

    assert.equal(applyViewpointCalls.length, 1, 'applyViewpoint must be called exactly once');
    const [applied, animate] = applyViewpointCalls[0];
    assert.deepEqual(applied.position, { x: 100, y: 200, z: 300 });
    assert.deepEqual(applied.target, { x: 7, y: 8, z: 9 });
    assert.deepEqual(applied.up, { x: 0, y: 0, z: -1 });
    assert.equal(animate, false, 'setCamera must apply immediately, not animate');
    // mode was applied via setProjectionMode BEFORE getViewpoint() was read for the merge,
    // so the merged/applied viewpoint carries the new mode too.
    assert.equal(applied.projectionMode, 'orthographic');
    assert.equal(getViewpoint().position.x, 100);
  });

  it('a partial update (position only) preserves the current target/up', () => {
    const { store, applyViewpointCalls } = makeStore({
      target: { x: 4, y: 5, z: 6 },
      up: { x: 0, y: 1, z: 0 },
    });
    const adapter = createViewerAdapter(store);

    adapter.setCamera({ position: [42, 42, 42] });

    const [applied] = applyViewpointCalls[0];
    assert.deepEqual(applied.position, { x: 42, y: 42, z: 42 });
    assert.deepEqual(applied.target, { x: 4, y: 5, z: 6 }, 'target must be preserved, not zeroed');
    assert.deepEqual(applied.up, { x: 0, y: 1, z: 0 }, 'up must be preserved, not zeroed');
  });

  it('mode-only call does not touch position/target/up (no applyViewpoint call)', () => {
    const { store, applyViewpointCalls } = makeStore();
    const adapter = createViewerAdapter(store);

    adapter.setCamera({ mode: 'orthographic' });

    assert.equal(applyViewpointCalls.length, 0);
    assert.equal(store.getState().projectionMode, 'orthographic');
  });
});

describe('flyTo()', () => {
  it('accepts refs (flyTo.length !== 0, unlike the old stub)', () => {
    const { store } = makeStore();
    const adapter = createViewerAdapter(store);
    assert.equal(adapter.flyTo.length, 1, 'flyTo must declare its refs parameter');
  });

  it('invokes frameEntities with the resolved global ids', () => {
    const { store, frameEntitiesCalls, resolverCalls } = makeStore();
    const adapter = createViewerAdapter(store);
    const refA = { modelId: MODEL_ID, expressId: 7 };
    const refB = { modelId: MODEL_ID, expressId: 8 };

    adapter.flyTo([refA, refB]);

    assert.equal(frameEntitiesCalls.length, 1);
    assert.deepEqual(frameEntitiesCalls[0], [7, 8]);
    assert.deepEqual(resolverCalls, [[7, 8]], 'resolveHighlightIds must see the raw global ids');
  });

  it('expands a geometry-less assembly ref to its parts, same as colorize() (#3338)', () => {
    const { store, frameEntitiesCalls } = makeStore();
    const adapter = createViewerAdapter(store);
    const assemblyRef = { modelId: MODEL_ID, expressId: ASSEMBLY_ID };

    adapter.flyTo([assemblyRef]);

    assert.equal(frameEntitiesCalls.length, 1);
    const framed = new Set(frameEntitiesCalls[0]);
    assert.ok(framed.has(PART_A), 'must frame part A');
    assert.ok(framed.has(PART_B), 'must frame part B');
  });

  it('skips a ref whose model is not loaded', () => {
    const { store, frameEntitiesCalls } = makeStore();
    const adapter = createViewerAdapter(store);
    const unloadedRef = { modelId: 'not-loaded', expressId: 1 };
    const loadedRef = { modelId: MODEL_ID, expressId: 7 };

    adapter.flyTo([unloadedRef, loadedRef]);

    assert.deepEqual(frameEntitiesCalls[0], [7]);
  });
});
