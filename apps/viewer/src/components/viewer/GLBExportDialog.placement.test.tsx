/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { GeometryProcessor, type MeshData, type GeometryResult } from '@ifc-lite/geometry';
import { render, cleanup, click, advance } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { emptyPlacementState, importPlacements } from '@/lib/model-placement/state';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { GLBExportDialog } from './GLBExportDialog';

afterEach(() => { cleanup(); mock.restoreAll(); setGlobalRendererRef({ current: null }); });
it('exports the placed triangle instead of remeshing unplaced IFC bytes with default options (#4226)', async () => {
  const zero = { x: 0, y: 0, z: 0 };
  const mesh: MeshData = { expressId: 1, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1], origin: [10, 20, 30] };
  const geometry: GeometryResult = { meshes: [mesh], totalTriangles: 1, totalVertices: 3,
    coordinateInfo: { originalBounds: { min: zero, max: zero }, shiftedBounds: { min: zero, max: zero }, originShift: zero, hasLargeCoordinates: false } };
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('m', { idOffset: 0 }),
    sourceFile: new File(['IFC source is intentionally never remeshed'], 'source.ifc'), geometryResult: geometry }),
    mergeLayers: false, modelPlacement: importPlacements(emptyPlacementState(), new Map([['m', { translation: [2, 3, 4], locked: false }]])) });
  let exported: MeshData[] | undefined;
  mock.method(GeometryProcessor.prototype, 'init', async () => undefined);
  mock.method(GeometryProcessor.prototype, 'dispose', () => undefined);
  const fromBytes = mock.method(GeometryProcessor.prototype, 'exportGlb', () => new Uint8Array([1]));
  mock.method(GeometryProcessor.prototype, 'exportGlbFromMeshes', (meshes: MeshData[]) => { exported = meshes; return new Uint8Array([1]); });
  render(<GLBExportDialog />);
  const button = (label: string) => { const el = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === label); assert.ok(el); return el; };
  click(button('Export GLB')); await advance(1);
  click(button('Export')); await advance(20);
  assert.equal(fromBytes.mock.callCount(), 0, 'the default source-byte fast path cannot express a manual workspace placement');
  assert.ok(exported);
  assert.deepEqual(exported[0].origin, [12, 24, 27], 'engineering Z-up delta is included in the Y-up GLB node origin');
  assert.deepEqual(mesh.origin, [10, 20, 30], 'the authored source remains unchanged');
});
