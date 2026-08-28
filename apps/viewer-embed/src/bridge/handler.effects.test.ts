/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `SET_CAMERA` / `SET_COLORS` / `RESET_COLORS` against the REAL store slices.
 *
 * `handler.test.ts` drives a recording double of the store, which is the right
 * shape for "did the bridge dispatch the right thing" but is structurally
 * blind to the failure these three commands actually had (#2934): the handler
 * called a real store action, the action existed, and the action did nothing.
 * A double records the call and passes.
 *
 * So this file wires the handler to `createDataSlice` / `createCameraSlice`
 * themselves and asserts the EFFECT — the mesh color that comes back, the
 * orientation that reaches the camera actuator, the overlay channel that is
 * still intact afterwards.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// Same narrow stand-in handler.test.ts uses: the bridge needs exactly one
// function from the store barrel, and importing the real barrel would drag in
// zustand + renderer + wasm. The slice creators below are imported directly,
// so the store logic under test is the real thing.
vi.mock('@/store/index.js', () => ({
  toGlobalIdFromModels: (
    _models: ReadonlyMap<string, { idOffset?: number }>,
    _modelId: string,
    expressId: number,
  ): number => expressId,
}));

import { EMBED_SOURCE, PROTOCOL_VERSION } from '@ifc-lite/embed-protocol';
import { createDataSlice } from '@/store/slices/dataSlice.js';
import { createCameraSlice, cameraTeardown } from '@/store/slices/cameraSlice.js';
import type { CameraRotation } from '@/store/types.js';
import { initBridge, destroyBridge } from './handler.js';
import { hostPoseAppliedToCurrentModel, resetCameraIntent } from './cameraIntent.js';

// ---------------------------------------------------------------------------
// Window double (postMessage in, postMessage out)
// ---------------------------------------------------------------------------

function installWindow() {
  const listeners = new Set<(e: unknown) => void>();
  const win: any = {
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      if (type === 'message') listeners.add(fn);
    },
    removeEventListener: (type: string, fn: (e: unknown) => void) => {
      if (type === 'message') listeners.delete(fn);
    },
  };
  win.parent = { postMessage: () => { /* replies are not the subject here */ } };
  (globalThis as any).window = win;
  return {
    dispatch: (data: unknown) => {
      for (const fn of [...listeners]) fn({ data, origin: 'https://host.example', source: win.parent });
    },
  };
}

function cmd(type: string, data?: unknown) {
  return { source: EMBED_SOURCE, version: PROTOCOL_VERSION, type, data, requestId: 'r1' };
}

// ---------------------------------------------------------------------------
// Real slices, composed the way the store composes them
// ---------------------------------------------------------------------------

const mesh = (expressId: number, color: [number, number, number, number]) => ({
  expressId,
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  color,
  ifcType: 'IfcWall',
});

function makeRealState() {
  const rotations: CameraRotation[] = [];
  let state: any;
  const set = (partial: any) => {
    const updates = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...updates };
  };
  const get = () => state;

  state = {
    ...createDataSlice(set, get, undefined as never),
    ...createCameraSlice(set, get, undefined as never),
    activeModelId: null,
    models: new Map(),
    // Stand-in for the renderer-side actuator the Viewport registers
    // (Viewport.tsx -> camera.setRotation). What it does with the angles is
    // `packages/renderer/src/camera-absolute-rotation.test.ts`'s subject; what
    // matters here is that the command reaches it at all.
    cameraCallbacks: {
      setCameraRotation: (rotation: CameraRotation) => { rotations.push(rotation); },
    },
  };

  return {
    rotations,
    getState: () => state,
  };
}

describe('bridge commands against the real store slices', () => {
  let win: ReturnType<typeof installWindow>;
  let store: ReturnType<typeof makeRealState>;

  beforeEach(() => {
    win = installWindow();
    store = makeRealState();
    initBridge({
      getState: store.getState as never,
      loadModelFromUrl: vi.fn(),
      loadModelFromBuffer: vi.fn(),
      addModelFromUrl: vi.fn(),
    } as never);
  });

  afterEach(() => {
    destroyBridge();
  });

  describe('SET_CAMERA', () => {
    it('reaches the camera actuator, not just the store field', () => {
      // The whole defect: `setCameraRotation` wrote `cameraRotation` and
      // stopped there, so the host got a success ack and a CAMERA_CHANGED echo
      // of its own numbers while the view never moved.
      win.dispatch(cmd('SET_CAMERA', { azimuth: 120, elevation: 30 }));

      expect(store.rotations).toEqual([{ azimuth: 120, elevation: 30 }]);
    });

    it('records the new orientation in the store as well', () => {
      win.dispatch(cmd('SET_CAMERA', { azimuth: 120, elevation: 30 }));

      expect(store.getState().cameraRotation).toEqual({ azimuth: 120, elevation: 30 });
    });
  });

  describe('RESET_COLORS', () => {
    it('actually restores the color SET_COLORS baked in', () => {
      store.getState().appendGeometryBatch([mesh(12, [1, 0, 0, 1])] as never);

      win.dispatch(cmd('SET_COLORS', { colorMap: { '12': [0, 1, 0, 1] } }));
      expect(store.getState().geometryResult.meshes[0].color).toEqual([0, 1, 0, 1]);

      win.dispatch(cmd('RESET_COLORS'));

      expect(store.getState().geometryResult.meshes[0].color).toEqual([1, 0, 0, 1]);
      // And the renderer is told to re-upload the restored color, otherwise the
      // GPU keeps showing the override.
      expect(store.getState().pendingMeshColorUpdates.get(12)).toEqual([1, 0, 0, 1]);
    });

    it('leaves another subsystem\'s overlay colors intact', () => {
      // `pendingColorUpdates` is the lens / IDS / clash / schedule overlay
      // channel. RESET_COLORS used to clear exactly this and nothing else —
      // wrong in both directions at once: the host's own override survived,
      // and an overlay owner's state was destroyed.
      store.getState().appendGeometryBatch([mesh(12, [1, 0, 0, 1])] as never);
      store.getState().setPendingColorUpdates(new Map([[12, [1, 1, 0, 1]]]));

      win.dispatch(cmd('SET_COLORS', { colorMap: { '12': [0, 1, 0, 1] } }));
      win.dispatch(cmd('RESET_COLORS'));

      expect(store.getState().pendingColorUpdates.get(12)).toEqual([1, 1, 0, 1]);
    });
  });
});

// ---------------------------------------------------------------------------
// #3390: a host pose commanded around a destructive load
// ---------------------------------------------------------------------------

/**
 * Same real-slice composition as above, but the renderer starts UNregistered —
 * which is the state `pendingCameraRotation` exists for — and the load
 * stand-in applies the one thing `resetViewerState()` contributes to this
 * slice, at the point in the bridge's async chain where it really lands: after
 * `loadModelFromUrl`'s fetch, not inside the LOAD_MODEL message task.
 */
function makeLoadableState() {
  const driven: CameraRotation[] = [];
  let state: any;
  const set = (partial: any) => {
    const updates = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...updates };
  };
  const get = () => state;
  state = { ...createCameraSlice(set, get, undefined as never), models: new Map() };

  return {
    driven,
    /** Every url `LOAD_MODEL` actually asked the adapter to fetch. */
    loadedUrls: [] as string[],
    getState: () => state,
    sessionReset: () => set(cameraTeardown.teardown({ kind: 'session-reset' }, state)),
    registerRenderer: () => state.setCameraCallbacks({
      setCameraRotation: (rotation: CameraRotation) => { driven.push(rotation); },
    }),
  };
}

describe('a host camera pose around a destructive load (#3390)', () => {
  let win: ReturnType<typeof installWindow>;
  let store: ReturnType<typeof makeLoadableState>;
  let releaseFetch: () => void;

  /** Let every queued microtask (and the load's own continuation) run. */
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    win = installWindow();
    store = makeLoadableState();
    resetCameraIntent();
    const fetched = new Promise<void>((resolve) => { releaseFetch = resolve; });
    initBridge({
      getState: store.getState as never,
      loadModelFromUrl: async (url: string) => {
        // `EmbedViewer.tsx`'s adapter: fetch, read the body, and only then
        // `loadFile` — whose `resetViewerState()` is the reset below.
        store.loadedUrls.push(url);
        await fetched;
        store.sessionReset();
        return { entities: 0, triangles: 0, vertices: 0 };
      },
      loadModelFromBuffer: async () => {
        // No pre-reset await on this path (`EmbedViewer.tsx` hands the buffer
        // straight to `loadFile`), so the reset lands inside the message task.
        store.sessionReset();
        return { entities: 0, triangles: 0, vertices: 0 };
      },
      addModelFromUrl: vi.fn(),
    } as never);
  });

  afterEach(() => {
    destroyBridge();
    resetCameraIntent();
  });

  it('applies a SET_CAMERA sent during the load fetch to the model that arrives', async () => {
    // `v.loadModel(url); v.setCamera(137, 61);` with neither call awaited.
    win.dispatch(cmd('LOAD_MODEL', { url: 'https://host.example/m.ifc' }));
    win.dispatch(cmd('SET_CAMERA', { azimuth: 137, elevation: 61 }));

    releaseFetch();
    await settle();

    // The wrapper forwards to the real adapter with the real payload; it is a
    // hold, not a substitute for the load.
    expect(store.loadedUrls).toEqual(['https://host.example/m.ifc']);

    // Nothing was registered to actuate it, so it is armed for replay — and
    // this time the session reset that just ran cannot reach it.
    expect(store.getState().pendingCameraRotation).toEqual({ azimuth: 137, elevation: 61 });
    expect(hostPoseAppliedToCurrentModel()).toBe(true);

    store.registerRenderer();

    expect(store.driven).toEqual([{ azimuth: 137, elevation: 61 }]);
  });

  it('holds a mid-load SET_CAMERA back even when a renderer IS registered', async () => {
    // The same ordering with a live renderer — a second load into an embed
    // that is already showing something. Nothing here is `pending`, so the
    // store-level replay cannot help: applying the pose now aims the OUTGOING
    // scene, which is the half of #3390 a renderer-readiness gate cannot see.
    store.registerRenderer();

    win.dispatch(cmd('LOAD_MODEL', { url: 'https://host.example/m.ifc' }));
    win.dispatch(cmd('SET_CAMERA', { azimuth: 137, elevation: 61 }));

    // Still fetching: nothing may be driven onto the model that is leaving.
    // Without the hold this is where the pose lands, and the reset below then
    // makes it invisible to everything downstream.
    expect(store.driven).toEqual([]);

    releaseFetch();
    await settle();

    expect(store.driven).toEqual([{ azimuth: 137, elevation: 61 }]);
  });

  it('carries a SET_CAMERA sent just BEFORE the load through the session reset', async () => {
    // The reverse order. Nothing has registered a renderer, so the pose arms
    // `pendingCameraRotation` — which the load's reset then clears.
    win.dispatch(cmd('SET_CAMERA', { azimuth: 137, elevation: 61 }));
    win.dispatch(cmd('LOAD_MODEL', { url: 'https://host.example/m.ifc' }));

    releaseFetch();
    await settle();
    // Re-armed AFTER the reset rather than wiped by it.
    expect(store.getState().pendingCameraRotation).toEqual({ azimuth: 137, elevation: 61 });

    store.registerRenderer();

    expect(store.driven).toEqual([{ azimuth: 137, elevation: 61 }]);
  });

  it('carries a SET_CAMERA sent before LOAD_MODEL_BUFFER, whose reset is synchronous', async () => {
    // The buffer path has no fetch, so nothing can be commanded DURING it —
    // but a pose armed just before it still meets the same session reset, and
    // the queue has to lift it for the same reason.
    win.dispatch(cmd('SET_CAMERA', { azimuth: 137, elevation: 61 }));
    win.dispatch(cmd('LOAD_MODEL_BUFFER', new ArrayBuffer(8)));

    await settle();
    expect(store.getState().pendingCameraRotation).toEqual({ azimuth: 137, elevation: 61 });

    store.registerRenderer();

    expect(store.driven).toEqual([{ azimuth: 137, elevation: 61 }]);
  });

  it('does NOT replay a pose the outgoing model already showed (#3364 stays closed)', async () => {
    // The renderer is registered first, so this pose is actuated immediately —
    // the user watched the outgoing model at it. It must die with that model.
    store.registerRenderer();
    win.dispatch(cmd('SET_CAMERA', { azimuth: 137, elevation: 61 }));
    expect(store.driven).toEqual([{ azimuth: 137, elevation: 61 }]);

    win.dispatch(cmd('LOAD_MODEL', { url: 'https://host.example/m.ifc' }));
    releaseFetch();
    await settle();

    // Still exactly the one call from before the load: nothing was replayed
    // onto the incoming model, and nothing is armed to replay later.
    expect(store.driven).toEqual([{ azimuth: 137, elevation: 61 }]);
    expect(store.getState().pendingCameraRotation).toBeNull();
    expect(hostPoseAppliedToCurrentModel()).toBe(false);
  });
});
