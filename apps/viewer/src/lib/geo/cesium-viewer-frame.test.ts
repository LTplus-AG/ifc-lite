/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import { loadCesium } from '@/components/viewer/cesium/cesium-module';
import { buildCesiumModelMatrix } from '@/components/viewer/cesium/cesium-model-load';
import { createCesiumBridge, type GeodesicPosition } from './cesium-bridge';
import { computeCesiumPlacement } from './cesium-placement';

// #7057 invariant: applying originShift changes only the renderer frame. A point's
// geographic position, Cesium model and camera must all remain at the same place.
it('keeps Cesium model, camera, picks and terrain in one shifted renderer frame', async () => {
  const Cesium = await loadCesium();
  const conversion: MapConversion = { id: 1, sourceCRS: 2, targetCRS: 3,
    eastings: 500000, northings: 5500000, orthogonalHeight: 100,
    xAxisAbscissa: 0.6, xAxisOrdinate: 0.8, scale: 1,
    factorX: 1.2, factorY: 0.9, factorZ: 2 };
  const crs: ProjectedCRS = { id: 3, name: 'EPSG:32632', mapUnitScale: 1 };
  let referencePoint: InstanceType<typeof Cesium.Cartesian3> | undefined;
  let referencePick: GeodesicPosition | undefined;
  for (const shift of [{ x: 0, y: 0, z: 0 }, { x: 2000, y: -35, z: -3000 }]) {
    const info: CoordinateInfo = {
      originalBounds: { min: { x: 2010, y: -30, z: -3010 }, max: { x: 2030, y: -20, z: -2990 } },
      shiftedBounds: {
        min: { x: 2010 - shift.x, y: -30 - shift.y, z: -3010 - shift.z },
        max: { x: 2030 - shift.x, y: -20 - shift.y, z: -2990 - shift.z },
      },
      originShift: shift, hasLargeCoordinates: true,
      wasmRtcOffset: { x: 50, y: -70, z: 40 },
    };
    const center = new Cesium.Cartesian3(2020 - shift.x, -25 - shift.y, -3000 - shift.z);
    const bridge = await createCesiumBridge(conversion, crs, info, 1, undefined, true);
    assert.ok(bridge);
    const picked = bridge.viewerToGeodetic(center.x, center.y, center.z);
    assert.ok(picked);
    const expected = Cesium.Cartesian3.fromDegrees(picked.longitude, picked.latitude, picked.height);
    const modelCenter = Cesium.Matrix4.multiplyByPoint(
      buildCesiumModelMatrix(Cesium, bridge, info), center, new Cesium.Cartesian3(),
    );
    assert.ok(Cesium.Cartesian3.distance(modelCenter, expected) < 1e-7,
      'the rendered center must coincide with its independently projected pick');
    const point = new Cesium.Cartesian3(center.x + 7, center.y + 2, center.z - 4);
    const renderedPoint = Cesium.Matrix4.multiplyByPoint(
      buildCesiumModelMatrix(Cesium, bridge, info), point, new Cesium.Cartesian3(),
    );
    const pointPick = bridge.viewerToGeodetic(point.x, point.y, point.z);
    assert.ok(pointPick);
    if (referencePoint) {
      assert.ok(Cesium.Cartesian3.distance(renderedPoint, referencePoint) < 1e-7,
        'originShift must preserve off-center mesh positions');
      assert.deepEqual(pointPick, referencePick, 'originShift must preserve geographic picks');
    } else {
      referencePoint = renderedPoint;
      referencePick = pointPick;
    }
    const camera = { position: new Cesium.Cartesian3(), direction: new Cesium.Cartesian3(),
      up: new Cesium.Cartesian3(), right: new Cesium.Cartesian3(),
      frustum: new Cesium.PerspectiveFrustum(), lookAtTransform() {} };
    camera.frustum.aspectRatio = 1;
    const viewer = { camera, scene: { requestRender() {} }, canvas: { width: 100, height: 100 } } as unknown as InstanceType<typeof Cesium.Viewer>;
    bridge.syncCamera(Cesium, viewer, center, { x: center.x + 1, y: center.y, z: center.z },
      { x: 0, y: 1, z: 0 }, Math.PI / 3);
    assert.ok(Cesium.Cartesian3.distance(camera.position, expected) < 1e-7,
      'camera and model must use the same renderer frame');
    bridge.syncCamera(Cesium, viewer, point, { x: point.x + 1, y: point.y, z: point.z },
      { x: 0, y: 1, z: 0 }, Math.PI / 3);
    assert.ok(Cesium.Cartesian3.distance(camera.position, renderedPoint) < 1e-7,
      'camera position must coincide with the same off-center mesh point');
    const placement = computeCesiumPlacement({ coordinateInfo: info,
      ifcOriginHeight: picked.height, terrainHeight: picked.height + 6,
      viewerUpScale: bridge.viewerUpScale, storeyElevations: new Map([[1, -25]]) });
    assert.equal(placement.modelCenterY, center.y);
    assert.equal(placement.clampAnchorY, center.y);
    assert.equal(placement.minY, info.shiftedBounds.min.y);
    assert.equal(placement.terrainClipY, center.y + 3);
  }
});
