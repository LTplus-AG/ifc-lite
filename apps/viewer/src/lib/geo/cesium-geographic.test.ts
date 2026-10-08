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
import { computeCesiumModelOrigin, createCesiumBridge } from './cesium-bridge';
import { reprojectToLatLon } from './reproject';

for (const control of [
  { code: '4806', lon: 0, lat: 42, expectedLon: 12.452333333333335, expectedLat: 42 },
  { code: '4267', lon: -100, lat: 40, expectedLon: -100.0004176222188, expectedLat: 40.00000948276804 },
]) {
  it(`#7060 EPSG:${control.code} Cesium center and off-center picks share the rendered ECEF frame`, async () => {
    const Cesium = await loadCesium();
    const crs: ProjectedCRS = { id: 3, name: `EPSG:${control.code}`, mapUnitScale: 0.001 };
    const conversion: MapConversion = { id: 1, sourceCRS: 2, targetCRS: 3,
      eastings: control.lon, northings: control.lat, orthogonalHeight: 100000,
      xAxisAbscissa: 0.6, xAxisOrdinate: 0.8, factorX: 1.2, factorY: 0.9, factorZ: 2 };
    const originalBounds = { min: { x: 2010, y: -30, z: -3010 }, max: { x: 2030, y: -20, z: -2990 } };
    for (const info of [undefined, ...[{ x: 0, y: 0, z: 0 }, { x: 2000, y: -35, z: -3000 }].map((shift): CoordinateInfo => ({
      originalBounds,
      shiftedBounds: {
        min: { x: originalBounds.min.x - shift.x, y: originalBounds.min.y - shift.y, z: originalBounds.min.z - shift.z },
        max: { x: originalBounds.max.x - shift.x, y: originalBounds.max.y - shift.y, z: originalBounds.max.z - shift.z },
      },
      originShift: shift, hasLargeCoordinates: true, wasmRtcOffset: { x: 50, y: -70, z: 40 },
    }))]) {
      const pin = await reprojectToLatLon(conversion, crs, info, 0.001);
      const origin = await computeCesiumModelOrigin(conversion, crs, info, 0.001);
      assert.ok(pin && origin);
      assert.ok(Math.abs(origin.longitude - control.expectedLon) < 1e-8);
      assert.ok(Math.abs(origin.latitude - control.expectedLat) < 1e-8);
      assert.equal(origin.longitude, pin.lon);
      assert.equal(origin.latitude, pin.lat);
      assert.equal(origin.ifcOriginHeight, info ? 130 : 100, 'vertical length units and RTC retain their existing contract');
      for (const placementOverride of [undefined, 123]) {
        const bridge = await createCesiumBridge(conversion, crs, info, 0.001, placementOverride);
        assert.ok(bridge);
        assert.equal(bridge.viewerUpScale, 2);
        assert.ok(Math.abs(Math.hypot(bridge.viewerRotation.eastFromVx, bridge.viewerRotation.northFromVx) - 1.2) < 1e-12);
        assert.ok(Math.abs(Math.hypot(bridge.viewerRotation.eastFromVz, bridge.viewerRotation.northFromVz) - 0.9) < 1e-12);
        const center = info ? new Cesium.Cartesian3(2020 - info.originShift.x, -25 - info.originShift.y, -3000 - info.originShift.z) : new Cesium.Cartesian3();
        const matrix = buildCesiumModelMatrix(Cesium, bridge, info);
        for (const point of [center, new Cesium.Cartesian3(center.x + 17, center.y + 9, center.z - 31)]) {
          const rendered = Cesium.Matrix4.multiplyByPoint(matrix, point, new Cesium.Cartesian3());
          const pick = bridge.viewerToGeodetic(point.x, point.y, point.z);
          assert.ok(pick);
          const renderedGeodetic = Cesium.Cartographic.fromCartesian(rendered);
          const pickedEcef = Cesium.Cartesian3.fromDegrees(pick.longitude, pick.latitude, renderedGeodetic.height);
          assert.ok(Cesium.Cartesian3.distance(rendered, pickedEcef) < 1e-7, 'pick XY must match the actual model matrix, including placement override');
          assert.equal(pick.height, origin.ifcOriginHeight + 2 * (point.y - center.y), 'height remains authored orthometric IFC metres, independent of geoid and override');
        }
        // #7060 camera terrain clamping must not move model-coordinate picks.
        const offCenter = new Cesium.Cartesian3(center.x + 17, center.y + 9, center.z - 31);
        const beforeClamp = bridge.viewerToGeodetic(offCenter.x, offCenter.y, offCenter.z);
        const camera = { position: new Cesium.Cartesian3(), direction: new Cesium.Cartesian3(),
          up: new Cesium.Cartesian3(), right: new Cesium.Cartesian3(),
          frustum: new Cesium.PerspectiveFrustum(), lookAtTransform() {} };
        camera.frustum.aspectRatio = 1;
        const viewer = { camera, scene: { requestRender() {} }, canvas: { width: 100, height: 100 } } as unknown as InstanceType<typeof Cesium.Viewer>;
        bridge.syncCamera(Cesium, viewer, center, { x: center.x + 1, y: center.y, z: center.z },
          { x: 0, y: 1, z: 0 }, Math.PI / 3, 1000);
        const afterClamp = bridge.viewerToGeodetic(offCenter.x, offCenter.y, offCenter.z);
        assert.deepEqual(afterClamp, beforeClamp, 'camera clamp must leave model picks and authored height unchanged');
        assert.ok(afterClamp);
        const rendered = Cesium.Matrix4.multiplyByPoint(matrix, offCenter, new Cesium.Cartesian3());
        const renderedGeodetic = Cesium.Cartographic.fromCartesian(rendered);
        const pickedEcef = Cesium.Cartesian3.fromDegrees(afterClamp.longitude, afterClamp.latitude, renderedGeodetic.height);
        assert.ok(Cesium.Cartesian3.distance(rendered, pickedEcef) < 1e-7, 'clamped camera picks still match the model frame');
        assert.equal(bridge.viewerToGeodetic(NaN, 0, 0), null);
      }
    }
  });
}

it('#7060 geographic Cesium origin refuses invalid source angles', async () => {
  const crs: ProjectedCRS = { id: 3, name: 'EPSG:4806', mapUnitScale: 0.001 };
  for (const northings of [91, NaN, Infinity]) {
    const conversion: MapConversion = { id: 1, sourceCRS: 2, targetCRS: 3, eastings: 0, northings, orthogonalHeight: 0 };
    assert.equal(await computeCesiumModelOrigin(conversion, crs), null);
    assert.equal(await createCesiumBridge(conversion, crs), null);
  }
});


it('#7060 geographic degrees never enter the map-absolute metre heuristic', async () => {
  const crs: ProjectedCRS = { id: 3, name: 'EPSG:4806', mapUnitScale: 1 };
  const conversion: MapConversion = { id: 1, sourceCRS: 2, targetCRS: 3,
    eastings: 200000, northings: 300000, orthogonalHeight: 0 };
  const info: CoordinateInfo = {
    originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: true,
    originalBounds: { min: { x: 199999, y: 0, z: -300001 }, max: { x: 200001, y: 0, z: -299999 } },
    shiftedBounds: { min: { x: 199999, y: 0, z: -300001 }, max: { x: 200001, y: 0, z: -299999 } },
  };
  assert.equal(await computeCesiumModelOrigin(conversion, crs, info), null);
  assert.equal(await createCesiumBridge(conversion, crs, info), null);
});
