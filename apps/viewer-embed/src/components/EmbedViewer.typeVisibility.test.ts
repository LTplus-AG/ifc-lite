/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The embed's mesh filter honours EVERY type-visibility toggle, through the
 * store's `typeVisibilityFilter` rather than a private copy of the mapping.
 *
 * `EmbedViewer` used to inline three comparisons — `IfcSpace`/`spaces`,
 * `IfcOpeningElement`/`openings`, `IfcSite`/`site` — while
 * `apps/viewer/src/store/typeVisibilityFilter.ts`, whose header calls itself
 * the single source of truth, mapped six classes. So `IfcSpatialZone`,
 * `IfcVirtualElement`, `IfcGeographicElement` and 3D `IfcAnnotation` solids
 * rendered in the embed no matter what the toggle said, and the full viewer
 * and the embed disagreed about the same model.
 *
 * These assert on the mesh list actually handed to `Viewport` — the thing the
 * user sees — not on which helper was called. The harness (Viewport prop
 * capture, `useWebGPU` and `useIfc` mocks) is the one
 * `EmbedViewer.urlParams.test.ts` documents; the `useWebGPU` mock is
 * load-bearing there for the same reason it is here: happy-dom has no
 * `navigator.gpu`, so without it `Viewport` never renders and every assertion
 * below would pass vacuously against `null`.
 */

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { MeshData } from '@ifc-lite/geometry';
import type { TypeVisibility } from '@/store/types.js';

/** Captured props of the last `Viewport` render — what the embed actually draws. */
let lastViewportGeometry: MeshData[] | null = null;
vi.mock('@/components/viewer/Viewport', () => ({
  Viewport: (props: { geometry: MeshData[] | null }) => {
    lastViewportGeometry = props.geometry;
    return null;
  },
}));
vi.mock('@/components/viewer/ViewportOverlays', () => ({ ViewportOverlays: () => null }));

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

/**
 * One mesh per class the store maps, plus `IfcGeographicElement` (which rides
 * `site`, not a toggle of its own) and one unmapped class that must survive
 * every toggle.
 */
const TYPES = [
  'IfcWall',
  'IfcSpace',
  'IfcSpatialZone',
  'IfcOpeningElement',
  'IfcVirtualElement',
  'IfcSite',
  'IfcGeographicElement',
  'IfcAnnotation',
];

const MESHES = TYPES.map((ifcType, i) => mesh(i + 1, ifcType));

const geometryResult = { meshes: MESHES, totalVertices: 0, totalTriangles: 0 };

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

const ALL_VISIBLE: TypeVisibility = {
  spaces: true,
  spatialZones: true,
  openings: true,
  virtualElements: true,
  site: true,
  ifcAnnotations: true,
  ifcGrid: true,
};

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

async function drawnWith(typeVisibility: TypeVisibility): Promise<Array<string | undefined>> {
  useViewerStore.setState({ typeVisibility });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(EmbedViewer));
  });
  await act(async () => {
    await Promise.resolve();
  });
  mounted.push({ root, container });
  return (lastViewportGeometry ?? []).map((m) => m.ifcType);
}

beforeEach(() => {
  lastViewportGeometry = null;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ArrayBuffer(8), { status: 200 })));
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
  useViewerStore.setState({ typeVisibility: { ...ALL_VISIBLE } });
});

describe('EmbedViewer: typeVisibility', () => {
  it('draws every class when all toggles are on', async () => {
    // The baseline the per-toggle cases below are read against. Without it a
    // "class X is gone" assertion could pass because X was never drawn at all.
    expect(await drawnWith({ ...ALL_VISIBLE })).toEqual(TYPES);
  });

  // Kills: the three-comparison private copy that shipped. Under it the
  // spatialZones, virtualElements and ifcAnnotations rows below all failed —
  // the class stayed on screen with its toggle off — and `IfcGeographicElement`
  // survived `site: false`. It also kills a re-copied mapping that drifts from
  // `typeVisibilityFilter.ts` in either direction.
  const CASES: Array<[keyof TypeVisibility, string[]]> = [
    ['spaces', ['IfcSpace']],
    ['spatialZones', ['IfcSpatialZone']],
    ['openings', ['IfcOpeningElement']],
    ['virtualElements', ['IfcVirtualElement']],
    // #1480: the row is labelled "Terrain & context", so modelled terrain goes
    // with the site. Two classes, one toggle.
    ['site', ['IfcSite', 'IfcGeographicElement']],
    // #1354/#1480: `IfcAnnotation` can carry real 3D solids on top of the 2D
    // symbolic overlay, and this toggle hides both.
    ['ifcAnnotations', ['IfcAnnotation']],
  ];

  for (const [key, hidden] of CASES) {
    it(`hides exactly ${hidden.join(' + ')} when ${key} is off`, async () => {
      const drawn = await drawnWith({ ...ALL_VISIBLE, [key]: false });
      expect(drawn).toEqual(TYPES.filter((t) => !hidden.includes(t)));
    });
  }

  it('leaves the mesh list alone when ifcGrid is off', async () => {
    // `ifcGrid` is the one flag with no class mapping: it gates a renderer
    // overlay, not meshes. Kills: mapping it onto `IfcAnnotation` (the pairing
    // #862 deliberately split) or onto any mesh class at all.
    expect(await drawnWith({ ...ALL_VISIBLE, ifcGrid: false })).toEqual(TYPES);
  });
});
