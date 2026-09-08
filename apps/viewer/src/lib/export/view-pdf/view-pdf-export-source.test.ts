/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the to-scale 3D-view PDF export reads off the live viewer (#2042).
 *
 * DEFECT CLASS — a sheet that is internally consistent but is not the view.
 * The section slider is a PERCENTAGE, so it is meaningless without the range
 * it is a percentage OF. `ViewportContainer` hands the renderer the UNION of
 * every visible model's `shiftedBounds`, so on screen 50% resolves against
 * that union. Reading only the first visible model's bounds here puts the same
 * 50% somewhere else entirely on a federated view, and nothing about the
 * resulting PDF looks wrong: the page size is plausible, the geometry is real,
 * the cut is simply in the wrong place.
 *
 * The fixture makes that failure unmissable: a small model (x 0..10) is loaded
 * FIRST and a large one (x 0..100) second, so first-model-only bounds and
 * unioned bounds differ by a factor of ten.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store/index.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { setGlobalCanvasRef, setGlobalRendererRef, clearGlobalRefs } from '@/hooks/useBCF.js';
import { readViewPdfSource } from './view-pdf-export-source.js';

const SMALL_MAX = { x: 10, y: 4, z: 4 };
const LARGE_MAX = { x: 100, y: 40, z: 40 };

function boxMesh(max: { x: number; y: number; z: number }, expressId: number): MeshData {
  const positions: number[] = [];
  for (const x of [0, max.x]) {
    for (const y of [0, max.y]) {
      for (const z of [0, max.z]) positions.push(x, y, z);
    }
  }
  return {
    expressId,
    ifcType: 'IfcWall',
    modelIndex: 0,
    positions: new Float32Array(positions),
    normals: new Float32Array(positions.length),
    indices: new Uint32Array([0, 1, 2, 5, 6, 7]),
    color: [1, 1, 1, 1],
  };
}

function geometry(max: { x: number; y: number; z: number }, expressId: number): GeometryResult {
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { ...max } };
  return {
    meshes: [boxMesh(max, expressId)],
    totalTriangles: 2,
    totalVertices: 8,
    coordinateInfo: {
      originShift: { x: 0, y: 0, z: 0 },
      originalBounds: bounds,
      shiftedBounds: bounds,
      hasLargeCoordinates: false,
    },
  };
}

/** Scene bounds are the union, exactly as the renderer reports them on screen. */
function fakeRenderer(): Renderer {
  const camera = {
    getPosition: () => ({ x: 50, y: 20, z: 200 }),
    getTarget: () => ({ x: 50, y: 20, z: 0 }),
    getUp: () => ({ x: 0, y: 1, z: 0 }),
    getProjectionMode: () => 'orthographic' as const,
    getOrthoSize: () => 60,
    getDistance: () => 200,
    getFOV: () => Math.PI / 4,
    getSceneBounds: () => ({ min: { x: 0, y: 0, z: 0 }, max: { ...LARGE_MAX } }),
  };
  return {
    getCamera: () => camera,
    getScene: () => ({ getAllInstancedMeshData: () => [] }),
  } as unknown as Renderer;
}

/** Small model first, large model second, both visible, with a cut on X. */
function seedFederated(largeVisible = true): void {
  const small = { ...fixtureModel('small', { idOffset: 0 }), geometryResult: geometry(SMALL_MAX, 1) };
  const large = {
    ...fixtureModel('large', { idOffset: 1_000_000 }),
    geometryResult: geometry(LARGE_MAX, 2),
    visible: largeVisible,
  };
  useViewerStore.setState({
    ...fixtureModels(small, large),
    hiddenEntities: new Set<number>(),
    isolatedEntities: null,
    classFilter: null,
    selectedStoreys: new Set<number>(),
    projectionMode: 'orthographic',
    sectionPlane: {
      ...useViewerStore.getState().sectionPlane,
      enabled: true,
      axis: 'side',
      position: 50,
      flipped: false,
    },
  });

  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'clientHeight', { value: 500, configurable: true });
  setGlobalCanvasRef({ current: canvas });
  setGlobalRendererRef({ current: fakeRenderer() });
}

describe('readViewPdfSource (#2042)', () => {
  beforeEach(() => {
    seedFederated();
  });

  afterEach(() => {
    clearGlobalRefs();
  });

  it('resolves the section percentage against the UNION of visible model bounds', () => {
    const source = readViewPdfSource(useViewerStore.getState());
    assert.ok(source.section, 'an enabled cut must resolve');
    const range = source.section.uiRange;
    assert.ok(range, 'the cut needs the range its percentage is a percentage of');

    // The union spans x 0..100. Taking only the first visible model would give
    // 0..10, and the 50% cut would land at x=5 instead of x=50 - a tenfold
    // error that the sheet gives no sign of.
    assert.equal(range.min, 0);
    assert.equal(range.max, LARGE_MAX.x, 'the range must span every visible model, not just the first');
  });

  it('drops a hidden model from the union, matching what the viewport shows', () => {
    // Not a restatement of the test above: it pins that the union follows
    // VISIBILITY. A union built over all loaded models would keep the large
    // model's range here and put the cut where nothing is drawn.
    seedFederated(false);
    const source = readViewPdfSource(useViewerStore.getState());
    assert.ok(source.section?.uiRange);
    assert.equal(
      source.section.uiRange.max,
      SMALL_MAX.x,
      'a hidden model must not stretch the range the cut resolves against',
    );
  });

  it('gathers the visible models geometry and leaves the instanced list empty by construction', () => {
    const source = readViewPdfSource(useViewerStore.getState());
    assert.equal(source.view.meshes.length, 2, 'both visible models must contribute geometry');
    // `withInstancedMeshes` already folded instanced occurrences into the mesh
    // list, so handing them over again here would draw each one twice.
    assert.deepEqual(source.view.instancedMeshes, []);
  });
});
