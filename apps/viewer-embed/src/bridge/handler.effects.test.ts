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

function installWindow(log?: (entry: string) => void) {
  const listeners = new Set<(e: unknown) => void>();
  const win: any = {
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      if (type === 'message') listeners.add(fn);
    },
    removeEventListener: (type: string, fn: (e: unknown) => void) => {
      if (type === 'message') listeners.delete(fn);
    },
  };
  // Replies are not the subject for most of this file, but WHEN a reply is
  // posted is the whole subject of the ACK-ordering test below, so the command
  // responses go on the caller's timeline alongside the camera actuations.
  // Events (READY, MODEL_LOADED, ...) carry no `responseId` and are skipped.
  win.parent = {
    postMessage: (msg: any) => {
      if (msg?.responseId) log?.(`ack:${msg.responseId}`);
    },
  };
  (globalThis as any).window = win;
  return {
    dispatch: (data: unknown) => {
      for (const fn of [...listeners]) fn({ data, origin: 'https://host.example', source: win.parent });
    },
  };
}

function cmd(type: string, data?: unknown, requestId = 'r1') {
  return { source: EMBED_SOURCE, version: PROTOCOL_VERSION, type, data, requestId };
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
function makeLoadableState(log?: (entry: string) => void) {
  const driven: CameraRotation[] = [];
  let state: any;
  const set = (partial: any) => {
    const updates = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...updates };
  };
  const get = () => state;
  // `geometryResult` starts null, as it does in a freshly mounted embed: the
  // store field is what says whether ANY model has ever been on screen here,
  // and a session reset deliberately leaves it alone (`dataSlice.teardown.ts`:
  // "the loader writes both straight after"), so it names the OUTGOING model
  // right up to the moment the incoming one lands.
  state = {
    ...createCameraSlice(set, get, undefined as never),
    models: new Map(),
    geometryResult: null,
  };

  return {
    driven,
    /** Every url `LOAD_MODEL` actually asked the adapter to fetch. */
    loadedUrls: [] as string[],
    getState: () => state,
    sessionReset: () => set(cameraTeardown.teardown({ kind: 'session-reset' }, state)),
    /** What `loadFile` does after the reset: a model appears on screen. */
    publishModel: () => set({ geometryResult: { meshes: [{ expressId: 1 }] } }),
    /** A spatial-only IFC — storeys and spaces, no geometry. `geometryResult`
     *  is non-null and `meshes` is EMPTY. A real state in this repo, not a
     *  pathological one, and the case a mesh COUNT would misread. */
    publishModelWithNoMeshes: () => set({ geometryResult: { meshes: [] } }),
    registerRenderer: () => state.setCameraCallbacks({
      setCameraRotation: (rotation: CameraRotation) => {
        driven.push(rotation);
        log?.(`camera:${rotation.azimuth},${rotation.elevation}`);
      },
    }),
  };
}

describe('a host camera pose around a destructive load (#3390)', () => {
  let win: ReturnType<typeof installWindow>;
  let store: ReturnType<typeof makeLoadableState>;
  let releaseFetch: () => void;
  let failFetch: (err: Error) => void;
  /** The url adapter's in-flight fetch. Re-armed per load so a test can hold
   *  TWO destructive loads open one after the other. */
  let fetched: Promise<void>;
  const rearmFetch = () => {
    fetched = new Promise<void>((resolve, reject) => {
      releaseFetch = resolve;
      failFetch = reject;
    });
  };
  /** Camera actuations and outbound command responses, in the order they
   *  happened. The ACK-ordering test is about exactly that interleaving. */
  let timeline: string[];

  /** Let every queued microtask (and the load's own continuation) run. */
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    timeline = [];
    const log = (entry: string) => { timeline.push(entry); };
    win = installWindow(log);
    store = makeLoadableState(log);
    resetCameraIntent();
    rearmFetch();
    initBridge({
      getState: store.getState as never,
      loadModelFromUrl: async (url: string) => {
        // `EmbedViewer.tsx`'s adapter: fetch, read the body, and only then
        // `loadFile` — whose `resetViewerState()` is the reset below.
        store.loadedUrls.push(url);
        await fetched;
        store.sessionReset();
        store.publishModel();
        return { entities: 0, triangles: 0, vertices: 0 };
      },
      loadModelFromBuffer: async () => {
        // No pre-reset await on this path (`EmbedViewer.tsx` hands the buffer
        // straight to `loadFile`), so the reset lands inside the message task.
        store.sessionReset();
        store.publishModel();
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
    // A model is on screen and the renderer is registered, so this pose is
    // actuated immediately — the user watched the OUTGOING model at it. It must
    // die with that model. The published model is what makes this #3364's case
    // rather than the empty-scene one below: same renderer, same immediate
    // actuation, opposite answer.
    store.registerRenderer();
    store.publishModel();
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

  it('does NOT replay a pose shown on a SPATIAL-ONLY model (zero meshes is still shown)', async () => {
    // The discriminator is whether a model was ever LOADED, not whether it has
    // geometry. A spatial-only IFC publishes a non-null `geometryResult` with
    // ZERO meshes, so a mesh COUNT calls it "never shown", re-lifts the pose the
    // user watched it at, and replays it onto the next file — #3364 re-opened
    // for the model class least likely to be tested. Same shape as the #3364
    // case above, with the only difference being an empty mesh list.
    store.registerRenderer();
    store.publishModelWithNoMeshes();
    win.dispatch(cmd('SET_CAMERA', { azimuth: 137, elevation: 61 }));
    expect(store.driven).toEqual([{ azimuth: 137, elevation: 61 }]);

    win.dispatch(cmd('LOAD_MODEL', { url: 'https://host.example/m.ifc' }));
    releaseFetch();
    await settle();

    expect(store.driven).toEqual([{ azimuth: 137, elevation: 61 }]);
    expect(store.getState().pendingCameraRotation).toBeNull();
    expect(hostPoseAppliedToCurrentModel()).toBe(false);
  });

  it('carries a pose actuated on the EMPTY first scene into the load that follows', async () => {
    // The gap Codex found. `Viewport` mounts before any model, so a host that
    // does `setCamera(...)` then `loadModel(url)` on a fresh embed hits a LIVE
    // actuator: the pose is applied to an empty scene and `cameraSlice` records
    // nothing (`pendingCameraRotation` is armed only when no actuator exists).
    // The lift used to read that field alone, found null, and the command was
    // gone — then `home()` framed the arriving model over the top of it.
    store.registerRenderer();

    win.dispatch(cmd('SET_CAMERA', { azimuth: 137, elevation: 61 }));
    expect(store.getState().pendingCameraRotation).toBeNull();

    win.dispatch(cmd('LOAD_MODEL', { url: 'https://host.example/m.ifc' }));
    releaseFetch();
    await settle();

    // Applied a second time, to the model that arrived — and marked, so the
    // first-load auto-fit frames with `fitAll` instead of homing it away.
    expect(store.driven).toEqual([
      { azimuth: 137, elevation: 61 },
      { azimuth: 137, elevation: 61 },
    ]);
    expect(hostPoseAppliedToCurrentModel()).toBe(true);
  });

  it('drops that same pose once a model HAS been shown at it (both halves, one fixture)', async () => {
    // The pair to the test above, differing only in whether a model was on
    // screen when the pose was actuated. Run as two real loads through the
    // bridge so the discriminator is the store's own `geometryResult`, written
    // by the first load, rather than a value the test placed there.
    store.registerRenderer();

    win.dispatch(cmd('LOAD_MODEL', { url: 'https://host.example/first.ifc' }, 'load1'));
    releaseFetch();
    await settle();
    expect(store.driven).toEqual([]);

    // Now the host aims the model it is looking at.
    win.dispatch(cmd('SET_CAMERA', { azimuth: 137, elevation: 61 }));
    expect(store.driven).toEqual([{ azimuth: 137, elevation: 61 }]);

    // ...and then replaces it. #3364: that pose belonged to the file leaving.
    rearmFetch();
    win.dispatch(cmd('LOAD_MODEL', { url: 'https://host.example/second.ifc' }, 'load2'));
    releaseFetch();
    await settle();

    expect(store.driven).toEqual([{ azimuth: 137, elevation: 61 }]);
    expect(hostPoseAppliedToCurrentModel()).toBe(false);
  });

  it('withholds the SET_CAMERA ACK until the queued pose has reached the camera', async () => {
    // A queue defers the EFFECT, so it has to defer the ACK with it. Before
    // #3390 `setCameraRotation` ran inside the SET_CAMERA handler and the reply
    // followed it, so `await v.setCamera(...); v.getScreenshot()` meant the
    // camera had already moved. ACKing on receipt gives that host back the
    // OUTGOING angle — an ordering regression the queue introduced, invisible
    // to every assertion about where the pose ends up.
    store.registerRenderer();
    store.publishModel();

    win.dispatch(cmd('LOAD_MODEL', { url: 'https://host.example/m.ifc' }, 'load1'));
    win.dispatch(cmd('SET_CAMERA', { azimuth: 137, elevation: 61 }, 'cam1'));
    await settle();

    // Still fetching: the pose is held, and so is the promise the host is
    // sitting on. Anything it would do after that await must not run yet.
    expect(store.driven).toEqual([]);
    expect(timeline).not.toContain('ack:cam1');

    releaseFetch();
    await settle();

    // The camera moves FIRST, then the host is told it may proceed.
    expect(timeline.filter((e) => e.startsWith('camera:') || e === 'ack:cam1'))
      .toEqual(['camera:137,61', 'ack:cam1']);
  });

  it('ACKs a held SET_CAMERA even when the load it was waiting on fails', async () => {
    // An ACK that never arrives is worse than a late one: the host's
    // `setCamera()` promise never settles and its whole command chain stalls.
    // The failing load applies the pose to the scene still on screen (nothing
    // was reset), so the reply is owed on that path too.
    store.registerRenderer();
    store.publishModel();

    win.dispatch(cmd('LOAD_MODEL', { url: 'https://host.example/boom.ifc' }, 'load1'));
    win.dispatch(cmd('SET_CAMERA', { azimuth: 137, elevation: 61 }, 'cam1'));
    await settle();
    expect(timeline).not.toContain('ack:cam1');

    failFetch(new Error('Failed to fetch model: Not Found'));
    await settle();

    expect(timeline.filter((e) => e.startsWith('camera:') || e === 'ack:cam1'))
      .toEqual(['camera:137,61', 'ack:cam1']);
  });
});
