/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `?select=`, `?isolate=`, `?hideTypes=` and `?camera=` were parsed and then
 * never read (#2934).
 *
 * `urlParams.test.ts` pins the PARSING of all four. Nothing asserted that the
 * parsed value is ever APPLIED, and for these four it never was: a `grep` for
 * `urlParams.select` / `.isolate` / `.hideTypes` across `apps/viewer-embed`
 * matched only the parser and its own test, and `urlParams.camera` matched
 * exactly one production line — an `else if (urlParams.camera) { }` branch
 * whose body was the comment "?camera= is handled elsewhere". Nowhere else
 * handled it.
 *
 * Same failure shape as the `autoLoad` bug (`EmbedViewer.autoLoad.test.ts`):
 * a thoroughly tested parser feeding an application that does not exist.
 *
 * These assert on OBSERVABLE effects, not on wiring — store state for
 * select/isolate, the mesh list actually handed to `Viewport` for hideTypes,
 * and the camera callbacks actually invoked for camera. A test that only
 * checked "the hook is called" would survive deleting the hook's body.
 *
 * The `useWebGPU` mock is load-bearing for exactly the reason the autoLoad
 * file records: happy-dom has no `navigator.gpu`, so without it `Viewport` is
 * never rendered at all and the hideTypes/camera assertions would be vacuous.
 */

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { MeshData } from '@ifc-lite/geometry';
import { EMBED_SOURCE, PROTOCOL_VERSION } from '@ifc-lite/embed-protocol';
import { symbolicOverlayGate } from '@/lib/symbolic-overlay-gate.js';

/** Captured props of the last `Viewport` render — what the embed actually draws. */
let lastViewportGeometry: MeshData[] | null = null;
vi.mock('@/components/viewer/Viewport', () => ({
  Viewport: (props: { geometry: MeshData[] | null }) => {
    lastViewportGeometry = props.geometry;
    return null;
  },
}));
vi.mock('@/components/viewer/ViewportOverlays', () => ({ ViewportOverlays: () => null }));

// happy-dom has no `navigator.gpu`; without this the `Viewport` subtree and
// the auto-fit effect are both unreachable.
vi.mock('@/hooks/useWebGPU', () => ({
  useWebGPU: () => ({ supported: true, checking: false, reason: null }),
}));

function mesh(expressId: number, ifcType: string): MeshData {
  return {
    expressId,
    ifcType,
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    indices: new Uint32Array(0),
    color: [1, 1, 1, 1],
  };
}

const MESHES = [
  mesh(1, 'IfcWall'),
  mesh(2, 'IfcSpace'),
  mesh(3, 'IfcDoor'),
  mesh(4, 'IfcOpeningElement'),
];

const geometryResult = {
  meshes: MESHES,
  totalVertices: 0,
  totalTriangles: 0,
};

/**
 * `geometryResult` is normally read straight from `useIfc()` (a static mock
 * below). The `?isolate=` re-application test needs `modelReady` — derived
 * in `EmbedViewer` as `Boolean(geometryResult?.meshes?.length)` — to flip
 * false -> true -> false -> true on an ALREADY-MOUNTED component, mirroring
 * a model being cleared and another loading. A closed-over object can't do
 * that: nothing about it changing would cause React to re-render. Routing it
 * through `React.useState` inside the mock makes it a real reactive value —
 * `setMockGeometryResult` (below) drives it from test code via `act()`.
 */
let setMockGeometryResult: ((value: typeof geometryResult | null) => void) | null = null;

vi.mock('@/hooks/useIfc', () => ({
  useIfc: () => {
    const [gr, setGr] = React.useState<typeof geometryResult | null>(geometryResult);
    setMockGeometryResult = setGr;
    return {
      geometryResult: gr,
      ifcDataStore: null,
      loadFile: vi.fn(async () => {}),
      loading: false,
      models: new Map(),
      clearAllModels: vi.fn(),
      addModel: vi.fn(async () => 'stub-model-id'),
    };
  },
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { EmbedViewer } = await import('./EmbedViewer.js');
const { useViewerStore } = await import('@/store');

// Captured once so tests that spy on these actions (wrapping them with
// `vi.fn(original)`) can restore the unwrapped originals afterward, rather
// than leaving one test's spy as the next test's "real" implementation.
const originalIsolateEntities = useViewerStore.getState().isolateEntities;
const originalSetIsolatedEntities = useViewerStore.getState().setIsolatedEntities;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

/** `parseUrlParams()` runs once in a `useState` initialiser, so the search
 *  string has to be in place before the first render. */
function setSearch(search: string): void {
  window.history.replaceState({}, '', `/${search}`);
}

function renderEmbedViewer(): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(EmbedViewer));
  });
  mounted.push({ root, container });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/** The auto-fit effect polls `requestAnimationFrame` for camera callbacks. */
async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

beforeEach(() => {
  lastViewportGeometry = null;
  useViewerStore.setState({
    hostHiddenIfcTypes: null,
    selectedEntityIds: new Set<number>(),
    selectedEntityId: null,
    isolatedEntities: null,
    cameraCallbacks: {},
    // `typeVisibility` defaults hide IfcSpace and IfcOpeningElement, which
    // would make the ?hideTypes= assertions below pass for the wrong reason.
    // Turn every semantic toggle ON so the only thing removing a mesh is the
    // parameter under test.
    typeVisibility: {
      ...useViewerStore.getState().typeVisibility,
      spaces: true,
      openings: true,
      site: true,
    },
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ArrayBuffer(8), { status: 200 })));
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
  setSearch('');
  useViewerStore.setState({
    isolateEntities: originalIsolateEntities,
    setIsolatedEntities: originalSetIsolatedEntities,
  });
});

describe('EmbedViewer: ?select=', () => {
  it('selects the listed entities once geometry is on screen', async () => {
    setSearch('?select=2,3');
    renderEmbedViewer();
    await settle();

    const state = useViewerStore.getState();
    expect([...state.selectedEntityIds].sort()).toEqual([2, 3]);
    expect(state.selectedEntityId).toBe(3);
  });

  it('leaves the selection alone when ?select= is absent', async () => {
    setSearch('');
    renderEmbedViewer();
    await settle();

    expect(useViewerStore.getState().selectedEntityIds.size).toBe(0);
  });
});

describe('EmbedViewer: ?isolate=', () => {
  it('isolates the listed entities', async () => {
    setSearch('?isolate=1,4');
    renderEmbedViewer();
    await settle();

    const isolated = useViewerStore.getState().isolatedEntities;
    expect(isolated).not.toBeNull();
    expect([...isolated!].sort()).toEqual([1, 4]);
  });

  it('applies isolation with the ASSIGNING actuator, not the same-set TOGGLE', async () => {
    // `visibilitySlice.isolateEntities` CLEARS isolation when called twice
    // with the same ids; `setIsolatedEntities` assigns and can never
    // self-cancel. `useEmbedUrlParams` deliberately uses the latter. Spying
    // on both catches a swap to the wrong one directly — this does not rely
    // on the effect ever running a second time (see the guard test below for
    // that half of the story, which a swapped-but-single-shot actuator
    // cannot expose).
    const isolateEntitiesSpy = vi.fn(useViewerStore.getState().isolateEntities);
    const setIsolatedEntitiesSpy = vi.fn(useViewerStore.getState().setIsolatedEntities);
    useViewerStore.setState({
      isolateEntities: isolateEntitiesSpy,
      setIsolatedEntities: setIsolatedEntitiesSpy,
    });

    setSearch('?isolate=1,4');
    renderEmbedViewer();
    await settle();

    expect(setIsolatedEntitiesSpy).toHaveBeenCalledTimes(1);
    expect(setIsolatedEntitiesSpy).toHaveBeenCalledWith(new Set([1, 4]));
    expect(isolateEntitiesSpy).not.toHaveBeenCalled();
  });

  it('stays isolated across a modelReady false -> true -> false -> true transition', async () => {
    // This is the reachable production path: `modelReady` is
    // `Boolean(geometryResult?.meshes?.length)`, which flips exactly this way
    // when a model is cleared and another loads. The `applied.current` ref
    // guard exists to stop the effect from re-applying `?isolate=` on that
    // later flip — without it, this sequence calls the actuator with the
    // SAME ids a second time, and a same-set TOGGLE actuator would clear
    // isolation right back out, silently, with no error.
    // The assertion has to count ACTUATOR CALLS, not inspect the end state.
    // `setIsolatedEntities` ASSIGNS, so isolation is `{1}` at the end whether
    // the effect ran once or twice -- an earlier version of this test checked
    // only the end state and stayed green with the ref guard deleted, which
    // is the exact thing it is named for. The spy is held across the whole
    // sequence for that reason.
    const setIsolatedEntitiesSpy = vi.fn(useViewerStore.getState().setIsolatedEntities);
    useViewerStore.setState({ setIsolatedEntities: setIsolatedEntitiesSpy });

    setSearch('?isolate=1');
    renderEmbedViewer();
    await settle();
    expect([...useViewerStore.getState().isolatedEntities!]).toEqual([1]);
    expect(setIsolatedEntitiesSpy).toHaveBeenCalledTimes(1);

    // Model cleared...
    act(() => setMockGeometryResult!(null));
    await settle();
    // ...and another one loaded. `modelReady` flips back to true.
    act(() => setMockGeometryResult!(geometryResult));
    await settle();

    const isolated = useViewerStore.getState().isolatedEntities;
    expect(isolated ? [...isolated].sort() : []).toEqual([1]);
    // STILL once. A second call here is the guard being gone; with a toggling
    // actuator that second call is what silently clears isolation.
    expect(setIsolatedEntitiesSpy).toHaveBeenCalledTimes(1);
  });

  /**
   * #3338 gap the review found: `useEmbedUrlParams` calls the ASSIGNING
   * `setIsolatedEntities`, never `isolateEntities`, so
   * `check-isolate-expansion-routing.mjs`'s literal-token match could not
   * see this channel at all -- not even the destructure-alias widening
   * caught it, because this is a different action name, not a rename. A
   * `?isolate=` id naming a geometry-less IfcElementAssembly reproduced the
   * #2531/#2532 blank-viewport failure here until this fix routed it through
   * the same `cameraCallbacks.resolveHighlightIds` resolver the embed
   * bridge's ISOLATE command already used.
   */
  it('resolves a geometry-less assembly id to its geometry-bearing parts via resolveHighlightIds', async () => {
    const resolveHighlightIds = (ids: number[]) =>
      ids.flatMap((id) => (id === 1005 ? [11, 12] : [id]));
    useViewerStore.setState({ cameraCallbacks: { resolveHighlightIds } });

    setSearch('?isolate=1005');
    renderEmbedViewer();
    await settle();

    const isolated = useViewerStore.getState().isolatedEntities;
    expect(isolated).not.toBeNull();
    // The resolved parts are unioned with the raw (pre-resolution) id,
    // matching every other isolation channel -- harmless here since the raw
    // assembly id has no geometry of its own to draw.
    expect([...isolated!].sort((a, b) => a - b)).toEqual([11, 12, 1005]);
  });

  it('falls back to the raw ids when no renderer has registered resolveHighlightIds yet', async () => {
    // `beforeEach` sets `cameraCallbacks: {}` -- no resolver at all, mirroring
    // a host page that isolates before the renderer has mounted.
    setSearch('?isolate=1005');
    renderEmbedViewer();
    await settle();

    const isolated = useViewerStore.getState().isolatedEntities;
    expect(isolated).not.toBeNull();
    expect([...isolated!]).toEqual([1005]);
  });

  it('keeps the raw ids when the resolver resolves to [] (#3389)', async () => {
    // `[]` is also what a type-hidden id (spaces ship OFF) and a mesh that has
    // not streamed in yet answer, so skipping the isolate would make
    // `?isolate=<a space>` a silent no-op. The raw ids self-heal: they start
    // matching the renderer's whitelist as soon as the mesh is there.
    useViewerStore.setState({ cameraCallbacks: { resolveHighlightIds: () => [] } });
    setSearch('?isolate=1005');
    renderEmbedViewer();
    await settle();

    const isolated = useViewerStore.getState().isolatedEntities;
    expect(isolated).not.toBeNull();
    expect([...isolated!]).toEqual([1005]);
  });
});

describe('EmbedViewer: ?hideTypes=', () => {
  it('drops the named types from the meshes handed to the viewport', async () => {
    setSearch('?hideTypes=IfcSpace,IfcDoor');
    renderEmbedViewer();
    await settle();

    const drawn = (lastViewportGeometry ?? []).map((m) => m.ifcType);
    expect(drawn).not.toContain('IfcSpace');
    expect(drawn).not.toContain('IfcDoor');
    expect(drawn).toContain('IfcWall');
  });

  it('matches case-insensitively — the SDK documents SCREAMING_CASE by example', async () => {
    // `packages/embed-sdk/test/iframe-url.test.ts` builds the URL with
    // `hideTypes: ['IFCSPACE', 'IFCOPENINGELEMENT']`, while `mesh.ifcType` is
    // PascalCase. A raw string comparison would hide nothing at all for
    // exactly the input the SDK documents, and report no error.
    setSearch('?hideTypes=IFCSPACE,ifcdoor,IfcWall');
    renderEmbedViewer();
    await settle();

    const drawn = (lastViewportGeometry ?? []).map((m) => m.ifcType);
    expect(drawn).toEqual(['IfcOpeningElement']);
  });

  it('draws every type when ?hideTypes= is absent', async () => {
    setSearch('');
    renderEmbedViewer();
    await settle();

    const drawn = (lastViewportGeometry ?? []).map((m) => m.ifcType);
    expect(drawn).toEqual(['IfcWall', 'IfcSpace', 'IfcDoor', 'IfcOpeningElement']);
  });

  /**
   * What the 2D overlay ends up drawing, decided by the same function the
   * viewer's overlay hooks call, over the set this embed published.
   *
   * Asserting the CONSEQUENCE rather than the stored value is the point. The
   * overlay is not a mesh, so the three assertions above cannot see it; and a
   * check that merely read a Set back would survive the folding being dropped
   * or the wrong class being asked about.
   */
  function overlayChannels(): { annotation: boolean; grid: boolean } {
    return symbolicOverlayGate(
      { annotation: true, grid: true },
      useViewerStore.getState().hostHiddenIfcTypes,
    );
  }

  it('publishes the hidden classes to the store, which is what reaches the 2D overlay', async () => {
    // KILLS: dropping the `useHostHiddenIfcTypes` publish (back to a plain
    // `useMemo` for the mesh filter, as shipped). `IfcAnnotation` 2D content is
    // a line overlay, not a mesh, so the mesh filter above cannot touch it.
    // Measured through the real embed build on AC20-FZK-Haus: before this
    // change `hideTypes=IfcAnnotation` moved 0 of 960,000 pixels, where hiding
    // the same class through the store toggle moved 6,492 -- exactly what
    // stripping the 14 IFCANNOTATION instances out of the bytes moves. This
    // store field is the only route there.
    setSearch('?hideTypes=IfcAnnotation');
    renderEmbedViewer();
    await settle();

    expect(overlayChannels()).toEqual({ annotation: false, grid: true });
  });

  it('leaves the overlay alone when ?hideTypes= names none of its classes', async () => {
    setSearch('?hideTypes=IfcSpace');
    renderEmbedViewer();
    await settle();

    expect(overlayChannels()).toEqual({ annotation: true, grid: true });
  });

  it('tracks a later INIT config.hideTypes, not just the mount-time URL value', async () => {
    // KILLS: publishing `urlParams.hideTypes` instead of the runtime-overlay
    // state -- the shape where INIT's `config` has a documented type and no
    // write site. A host that never uses `?hideTypes=` and sends INIT alone
    // would get the overlay back.
    setSearch('');
    renderEmbedViewer();
    await settle();
    expect(overlayChannels()).toEqual({ annotation: true, grid: true });

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            source: EMBED_SOURCE,
            version: PROTOCOL_VERSION,
            type: 'INIT',
            requestId: 'r1',
            data: { config: { hideTypes: ['IFCANNOTATION'] } },
          },
          origin: 'https://parent.example',
          source: window.parent,
        }),
      );
    });
    await settle();

    expect(overlayChannels()).toEqual({ annotation: false, grid: true });
  });
});

describe('EmbedViewer: ?camera=', () => {
  it('places the camera at the requested absolute orientation, then frames it', async () => {
    const calls: string[] = [];
    const setCameraRotation = vi.fn((r: { azimuth: number; elevation: number }) => {
      calls.push(`setCameraRotation:${r.azimuth},${r.elevation}`);
    });
    const fitAll = vi.fn(() => { calls.push('fitAll'); });
    useViewerStore.setState({ cameraCallbacks: { setCameraRotation, fitAll } });

    setSearch('?camera=120,35');
    renderEmbedViewer();
    await settle();
    await nextFrame();

    expect(setCameraRotation).toHaveBeenCalledWith({ azimuth: 120, elevation: 35 });
    // Orientation first, then fit: `fitAll` preserves the view direction,
    // whereas fitting first and rotating after would be tweened away.
    expect(calls).toEqual(['setCameraRotation:120,35', 'fitAll']);
  });

  it('falls back to home framing when ?camera= is absent', async () => {
    const home = vi.fn();
    const setCameraRotation = vi.fn();
    useViewerStore.setState({ cameraCallbacks: { home, setCameraRotation } });

    setSearch('');
    renderEmbedViewer();
    await settle();
    await nextFrame();

    expect(home).toHaveBeenCalled();
    expect(setCameraRotation).not.toHaveBeenCalled();
  });
});

describe('EmbedViewer: ?controls=', () => {
  it('applies the parsed mode to the registered camera callback', async () => {
    const setInteractionMode = vi.fn();
    useViewerStore.setState({ cameraCallbacks: { setInteractionMode } });

    setSearch('?controls=pan');
    renderEmbedViewer();
    await settle();

    expect(setInteractionMode).toHaveBeenCalledWith('pan');
  });

  it('replays once the camera callback registers late, same as ?camera=', async () => {
    // Renderer callbacks are not yet registered at mount (Viewport's effect
    // runs after `renderer.init()` resolves). Before #2934, urlParams.controls
    // was read nowhere at all, so there was nothing to replay; this pins that
    // the store-level pending/replay path used for SET_CAMERA (#2978) is now
    // shared by the URL param too.
    setSearch('?controls=none');
    renderEmbedViewer();
    await settle();

    const setInteractionMode = vi.fn();
    act(() => {
      useViewerStore.getState().setCameraCallbacks({ setInteractionMode });
    });

    expect(setInteractionMode).toHaveBeenCalledWith('none');
  });

  it('does not call the callback when ?controls= is absent', async () => {
    const setInteractionMode = vi.fn();
    useViewerStore.setState({ cameraCallbacks: { setInteractionMode } });

    setSearch('');
    renderEmbedViewer();
    await settle();

    expect(setInteractionMode).not.toHaveBeenCalled();
  });
});
