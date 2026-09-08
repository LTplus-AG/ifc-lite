/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The embed passes mesh alpha through, like the full viewer.
 *
 * `useModelViewGeometry` used to re-multiply `IfcSpace` and `IfcOpeningElement`
 * down to `min(alpha * 0.3, 0.3)` after the visibility filter.
 * `ViewportContainer` dropped exactly that under #677, because it stomped lens
 * and property-set colour rules even when the caller had explicitly chosen
 * alpha 1.0. The embed kept it, so the same store rendered two ways.
 *
 * Assertions are on the alpha in the mesh list handed to `Viewport`, which is
 * what this memo decides. It is not a claim about drawn pixels: a colour that
 * arrives after load reaches the GPU by another route entirely
 * (`pendingMeshColorUpdates` into `scene.updateMeshColors`), and never passed
 * through the clamp even before this change.
 */

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { MeshData } from '@ifc-lite/geometry';

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

function mesh(expressId: number, ifcType: string, alpha: number): MeshData {
  return {
    expressId,
    ifcType,
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    indices: new Uint32Array(0),
    color: [1, 0, 0, alpha],
  };
}

/**
 * The alphas `rust/processing/src/style/mod.rs` assigns these two classes, plus
 * an explicit 1.0 standing in for a host `setColors` override, plus a wall as
 * the control that was never clamped.
 */
const MESHES = [
  mesh(1, 'IfcSpace', 0.3),
  mesh(2, 'IfcOpeningElement', 0.4),
  mesh(3, 'IfcSpace', 1),
  mesh(4, 'IfcWall', 1),
];

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

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

/** Alpha per express id, as handed to `Viewport`. */
async function alphas(): Promise<Record<number, number>> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(EmbedViewer));
  });
  mounted.push({ root, container });
  return Object.fromEntries((lastViewportGeometry ?? []).map((m) => [m.expressId, m.color[3]]));
}

beforeEach(() => {
  lastViewportGeometry = null;
  window.history.replaceState({}, '', '/');
  // Spaces and openings are OFF by default, so without this the meshes under
  // test are filtered out before the alpha pass and every assertion is vacuous.
  useViewerStore.setState({
    selectedEntityIds: new Set<number>(),
    selectedEntityId: null,
    isolatedEntities: null,
    cameraCallbacks: {},
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

describe('EmbedViewer: mesh alpha reaches Viewport unchanged', () => {
  it('leaves the styling alphas alone for IfcSpace and IfcOpeningElement', async () => {
    // KILLS: restoring the `.map` that re-multiplied by 0.3. With it, the
    // styling defaults arrive as 0.09 and 0.12, a third of what styling.rs
    // assigns, and the embed draws them three times fainter than the viewer.
    const a = await alphas();

    expect(a[1]).toBe(0.3);
    expect(a[2]).toBe(0.4);
  });

  it('leaves an explicit opaque colour opaque', async () => {
    // KILLS: the same `.map`, and specifically its `Math.min(..., 0.3)` ceiling,
    // which is what made a host's explicit alpha 1.0 unrecoverable rather than
    // merely dimmed. This is the case #677 was filed for.
    const a = await alphas();

    expect(a[3]).toBe(1);
  });

  it('never touched classes outside the two, which is why the wall is here', async () => {
    // KILLS: widening the clamp to every mesh. Without this the two assertions
    // above would still pass under a filter that dimmed everything, since they
    // only look at the two classes the old code named.
    const a = await alphas();

    expect(a[4]).toBe(1);
  });
});
