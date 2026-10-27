/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The loader's two placements: an Exact bridge installs tile GLBs (anchor-ENU
 * positions with node translations) under a pure eastNorthUpToFixedFrame,
 * an Anchor bridge the unchanged viewer-space GLB under the viewer frame.
 */

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { resolveObjectURL } from 'node:buffer';
import * as Cesium from 'cesium';
import proj4 from 'proj4';
import type { GeometryResult } from '@ifc-lite/geometry';
import type { CesiumBridge } from '@/lib/geo/cesium-bridge';
import { createGeoMapping } from '@/lib/geo/geo-warp';
import { CesiumViewerLifetime } from './cesium-viewer-lifetime';
import { loadCesiumModel } from './cesium-model-load';

const UTM32 = '+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs';
const ANCHOR = { longitude: 9, latitude: 50, height: 167 };

async function load(placement: 'anchor' | 'exact') {
  const primitives = new Cesium.PrimitiveCollection();
  const viewer = { scene: { primitives, requestRender() {} } } as unknown as InstanceType<typeof Cesium.Viewer>;
  const lifetime = new CesiumViewerLifetime(viewer);
  const loaded: Array<{ nodes: Array<{ translation?: number[] }>; modelMatrix: Cesium.Matrix4 }> = [];
  const Stubbed = {
    ...Cesium,
    Model: {
      fromGltfAsync: async (options: { url: string; modelMatrix: Cesium.Matrix4 }) => {
        const glb = new Uint8Array(await resolveObjectURL(options.url)!.arrayBuffer());
        const jsonLen = new DataView(glb.buffer).getUint32(12, true);
        const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)));
        const model = { modelMatrix: options.modelMatrix, destroy() {} };
        loaded.push({ nodes: json.nodes, get modelMatrix() { return model.modelMatrix; } });
        return model;
      },
    },
  } as unknown as typeof Cesium;
  // A 3 km line of three triangles, so Exact spans two 2 km tiles.
  const meshes = [-1500, 0, 1500].map((x, i) => ({
    expressId: i + 1, origin: [x, 0, 0] as [number, number, number],
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1] as [number, number, number, number],
  }));
  const zero = { x: 0, y: 0, z: 0 };
  const geometry: GeometryResult = {
    meshes, totalTriangles: 3, totalVertices: 9,
    coordinateInfo: { originalBounds: { min: zero, max: zero }, shiftedBounds: { min: zero, max: zero }, originShift: zero, hasLargeCoordinates: false },
  };
  const [E0, N0] = proj4('WGS84', UTM32, [ANCHOR.longitude, ANCHOR.latitude]);
  // A plain IfcMapConversion at the anchor (true length), as `computeCesiumModelOrigin` places it.
  const geoMapping = createGeoMapping({
    mapConversion: { id: 1, sourceCRS: 2, targetCRS: 3, eastings: E0, northings: N0, orthogonalHeight: 120 },
    projectedCRS: { mapUnitScale: 1 },
    projDef: UTM32,
    coordinateInfo: geometry.coordinateInfo,
    origin: {
      ...ANCHOR, ifcOriginHeight: 120, easting: E0, northing: N0, scaleX: 1, scaleY: 1, scaleZ: 1,
      combinedScaleFactor: 0.9996, gridSource: null,
    },
    geoid: () => 47,
  });
  assert.ok(geoMapping);
  const bridge = {
    modelOrigin: ANCHOR,
    viewerRotation: { eastFromVx: 1, eastFromVz: 0, northFromVx: 0, northFromVz: -1 },
    viewerUpScale: 1,
    placement: { requested: placement, mode: placement, estimate: null, key: placement === 'exact' ? 'georef-1' : '' },
    geoMapping,
  } as unknown as CesiumBridge;
  let installed: { key: string; baked: boolean } | null = null;
  await loadCesiumModel({
    Cesium: Stubbed, viewer, lifetime, bridge, coordinateInfo: geometry.coordinateInfo,
    glbInput: { geometryResult: geometry, geometryContentVersion: 0, placementKey: 'p', hiddenIds: new Set(), isolatedIds: null, visibilityVersion: 0, ghostExceptIds: null, selectedIds: null, ghostVersion: 0 },
    glbCacheRef: { current: null }, modelRef: { current: null }, loadedKey: null,
    isSuperseded: () => false,
    onInstalled(_model, key, baked) { installed = { key, baked }; },
  });
  return { loaded, installed: installed as { key: string; baked: boolean } | null };
}

const enuFrame = () => Cesium.Transforms.eastNorthUpToFixedFrame(
  Cesium.Cartesian3.fromDegrees(ANCHOR.longitude, ANCHOR.latitude, ANCHOR.height));

it('Exact: tile GLBs with node translations under the anchor ENU frame, keyed by the georeference', async () => {
  const { loaded, installed } = await load('exact');
  assert.ok(installed);
  assert.equal(installed.baked, true);
  assert.match(installed.key, /:georef-1$/);
  assert.equal(loaded.length, 2, 'a 3 km line spans two 2 km tiles');
  for (const part of loaded) {
    assert.equal(part.nodes.length, 1);
    assert.equal(part.nodes[0].translation?.length, 3);
    assert.ok(Cesium.Matrix4.equalsEpsilon(part.modelMatrix, enuFrame(), 1e-9));
  }
});

it('Anchor: one viewer-space GLB without a node translation, not keyed by the georeference', async () => {
  const { loaded, installed } = await load('anchor');
  assert.ok(installed);
  assert.equal(installed.baked, false);
  assert.doesNotMatch(installed.key, /georef/);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].nodes[0].translation, undefined);
  assert.ok(!Cesium.Matrix4.equalsEpsilon(loaded[0].modelMatrix, enuFrame(), 1e-9), 'the viewer frame, not the bare ENU frame');
});
