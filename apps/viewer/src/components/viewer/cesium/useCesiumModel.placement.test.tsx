/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { GeometryResult } from '@ifc-lite/geometry';
import { cleanup, render, advance } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { emptyPlacementState } from '@/lib/model-placement/state';
import type { CesiumBridge } from '@/lib/geo/cesium-bridge';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { loadCesium } from './cesium-module';
import { useCesiumModel } from './useCesiumModel';

afterEach(() => { cleanup(); mock.restoreAll(); setGlobalRendererRef({ current: null }); });
it('rebuilds the World Context GLB for preview and cancel without a geometry or visibility edit (#4226)', async () => {
  const Cesium = await loadCesium();
  const blobs: Blob[] = [];
  mock.method(URL, 'createObjectURL', (blob: Blob) => { blobs.push(blob); return 'blob:placement-test'; });
  mock.method(URL, 'revokeObjectURL', () => undefined);
  // GPU/network boundary only: use real Cesium matrices and primitive ownership,
  // plus the real mounted hook, placement adapter and binary GLB builder.
  mock.method(Cesium.Model, 'fromGltfAsync', async (options: { modelMatrix: unknown }) => ({
    modelMatrix: options.modelMatrix, destroy() {},
  }) as unknown as InstanceType<typeof Cesium.Model>);
  const primitives = new Cesium.PrimitiveCollection();
  const viewerRef = { current: { scene: { primitives, requestRender() {} } } as unknown as InstanceType<typeof Cesium.Viewer> };
  const bridgeRef = { current: { modelOrigin: { longitude: 0, latitude: 0, height: 0 },
    viewerRotation: { eastFromVx: 1, eastFromVz: 0, northFromVx: 0, northFromVz: -1 },
  } as unknown as CesiumBridge };
  const zero = { x: 0, y: 0, z: 0 };
  const geometry: GeometryResult = { meshes: [{ expressId: 1, origin: [10, 20, 30],
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array(9),
    indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1] }], totalTriangles: 1, totalVertices: 3,
    coordinateInfo: { originalBounds: { min: zero, max: zero }, shiftedBounds: { min: zero, max: zero }, originShift: zero, hasLargeCoordinates: false } };
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('m', { idOffset: 0 }), geometryResult: geometry }),
    modelPlacement: emptyPlacementState(), hiddenEntities: new Set(), isolatedEntities: null, ghostExceptEntities: null });
  function World() {
    const { modelEpoch } = useCesiumModel({ status: 'ready', bridgeVersion: 0, viewerRef, bridgeRef,
      geometryResult: geometry, coordinateInfo: geometry.coordinateInfo });
    return <output>{modelEpoch}</output>;
  }
  async function minimum(): Promise<number[]> {
    const bytes = new Uint8Array(await blobs.at(-1)!.arrayBuffer());
    const length = new DataView(bytes.buffer).getUint32(12, true);
    return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length))).accessors[0].min;
  }
  const ui = render(<World />); await advance(1250);
  assert.equal(ui.textContent, '1'); assert.deepEqual(await minimum(), [10, 20, 30]);
  act(() => { const s = useViewerStore.getState(); s.openReposition(['m']); s.previewModelTranslation([2, 3, 4]); });
  await advance(1250);
  assert.equal(ui.textContent, '2'); assert.deepEqual(await minimum(), [12, 24, 27]);
  act(() => useViewerStore.getState().closeReposition()); await advance(1250);
  assert.equal(ui.textContent, '3'); assert.deepEqual(await minimum(), [10, 20, 30]);
  act(() => useViewerStore.getState().setModelPositionLocked('m', true)); await advance(1250);
  assert.equal(ui.textContent, '3', 'a lock changes no displayed coordinates and must not rebuild the GLB');
  assert.equal(primitives.length, 1, 'each replacement releases its predecessor');
});
