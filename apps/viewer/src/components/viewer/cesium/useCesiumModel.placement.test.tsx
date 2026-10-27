/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import type { GeometryResult } from '@ifc-lite/geometry';
import { cleanup, render, advance } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { emptyPlacementState } from '@/lib/model-placement/state';
import type { CesiumBridge } from '@/lib/geo/cesium-bridge';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { loadCesium } from './cesium-module';
import { buildCesiumModelMatrix, useCesiumModel } from './useCesiumModel';
import { CesiumViewerLifetime } from './cesium-viewer-lifetime';

afterEach(() => { cleanup(); mock.restoreAll(); setGlobalRendererRef({ current: null }); });

it('uses the bridge FactorZ scale for the Cesium model as well as its camera (#4615)', async () => {
  const Cesium = await loadCesium();
  const bridge = {
    modelOrigin: { longitude: 0, latitude: 0, height: 0 },
    viewerRotation: { eastFromVx: 1, eastFromVz: 0, northFromVx: 0, northFromVz: -1 },
    viewerUpScale: 2,
    placement: { requested: 'anchor', mode: 'anchor', estimate: null, key: '' }, geoMapping: null,
  } as unknown as CesiumBridge;
  const coordinateInfo: GeometryResult['coordinateInfo'] = {
    originalBounds: { min: { x: 0, y: 8, z: 0 }, max: { x: 0, y: 12, z: 0 } },
    shiftedBounds: { min: { x: 0, y: 8, z: 0 }, max: { x: 0, y: 12, z: 0 } },
    originShift: { x: 0, y: 0, z: 0 },
    hasLargeCoordinates: false,
  };
  const matrix = buildCesiumModelMatrix(Cesium, bridge, coordinateInfo);
  const center = Cesium.Matrix4.multiplyByPoint(matrix, new Cesium.Cartesian3(0, 10, 0), new Cesium.Cartesian3());
  const oneViewerMetreUp = Cesium.Matrix4.multiplyByPoint(
    matrix,
    new Cesium.Cartesian3(0, 11, 0),
    new Cesium.Cartesian3(),
  );
  assert.ok(Math.abs(Cesium.Cartesian3.distance(center, oneViewerMetreUp) - 2) < 1e-9);
});

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
  const viewerLifetimeRef = { current: new CesiumViewerLifetime(viewerRef.current) };
  const bridgeRef = { current: { modelOrigin: { longitude: 0, latitude: 0, height: 0 },
    viewerRotation: { eastFromVx: 1, eastFromVz: 0, northFromVx: 0, northFromVz: -1 },
    viewerUpScale: 1,
    placement: { requested: 'anchor', mode: 'anchor', estimate: null, key: '' }, geoMapping: null,
  } as unknown as CesiumBridge };
  const zero = { x: 0, y: 0, z: 0 };
  const geometry: GeometryResult = { meshes: [{ expressId: 1, origin: [10, 20, 30],
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array(9),
    indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1] }], totalTriangles: 1, totalVertices: 3,
    coordinateInfo: { originalBounds: { min: zero, max: zero }, shiftedBounds: { min: zero, max: zero }, originShift: zero, hasLargeCoordinates: false } };
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('m', { idOffset: 0 }), geometryResult: geometry }),
    modelPlacement: emptyPlacementState(), hiddenEntities: new Set(), isolatedEntities: null, ghostExceptEntities: null });
  function World() {
    const { modelEpoch } = useCesiumModel({ status: 'ready', bridgeVersion: 0, viewerRef, viewerLifetimeRef, bridgeRef,
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

it('keeps the installed Anchor GLB where it is while an Exact bridge waits for its baked replacement', async () => {
  const Cesium = await loadCesium();
  mock.method(URL, 'createObjectURL', () => 'blob:exact-switch-test');
  mock.method(URL, 'revokeObjectURL', () => undefined);
  mock.method(Cesium.Model, 'fromGltfAsync', async (options: { modelMatrix: unknown }) => ({
    modelMatrix: options.modelMatrix, destroy() {},
  }) as unknown as InstanceType<typeof Cesium.Model>);
  const primitives = new Cesium.PrimitiveCollection();
  const viewerRef = { current: { scene: { primitives, requestRender() {} } } as unknown as InstanceType<typeof Cesium.Viewer> };
  const viewerLifetimeRef = { current: new CesiumViewerLifetime(viewerRef.current) };
  const anchorBridge = { modelOrigin: { longitude: 0, latitude: 0, height: 0 },
    viewerRotation: { eastFromVx: 1, eastFromVz: 0, northFromVx: 0, northFromVz: -1 },
    viewerUpScale: 1,
    placement: { requested: 'anchor', mode: 'anchor', estimate: null, key: '' }, geoMapping: null,
  } as unknown as CesiumBridge;
  const exactBridge = { ...anchorBridge, modelOrigin: { longitude: 10, latitude: 50, height: 0 },
    placement: { requested: 'exact', mode: 'exact', estimate: null, key: 'exact' }, geoMapping: {},
  } as unknown as CesiumBridge;
  const bridgeRef = { current: anchorBridge };
  const zero = { x: 0, y: 0, z: 0 };
  const geometry: GeometryResult = { meshes: [{ expressId: 1, origin: [10, 20, 30],
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array(9),
    indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1] }], totalTriangles: 1, totalVertices: 3,
    coordinateInfo: { originalBounds: { min: zero, max: zero }, shiftedBounds: { min: zero, max: zero }, originShift: zero, hasLargeCoordinates: false } };
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('m', { idOffset: 0 }), geometryResult: geometry }),
    modelPlacement: emptyPlacementState(), hiddenEntities: new Set(), isolatedEntities: null, ghostExceptEntities: null });
  let bumpBridge!: () => void;
  let model!: ReturnType<typeof useCesiumModel>['modelRef'];
  function World() {
    const [bridgeVersion, setBridgeVersion] = useState(0);
    bumpBridge = () => setBridgeVersion((v) => v + 1);
    const { modelEpoch, modelRef } = useCesiumModel({ status: 'ready', bridgeVersion, viewerRef, viewerLifetimeRef, bridgeRef,
      geometryResult: geometry, coordinateInfo: geometry.coordinateInfo });
    model = modelRef;
    return <output>{modelEpoch}</output>;
  }
  const ui = render(<World />); await advance(1250);
  assert.equal(ui.textContent, '1');
  const installed = Cesium.Matrix4.clone(model.current!.modelMatrix);
  bridgeRef.current = exactBridge;
  act(() => bumpBridge());
  await advance(100); // inside the load effect's 1 s deferral: the Anchor GLB is still the installed model
  assert.equal(ui.textContent, '1', 'the baked replacement has not been built yet');
  assert.ok(Cesium.Matrix4.equals(model.current!.modelMatrix, installed),
    'the Exact matrix must not be written onto the unbaked Anchor GLB');
});
