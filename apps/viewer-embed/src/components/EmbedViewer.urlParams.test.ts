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

vi.mock('@/hooks/useIfc', () => ({
  useIfc: () => ({
    geometryResult,
    ifcDataStore: null,
    loadFile: vi.fn(async () => {}),
    loading: false,
    models: new Map(),
    clearAllModels: vi.fn(),
    addModel: vi.fn(async () => 'stub-model-id'),
  }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { EmbedViewer } = await import('./EmbedViewer.js');
const { useViewerStore } = await import('@/store');

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

  it('stays isolated across a re-render — the actuator is a same-set TOGGLE', async () => {
    // `visibilitySlice.isolateEntities` CLEARS isolation when called twice with
    // the same ids. An effect that re-ran (or a hook using `isolateEntities`
    // rather than `setIsolatedEntities`) would silently undo itself, which
    // reads as "the parameter still does nothing".
    setSearch('?isolate=1');
    renderEmbedViewer();
    await settle();
    await settle();

    const isolated = useViewerStore.getState().isolatedEntities;
    expect([...isolated!]).toEqual([1]);
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
