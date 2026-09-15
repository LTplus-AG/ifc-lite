/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it, mock } from 'node:test';
import { PrimitiveCollection } from 'cesium';
import type { GeometryResult } from '@ifc-lite/geometry';
import { advance, cleanup, render } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { emptyPlacementState } from '@/lib/model-placement/state';
import type { CesiumBridge } from '@/lib/geo/cesium-bridge';
import { loadCesium } from './cesium-module';
import { CesiumViewerLifetime } from './cesium-viewer-lifetime';
import { useCesiumModel } from './useCesiumModel';

afterEach(() => { cleanup(); mock.restoreAll(); });

it('retires mounted GLB work before a replacement Viewer owns the scene (#4807)', async () => {
  const Cesium = await loadCesium();
  let resolveModel!: (model: InstanceType<typeof Cesium.Model>) => void;
  const pendingModel = new Promise<InstanceType<typeof Cesium.Model>>((resolve) => { resolveModel = resolve; });
  mock.method(Cesium.Model, 'fromGltfAsync', () => pendingModel);
  mock.method(URL, 'createObjectURL', () => 'blob:lifecycle-test');
  mock.method(URL, 'revokeObjectURL', () => undefined);

  const oldPrimitives = new PrimitiveCollection();
  const oldViewer = { scene: { primitives: oldPrimitives, requestRender() {} } } as unknown as InstanceType<typeof Cesium.Viewer>;
  const viewerRef = { current: oldViewer };
  const viewerLifetimeRef = { current: new CesiumViewerLifetime(oldViewer) };
  const bridgeRef = { current: {
    modelOrigin: { longitude: 0, latitude: 0, height: 0 },
    viewerRotation: { eastFromVx: 1, eastFromVz: 0, northFromVx: 0, northFromVz: -1 },
    viewerUpScale: 1,
  } as unknown as CesiumBridge };
  const zero = { x: 0, y: 0, z: 0 };
  const geometry: GeometryResult = {
    meshes: [{ expressId: 1, origin: [0, 0, 0], positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1] }],
    totalTriangles: 1, totalVertices: 3,
    coordinateInfo: { originalBounds: { min: zero, max: zero }, shiftedBounds: { min: zero, max: zero }, originShift: zero, hasLargeCoordinates: false },
  };
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('m', { idOffset: 0 }), geometryResult: geometry }), modelPlacement: emptyPlacementState(), hiddenEntities: new Set(), isolatedEntities: null, ghostExceptEntities: null });
  function World() {
    useCesiumModel({ status: 'ready', bridgeVersion: 0, viewerRef, viewerLifetimeRef, bridgeRef, geometryResult: geometry, coordinateInfo: geometry.coordinateInfo });
    return null;
  }
  render(<World />);
  await advance(1_250);

  // This order is the production teardown order: retire first, then destroy
  // the old collection, then make a replacement viewer available to React.
  viewerLifetimeRef.current.retire();
  oldPrimitives.destroy();
  const replacement = { scene: { primitives: new PrimitiveCollection(), requestRender() {} } } as unknown as InstanceType<typeof Cesium.Viewer>;
  viewerRef.current = replacement;
  viewerLifetimeRef.current = new CesiumViewerLifetime(replacement);
  let releases = 0;
  resolveModel({ destroy() { releases += 1; } } as unknown as InstanceType<typeof Cesium.Model>);
  await advance(10);

  assert.equal(releases, 1, 'the late standalone model is released once');
  assert.equal(oldPrimitives.isDestroyed(), true);
  assert.equal(replacement.scene.primitives.length, 0, 'late work must not attach to the replacement viewer');
});
