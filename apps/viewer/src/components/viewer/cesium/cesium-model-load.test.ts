/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { PrimitiveCollection } from 'cesium';
import type { GeometryResult } from '@ifc-lite/geometry';
import type { CesiumBridge } from '@/lib/geo/cesium-bridge';
import { CesiumViewerLifetime } from './cesium-viewer-lifetime';
import { loadCesiumModel } from './cesium-model-load';
import type { CesiumModelPrimitive } from './cesium-model-renderable';

class Cartesian3 {
  static readonly ZERO = new Cartesian3();
  static fromDegrees(): Cartesian3 { return new Cartesian3(); }
  constructor(_x = 0, _y = 0, _z = 0) {}
}
class Matrix4 {
  static multiply(_left: Matrix4, _right: Matrix4, result: Matrix4): Matrix4 { return result; }
  constructor(..._values: number[]) {}
}

it('releases a first model when attachment queues supersession before publication (#4807)', async () => {
  const primitives = new PrimitiveCollection();
  let destroyed = false;
  const viewer = {
    get scene() {
      if (destroyed) throw new Error('Viewer.destroy() invalidated scene');
      return { primitives, requestRender() {} };
    },
  } as unknown as InstanceType<typeof import('cesium').Viewer>;
  const lifetime = new CesiumViewerLifetime(viewer);
  let releases = 0;
  const next = { modelMatrix: new Matrix4(), destroy() { releases += 1; } };
  const Cesium = {
    Cartesian3, Matrix4,
    Transforms: { eastNorthUpToFixedFrame: () => new Matrix4() },
    Model: { fromGltfAsync: async () => next },
    ShadowMode: { DISABLED: 0 }, Axis: { Z: 2, X: 0 },
  } as unknown as typeof import('cesium');
  let superseded = false;
  primitives.primitiveAdded.addEventListener(() => {
    lifetime.retire();
    primitives.destroy();
    destroyed = true;
    superseded = true;
  });
  const zero = { x: 0, y: 0, z: 0 };
  const geometry: GeometryResult = {
    meshes: [{ expressId: 1, origin: [0, 0, 0], positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1] }],
    totalTriangles: 1, totalVertices: 3,
    coordinateInfo: { originalBounds: { min: zero, max: zero }, shiftedBounds: { min: zero, max: zero }, originShift: zero, hasLargeCoordinates: false },
  };
  const modelRef = { current: null };
  let installed = 0;
  await loadCesiumModel({
    Cesium, viewer, lifetime,
    bridge: { modelOrigin: { longitude: 0, latitude: 0, height: 0 }, viewerRotation: { eastFromVx: 1, eastFromVz: 0, northFromVx: 0, northFromVz: -1 }, viewerUpScale: 1 } as CesiumBridge,
    coordinateInfo: geometry.coordinateInfo,
    glbInput: { geometryResult: geometry, geometryContentVersion: 0, placementKey: 'first', hiddenIds: new Set(), isolatedIds: null, visibilityVersion: 0, ghostExceptIds: null, selectedIds: null, ghostVersion: 0 },
    glbCacheRef: { current: null }, modelRef, loadedKey: null,
    isSuperseded: () => superseded,
    onInstalled() { installed += 1; },
  });

  assert.equal(primitives.length, 0);
  assert.equal(releases, 1);
  assert.equal(modelRef.current, null);
  assert.equal(installed, 0);
});

it('keeps a completed replacement swap as the next build\'s predecessor (#4807)', async () => {
  const primitives = new PrimitiveCollection();
  const viewer = {
    scene: { primitives, requestRender() {} },
  } as unknown as InstanceType<typeof import('cesium').Viewer>;
  const lifetime = new CesiumViewerLifetime(viewer);
  let previousReleases = 0;
  let nextReleases = 0;
  const previous = {
    modelMatrix: new Matrix4(),
    destroy() { previousReleases += 1; },
  };
  const next = {
    modelMatrix: new Matrix4(),
    destroy() { nextReleases += 1; },
  };
  primitives.add(previous);
  let superseded = false;
  primitives.primitiveRemoved.addEventListener((removed) => {
    if (removed === previous) queueMicrotask(() => { superseded = true; });
  });
  const Cesium = {
    Cartesian3, Matrix4,
    Transforms: { eastNorthUpToFixedFrame: () => new Matrix4() },
    Model: { fromGltfAsync: async () => next },
    ShadowMode: { DISABLED: 0 }, Axis: { Z: 2, X: 0 },
  } as unknown as typeof import('cesium');
  const zero = { x: 0, y: 0, z: 0 };
  const geometry: GeometryResult = {
    meshes: [{ expressId: 1, origin: [0, 0, 0], positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1] }],
    totalTriangles: 1, totalVertices: 3,
    coordinateInfo: { originalBounds: { min: zero, max: zero }, shiftedBounds: { min: zero, max: zero }, originShift: zero, hasLargeCoordinates: false },
  };
  const modelRef: { current: CesiumModelPrimitive | null } = {
    current: previous as unknown as CesiumModelPrimitive,
  };
  let installed = 0;

  await loadCesiumModel({
    Cesium, viewer, lifetime,
    bridge: { modelOrigin: { longitude: 0, latitude: 0, height: 0 }, viewerRotation: { eastFromVx: 1, eastFromVz: 0, northFromVx: 0, northFromVz: -1 }, viewerUpScale: 1 } as CesiumBridge,
    coordinateInfo: geometry.coordinateInfo,
    glbInput: { geometryResult: geometry, geometryContentVersion: 1, placementKey: 'replacement', hiddenIds: new Set(), isolatedIds: null, visibilityVersion: 0, ghostExceptIds: null, selectedIds: null, ghostVersion: 0 },
    glbCacheRef: { current: null }, modelRef, loadedKey: 'previous',
    isSuperseded: () => superseded,
    onInstalled() { installed += 1; },
  });

  assert.equal(superseded, true, 'the newer build took over after the completed swap');
  assert.equal(primitives.length, 1, 'the globe keeps the successfully swapped model');
  assert.equal(primitives.get(0), next);
  assert.equal(previousReleases, 1);
  assert.equal(nextReleases, 0);
  assert.equal(modelRef.current, next, 'the next build sees the interim predecessor');
  assert.equal(installed, 1);
});

it('lets geometry teardown remove the synchronously published replacement (#4807)', async () => {
  const primitives = new PrimitiveCollection();
  const viewer = { scene: { primitives, requestRender() {} } } as unknown as InstanceType<typeof import('cesium').Viewer>;
  const lifetime = new CesiumViewerLifetime(viewer);
  let previousReleases = 0;
  let nextReleases = 0;
  const previous = { modelMatrix: new Matrix4(), destroy() { previousReleases += 1; } };
  const next = { modelMatrix: new Matrix4(), destroy() { nextReleases += 1; } };
  const modelRef: { current: CesiumModelPrimitive | null } = {
    current: previous as unknown as CesiumModelPrimitive,
  };
  primitives.add(previous);
  let cancelled = false;
  let advertisedLoaded = false;
  primitives.primitiveRemoved.addEventListener((removed) => {
    if (removed !== previous) return;
    queueMicrotask(() => {
      cancelled = true;
      if (modelRef.current) primitives.remove(modelRef.current);
      modelRef.current = null;
      advertisedLoaded = false;
    });
  });
  const Cesium = {
    Cartesian3, Matrix4,
    Transforms: { eastNorthUpToFixedFrame: () => new Matrix4() },
    Model: { fromGltfAsync: async () => next },
    ShadowMode: { DISABLED: 0 }, Axis: { Z: 2, X: 0 },
  } as unknown as typeof import('cesium');
  const zero = { x: 0, y: 0, z: 0 };
  const geometry: GeometryResult = {
    meshes: [{ expressId: 1, origin: [0, 0, 0], positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1] }],
    totalTriangles: 1, totalVertices: 3,
    coordinateInfo: { originalBounds: { min: zero, max: zero }, shiftedBounds: { min: zero, max: zero }, originShift: zero, hasLargeCoordinates: false },
  };

  await loadCesiumModel({
    Cesium, viewer, lifetime,
    bridge: { modelOrigin: { longitude: 0, latitude: 0, height: 0 }, viewerRotation: { eastFromVx: 1, eastFromVz: 0, northFromVx: 0, northFromVz: -1 }, viewerUpScale: 1 } as CesiumBridge,
    coordinateInfo: geometry.coordinateInfo,
    glbInput: { geometryResult: geometry, geometryContentVersion: 2, placementKey: 'removed', hiddenIds: new Set(), isolatedIds: null, visibilityVersion: 0, ghostExceptIds: null, selectedIds: null, ghostVersion: 0 },
    glbCacheRef: { current: null }, modelRef, loadedKey: 'previous',
    isSuperseded: () => cancelled,
    onInstalled() { advertisedLoaded = true; },
  });

  assert.equal(cancelled, true);
  assert.equal(primitives.length, 0, 'teardown removes the committed replacement');
  assert.equal(previousReleases, 1);
  assert.equal(nextReleases, 1);
  assert.equal(modelRef.current, null, 'the stale continuation does not republish');
  assert.equal(advertisedLoaded, false);
});
