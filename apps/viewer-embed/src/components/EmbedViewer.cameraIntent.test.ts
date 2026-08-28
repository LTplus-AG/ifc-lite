/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The component half of #3390.
 *
 * The bridge holding a host pose across a load is only half a fix if nothing
 * in the embed ever takes it back out, and applying it is only half of THAT if
 * the first-load auto-fit then tweens it away with `home()`. The last case
 * covers a third limb: the `?modelUrl=` auto-load opens the same
 * fetch-then-reset window as `LOAD_MODEL` and the bridge never sees it.
 *
 * None of that is visible to a store-level assertion — in the clobber case the
 * pose really is written to `cameraRotation` — so this mounts the real
 * component and watches the camera actuators it drives, the same harness
 * `EmbedViewer.urlParams.test.ts` uses for `?camera=`. The load stand-in
 * applies the REAL `cameraTeardown` session-reset patch and publishes the
 * model from INSIDE the load, where `loadFile` does both, so a pose that is
 * not carried across the load is genuinely destroyed rather than merely early.
 */

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { MeshData } from '@ifc-lite/geometry';

vi.mock('@/components/viewer/Viewport', () => ({ Viewport: () => null }));
vi.mock('@/components/viewer/ViewportOverlays', () => ({ ViewportOverlays: () => null }));

// happy-dom has no `navigator.gpu`; without this the `Viewport` subtree, the
// auto-load effect and the post-load effect are all unreachable and every
// assertion below would be vacuous.
vi.mock('@/hooks/useWebGPU', () => ({
  useWebGPU: () => ({ supported: true, checking: false, reason: null }),
}));

type Pose = { azimuth: number; elevation: number };

const geometryResult = {
  meshes: [{
    expressId: 1,
    ifcType: 'IfcWall',
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    indices: new Uint32Array(0),
    color: [1, 1, 1, 1],
  } as MeshData],
  totalVertices: 0,
  totalTriangles: 0,
};

/** Set by the mock below; drives `geometryResult` from test code via `act()`. */
let setMockGeometryResult: ((value: typeof geometryResult | null) => void) | null = null;
/** What `loadFile` contributes to the camera slice — the real teardown, wired below. */
let sessionReset: () => void = () => {};

// Both callbacks are module-level and STABLE. The bridge-init effect lists
// `loadFile` and `addModel` in its dependency array, so a fresh `vi.fn()` per
// render would tear the bridge down (and reset the camera queue with it) on
// every re-render — the test would then measure its own mock, not the fix.
const loadFile = vi.fn(async () => { sessionReset(); });
const addModel = vi.fn(async () => 'stub-model-id');

vi.mock('@/hooks/useIfc', () => ({
  useIfc: () => {
    const [gr, setGr] = React.useState<typeof geometryResult | null>(null);
    setMockGeometryResult = setGr;
    return {
      geometryResult: gr,
      ifcDataStore: null,
      loadFile,
      loading: false,
      models: new Map(),
      clearAllModels: vi.fn(),
      addModel,
    };
  },
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { EmbedViewer } = await import('./EmbedViewer.js');
const { useViewerStore } = await import('@/store');
const { cameraTeardown } = await import('@/store/slices/cameraSlice.js');
const { aroundDestructiveLoad, offerHostPose, resetCameraIntent } =
  await import('../bridge/cameraIntent.js');

sessionReset = () => {
  useViewerStore.setState(cameraTeardown.teardown({ kind: 'session-reset' }, useViewerStore.getState()));
};

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

/** `parseUrlParams()` runs once in a `useState` initialiser, so the search
 *  string has to be in place before the first render. */
function setSearch(search: string): void {
  window.history.replaceState({}, '', `/${search}`);
}

function renderEmbedViewer({ strict = false } = {}): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const tree = React.createElement(EmbedViewer);
  act(() => {
    root.render(strict ? React.createElement(React.StrictMode, null, tree) : tree);
  });
  mounted.push({ root, container });
}

async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve(); });
}

/** The model lands: what flips the post-load effect from idle to "a load ended". */
async function landModel(): Promise<void> {
  await act(async () => { setMockGeometryResult!(geometryResult); });
  await settle();
}

/** The post-load framing polls `requestAnimationFrame` for camera callbacks. */
async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

/**
 * One scene-replacing load with a host `SET_CAMERA` posted while it is still
 * fetching — driven through the real intent module rather than a stub of it,
 * so what the component consumes is what the bridge really leaves behind.
 */
async function loadWithHostPose(pose: Pose): Promise<void> {
  let releaseFetch!: () => void;
  const fetched = new Promise<void>((resolve) => { releaseFetch = resolve; });
  await act(async () => {
    const load = aroundDestructiveLoad(useViewerStore.getState, async () => {
      await fetched;
      // `loadFile`, in order: the session reset that #3364 added, then the
      // model itself. Both are inside the load, ahead of the point the
      // bridge's `await` resolves.
      sessionReset();
      setMockGeometryResult!(geometryResult);
    });
    offerHostPose(pose, useViewerStore.getState);
    releaseFetch();
    await load;
  });
  await settle();
}

let calls: string[];
let home: Mock<() => void>;
let fitAll: Mock<() => void>;
let setCameraRotation: Mock<(rotation: Pose) => void>;

beforeEach(() => {
  resetCameraIntent();
  loadFile.mockClear();
  calls = [];
  home = vi.fn(() => { calls.push('home'); });
  fitAll = vi.fn(() => { calls.push('fitAll'); });
  setCameraRotation = vi.fn((r: Pose) => {
    calls.push(`setCameraRotation:${r.azimuth},${r.elevation}`);
  });
  useViewerStore.setState({ cameraCallbacks: { home, fitAll, setCameraRotation } });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ArrayBuffer(8), { status: 200 })));
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
  setSearch('');
  resetCameraIntent();
  useViewerStore.setState({ cameraCallbacks: {} });
});

describe('EmbedViewer: a host pose queued against the load (#3390)', () => {
  it('drives the camera to the queued pose once the model has landed', async () => {
    renderEmbedViewer();
    await settle();

    await loadWithHostPose({ azimuth: 137, elevation: 61 });
    await nextFrame();

    expect(setCameraRotation).toHaveBeenCalledWith({ azimuth: 137, elevation: 61 });
  });

  it('frames the model instead of homing it, so the pose is not tweened away', async () => {
    renderEmbedViewer();
    await settle();

    await loadWithHostPose({ azimuth: 137, elevation: 61 });
    await nextFrame();

    // `home()` animates to the default orientation, which would undo the pose
    // that was just applied — an ACKed command with no visible effect, the
    // exact symptom #3390 reports, reached through the framing path instead of
    // through the session reset.
    expect(home).not.toHaveBeenCalled();
    expect(calls).toEqual(['setCameraRotation:137,61', 'fitAll']);
  });

  it('still homes the first model when the host asked for nothing', async () => {
    renderEmbedViewer();
    await settle();

    await landModel();
    await nextFrame();

    expect(calls).toEqual(['home']);
  });

  it('holds the pose across the ?modelUrl= auto-load, which the bridge never sees', async () => {
    // The auto-load effect fetches and only then calls `loadFile`, exactly like
    // the bridge's LOAD_MODEL adapter — so a SET_CAMERA arriving mid-fetch is
    // applied to the outgoing scene and wiped by the reset unless this path is
    // wrapped too.
    let releaseFetch!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { releaseFetch = resolve; })));

    setSearch('?modelUrl=https%3A%2F%2Fcdn.example%2Fa.ifc');
    renderEmbedViewer();
    await settle();

    offerHostPose({ azimuth: 137, elevation: 61 }, useViewerStore.getState);
    releaseFetch(new Response(new ArrayBuffer(8), { status: 200 }));
    await settle();
    expect(loadFile, 'the auto-load must actually have reached loadFile').toHaveBeenCalled();

    await landModel();
    await nextFrame();

    expect(calls).toEqual(['setCameraRotation:137,61', 'fitAll']);
  });

  it('survives the StrictMode remount that happens mid-fetch on that auto-load', async () => {
    // `apps/viewer-embed/src/main.tsx` renders under <React.StrictMode>, so in
    // dev every effect is mount -> cleanup -> remount. The auto-load effect is
    // ref-guarded and does NOT restart, so its fetch is still outstanding when
    // the OTHER effects' cleanups run. Anything those cleanups do to the camera
    // queue therefore lands in the middle of a live load: it drops the held
    // pose and leaves the rest of the load uncounted, so the SET_CAMERA below
    // takes `offerHostPose`'s no-load path, is applied to the outgoing scene,
    // and is wiped by `loadFile`'s reset — then `home()` frames the model that
    // arrives, which is the #3390 symptom reappearing in the dev build only.
    let releaseFetch!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { releaseFetch = resolve; })));

    setSearch('?modelUrl=https%3A%2F%2Fcdn.example%2Fa.ifc');
    renderEmbedViewer({ strict: true });
    await settle();

    offerHostPose({ azimuth: 137, elevation: 61 }, useViewerStore.getState);
    releaseFetch(new Response(new ArrayBuffer(8), { status: 200 }));
    await settle();
    expect(loadFile, 'the auto-load must actually have reached loadFile').toHaveBeenCalled();

    await landModel();
    await nextFrame();

    expect(calls).toEqual(['setCameraRotation:137,61', 'fitAll']);
  });
});
