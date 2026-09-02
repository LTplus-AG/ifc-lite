/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The embed draws the Model view, not the type library on top of it
 * (#957, #1353).
 *
 * `EmbedViewer`'s mesh filter used to gate on `hideTypes` and the semantic
 * `typeVisibility` toggles ONLY — no `geometryClass` gate at all — so every
 * instanced type copy (class 2) was drawn at its `MappingOrigin` over the
 * occurrence that places it. On `tests/models/ara3d/AC20-FZK-Haus.ifc` that is
 * an upside-down roof plane and a floating slab, and a pick there returns
 * `IfcSlabType`/`IfcWallType`, which are not building elements. The full
 * viewer never had this: its 3D view applies the same predicate directly as
 * `isMeshVisibleInViewMode` (`ViewportContainer.tsx:831-856`), and
 * `selectModelMeshes` is the one-pass wrapper the 2D drawings use (#2058).
 *
 * These assert on the mesh list actually handed to `Viewport` — what the embed
 * draws — rather than on the call. A test that only checked
 * "`selectModelMeshes` was called" would survive throwing its result away.
 *
 * Harness is `EmbedViewer.urlParams.test.ts`'s, deliberately: the `Viewport`
 * prop capture, and the `useWebGPU` mock without which happy-dom never renders
 * the `Viewport` subtree at all and every assertion here is vacuous.
 */

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { MeshData } from '@ifc-lite/geometry';

/** Captured props of the last `Viewport` render — what the embed actually draws. */
let lastViewportGeometry: MeshData[] | null = null;
let lastContentVersion: number | undefined;
vi.mock('@/components/viewer/Viewport', () => ({
  Viewport: (props: { geometry: MeshData[] | null; geometryContentVersion?: number }) => {
    lastViewportGeometry = props.geometry;
    lastContentVersion = props.geometryContentVersion;
    return null;
  },
}));
vi.mock('@/components/viewer/ViewportOverlays', () => ({ ViewportOverlays: () => null }));

vi.mock('@/hooks/useWebGPU', () => ({
  useWebGPU: () => ({ supported: true, checking: false, reason: null }),
}));

/**
 * `geometryClass` ordinals are named in `@ifc-lite/geometry/geometry-class` and
 * spelled out here as literals on purpose, matching `type-view-visibility.test.ts`.
 * Importing the constants would make the expectations move with whatever the
 * constants say, so a change to them could not fail this file. These literals do
 * NOT verify anything against Rust; only an assertion at the real boundary can,
 * as `geometry-class.ts` says itself.
 */
const OCCURRENCE = 0;
const ORPHAN_TYPE = 1;
const INSTANCED_TYPE = 2;
const LAYER_SLICE = 3;

function mesh(expressId: number, ifcType: string, geometryClass?: number): MeshData {
  return {
    expressId,
    ifcType,
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    indices: new Uint32Array(0),
    color: [1, 1, 1, 1],
    ...(geometryClass === undefined ? {} : { geometryClass }),
  };
}

/** Drives what `useIfc()` reports, so each test can supply its own mesh list. */
let meshes: MeshData[] = [];

vi.mock('@/hooks/useIfc', () => ({
  useIfc: () => ({
    geometryResult: { meshes, totalVertices: 0, totalTriangles: 0 },
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

/** Renders with `meshes` as the loaded model and returns the drawn express ids. */
async function drawnIds(list: MeshData[]): Promise<number[]> {
  meshes = list;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(EmbedViewer));
  });
  mounted.push({ root, container });
  return (lastViewportGeometry ?? []).map((m) => m.expressId);
}

/**
 * Renders `list`, then re-renders `next` into the SAME root, and returns the
 * `geometryContentVersion` seen before and after. Distinct from `drawnIds`,
 * which mounts a fresh root per call: two mounts each report a static value and
 * cannot show that one mounted viewport observes the transition.
 */
async function versionsAcrossRerender(list: MeshData[], next: MeshData[]): Promise<[number | undefined, number | undefined]> {
  meshes = list;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(EmbedViewer));
  });
  mounted.push({ root, container });
  const before = lastContentVersion;
  meshes = next;
  // No `key` on either render, deliberately. Giving only the second one a key
  // changes the element identity from null, so React may unmount and remount,
  // and the test would be back to two instances reporting two static values.
  await act(async () => {
    root.render(React.createElement(EmbedViewer));
  });
  return [before, lastContentVersion];
}

beforeEach(() => {
  lastViewportGeometry = null;
  lastContentVersion = undefined;
  meshes = [];
  window.history.replaceState({}, '', '/');
  useViewerStore.setState({
    selectedEntityIds: new Set<number>(),
    selectedEntityId: null,
    isolatedEntities: null,
    cameraCallbacks: {},
    // The three toggles these fixtures can trip, forced ON, so the only thing
    // removing a mesh here is the geometry-class gate under test. NOT every
    // toggle: `spatialZones` and `virtualElements` default to false, so a case
    // added with an `IfcSpatialZone` or `IfcVirtualElement` mesh would see it
    // dropped by type visibility and read as a geometry-class bug.
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
});

describe('EmbedViewer: Model-view geometry-class gate', () => {
  it('draws placed geometry and drops the type library', async () => {
    // KILLS: the shipped code — no `geometryClass` gate in the embed's filter
    // at all, so classes 1 and 2 were drawn alongside the building. Deleting
    // the `selectModelMeshes` call reinstates exactly that and fails here.
    // Class 3 is in the list because it is PLACED despite not being class 0:
    // narrowing the gate to `geometryClass === 0` would drop every layered
    // wall and slab, and only this assertion notices.
    // Mesh 5 is untagged, which is what meshes built on the TS side and models
    // processed before the tag existed look like. It must read as an occurrence:
    // mutating that default to orphan hides it here, because the list already
    // has placed geometry. Verified by applying that mutation, which fails this
    // case alone.
    const ids = await drawnIds([
      mesh(1, 'IfcWall', OCCURRENCE),
      mesh(2, 'IfcSlab', LAYER_SLICE),
      mesh(3, 'IfcWallType', ORPHAN_TYPE),
      mesh(4, 'IfcSlabType', INSTANCED_TYPE),
      mesh(5, 'IfcDoor'),
    ]);

    expect(ids).toEqual([1, 2, 5]);
  });

  it('still renders a pure type-library file, which has nothing else to show', async () => {
    // KILLS: replacing `selectModelMeshes` with a bare
    // `isPlacedGeometryClass` / `geometryClass === 0 || === 3` filter. That
    // mutation passes the two tests above and blanks the screen for a
    // buildingSMART annex-E type-library file, which is class 1 throughout
    // with zero placed geometry. It is the #1353 mutation that survived once
    // already in the full viewer.
    const ids = await drawnIds([
      mesh(11, 'IfcWallType', ORPHAN_TYPE),
      mesh(12, 'IfcDoorType', ORPHAN_TYPE),
    ]);

    expect(ids).toEqual([11, 12]);
  });

  it('drops an orphan type once the model has placed geometry', async () => {
    // KILLS: the pre-#1353 rule "orphan types always show", i.e. keeping
    // class 1 unconditionally to make the annex-E test above pass. A real
    // model authored with unplaced `IfcXxxType` definitions would then draw
    // them over the building, which is the defect in a second costume.
    const ids = await drawnIds([
      mesh(21, 'IfcWall', OCCURRENCE),
      mesh(22, 'IfcWallType', ORPHAN_TYPE),
    ]);

    expect(ids).toEqual([21]);
  });

  it('drops an instanced type copy even when it is the only geometry', async () => {
    // KILLS: folding classes 1 and 2 together under the "nothing is placed, so
    // show it" fallback. Class 2 is by definition a duplicate of an occurrence
    // the file places, so a list of nothing but class 2 is a filtered subset,
    // never a type-library file — it must not resurrect.
    const ids = await drawnIds([mesh(31, 'IfcSlabType', INSTANCED_TYPE)]);

    expect(ids).toEqual([]);
  });

  it('applies the gate before ?hideTypes=, so hiding every placed class does not surface the type library', async () => {
    // KILLS: moving `selectModelMeshes` after the `hideTypes` filter. Every
    // other case here passes with the two swapped, because they never hide a
    // placed mesh. Here the host hides the only occurrence, so a gate run on
    // the already-filtered list sees "nothing is placed", takes the #1353
    // annex-E branch, and keeps the orphan type. The host asking to hide walls
    // would get a floating `IfcWallType` instead of an empty scene.
    window.history.replaceState({}, '', '/?hideTypes=IfcWall');

    const ids = await drawnIds([
      mesh(50, 'IfcWall', OCCURRENCE),
      mesh(51, 'IfcWallType', ORPHAN_TYPE),
    ]);

    expect(ids).toEqual([]);
  });

  it('flips geometryContentVersion within one mounted viewport when the first placed mesh arrives', async () => {
    // KILLS: dropping the `geometryContentVersion` prop, and also a version that is
    // computed once per mount and never moves. `selectModelMeshes` changes which
    // meshes it keeps at the moment the first placed mesh shows up: before, a list
    // of orphans is kept whole; after, every one is dropped. The upload path
    // classifies by array LENGTH and appends `slice(oldLength)`
    // (useGeometryStreaming.ts:321,516), so a composition change under a growing
    // length leaves the dropped orphans on screen and never uploads the placed
    // meshes that took their index range.
    //
    // Re-renders the SAME root rather than mounting twice, so a single component
    // instance observes 0 then 1, which is what the streaming hook downstream
    // needs in order to reset its length tracking.
    //
    // What this canNOT pin, stated rather than implied: that the real `Viewport`
    // acts on the value. Every embed test mocks `Viewport` and nothing in the repo
    // mounts it, because it needs a WebGPU device. That link is covered by the
    // acceptance run, not by this file.
    const [orphansOnly, afterPlaced] = await versionsAcrossRerender(
      [mesh(60, 'IfcWallType', ORPHAN_TYPE)],
      [mesh(60, 'IfcWallType', ORPHAN_TYPE), mesh(61, 'IfcWall', OCCURRENCE)],
    );

    expect(orphansOnly).toBe(0);
    expect(afterPlaced).toBe(1);
  });
});
