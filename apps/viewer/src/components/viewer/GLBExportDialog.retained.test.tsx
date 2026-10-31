/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7955: GLB export of a retained-kernel model. The dialog's from-bytes fast path re-meshes the FILE with the
 * exact engine, which for a retained model is not the geometry on screen (it carries every product the retained
 * kernel refused). The retained model must export the meshes the viewer holds; the same model without the
 * retained summary keeps the fast path, so the gate is what the assertions observe.
 */
import '@/test/setup-dom.js';
import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { GeometryProcessor, type MeshData, type GeometryResult } from '@ifc-lite/geometry';
import { render, cleanup, click, advance } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import type { RetainedGeometrySummary } from '@/store/retainedGeometry';
import { GLBExportDialog } from './GLBExportDialog';

afterEach(() => { cleanup(); mock.restoreAll(); setGlobalRendererRef({ current: null }); });

const RETAINED: RetainedGeometrySummary = {
  kernel: 'retained', candidates: 2, started: true, published: 1,
  refused: [{ expressId: 2, ifcType: 'IfcBuildingElementProxy', code: 'appearance_unsupported' }],
  cancelled: 0, obligationsUnmet: [], completeness: 'incomplete',
};

async function exportWith(retainedGeometry: RetainedGeometrySummary | undefined) {
  const zero = { x: 0, y: 0, z: 0 };
  const mesh: MeshData = { expressId: 1, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1] };
  const geometry: GeometryResult = { meshes: [mesh], totalTriangles: 1, totalVertices: 3,
    coordinateInfo: { originalBounds: { min: zero, max: zero }, shiftedBounds: { min: zero, max: zero }, originShift: zero, hasLargeCoordinates: false } };
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('m', { idOffset: 0 }),
    sourceFile: new File(['IFC source the exact engine would re-mesh'], 'source.ifc'), geometryResult: geometry,
    ...(retainedGeometry ? { retainedGeometry } : {}) }), mergeLayers: false });
  let held: MeshData[] | undefined;
  mock.method(GeometryProcessor.prototype, 'init', async () => undefined);
  mock.method(GeometryProcessor.prototype, 'dispose', () => undefined);
  const fromBytes = mock.method(GeometryProcessor.prototype, 'exportGlb', () => new Uint8Array([1]));
  mock.method(GeometryProcessor.prototype, 'exportGlbFromMeshes', (meshes: MeshData[]) => { held = meshes; return new Uint8Array([1]); });
  render(<GLBExportDialog surface="ribbon" />);
  const button = (label: string) => { const el = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === label); assert.ok(el); return el; };
  click(button('Export GLB')); await advance(1);
  click(button('Export')); await advance(20);
  return { fromBytes: fromBytes.mock.callCount(), held, mesh };
}

it('a retained-kernel model exports the meshes the viewer holds, never the exact engine\'s re-mesh of its file', async () => {
  const { fromBytes, held, mesh } = await exportWith(RETAINED);
  assert.equal(fromBytes, 0, 'the exact from-bytes assembler must not run for a retained model');
  assert.deepEqual(held, [mesh], 'the held (retained) mesh is what is exported');
});

it('control: the same model without a retained summary still takes the from-bytes fast path', async () => {
  const { fromBytes, held } = await exportWith(undefined);
  assert.equal(fromBytes, 1, 'the default exact path is unchanged');
  assert.equal(held, undefined);
});
