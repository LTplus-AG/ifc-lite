/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import { advance, cleanup, waitFor } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { useAnchorGeoreference } from '@/lib/geo/useAnchorGeoreference';
import { createCesiumBridge } from '@/lib/geo/cesium-bridge';
import { loadCesium } from '@/components/viewer/cesium/cesium-module';
import { buildCesiumModelMatrix } from '@/components/viewer/cesium/cesium-model-load';
import { EnhLine, projectedEnh, useProjectedLatLon, type Vec3Like } from './geo-readout';

const initialState = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initialState); });

const info: CoordinateInfo = {
  originalBounds: { min: { x: 2010, y: -30, z: -3010 }, max: { x: 2030, y: -20, z: -2990 } },
  shiftedBounds: { min: { x: 10, y: 5, z: -10 }, max: { x: 30, y: 15, z: 10 } },
  originShift: { x: 2000, y: -35, z: -3000 }, hasLargeCoordinates: true,
  wasmRtcOffset: { x: 50, y: -70, z: 40 },
};
const geographicCrs: ProjectedCRS = { id: 3, name: 'EPSG:4806', mapUnitScale: 0.001 };
const conversion: MapConversion = { id: 1, sourceCRS: 2, targetCRS: 3,
  eastings: 0, northings: 42, orthogonalHeight: 100000,
  xAxisAbscissa: 0.6, xAxisOrdinate: 0.8, factorX: 1.2, factorY: 0.9, factorZ: 2 };

function seed(crs: ProjectedCRS, mapConversion: MapConversion, coordinateInfo = info) {
  const model = fixtureModel('geo');
  assert.ok(model.ifcDataStore);
  model.ifcDataStore.georeferencing = { hasGeoreference: true, projectedCRS: crs, mapConversion };
  model.ifcDataStore.lengthUnitScale = 0.001;
  model.geometryResult = { meshes: [], totalVertices: 0, totalTriangles: 0, coordinateInfo };
  useViewerStore.setState({ ...fixtureModels(model), georefMutations: new Map(), anchorModelIdOverride: null });
}

function Probe({ point }: { point: Vec3Like }) {
  const anchor = useAnchorGeoreference();
  const latLon = useProjectedLatLon(point, anchor);
  return <>
    <span data-testid="lat-lon">{latLon ? JSON.stringify(latLon) : ''}</span>
    {anchor && <div data-testid="enh"><EnhLine enh={projectedEnh(point, anchor)} /></div>}
  </>;
}

it('geographic measurement readouts follow actual center/off-center model placement and hide metre E/N (#7060)', async (t) => {
  seed(geographicCrs, conversion);
  const Cesium = await loadCesium();
  const cartographic = t.mock.method(Cesium.Cartographic, 'fromCartesian');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    let mapConversion = conversion;
    let coordinateInfo = info;
    for (const point of [{ x: 20, y: 10, z: 0 }, { x: 37, y: 19, z: -31 }]) {
      const bridge = await createCesiumBridge(mapConversion, geographicCrs, coordinateInfo, 0.001);
      assert.ok(bridge);
      const ecef = Cesium.Matrix4.multiplyByPoint(buildCesiumModelMatrix(Cesium, bridge, coordinateInfo),
        new Cesium.Cartesian3(point.x, point.y, point.z), new Cesium.Cartesian3());
      const expected = Cesium.Cartographic.fromCartesian(ecef);
      act(() => root.render(<Probe point={point} />));
      await waitFor(() => {
        const text = host.querySelector('[data-testid="lat-lon"]')?.textContent;
        if (!text) return false;
        const result: { lon: number; lat: number } = JSON.parse(text);
        return Math.abs(result.lon - Cesium.Math.toDegrees(expected.longitude)) < 1e-10
          && Math.abs(result.lat - Cesium.Math.toDegrees(expected.latitude)) < 1e-10;
      }, 'picked-point latitude/longitude must match the actual model ECEF position');
      assert.equal(host.querySelector('[data-testid="enh"]')?.textContent, '', 'angular XY must not appear as metre E/N');
      const calls = cartographic.mock.callCount();
      act(() => root.render(<Probe point={{ ...point }} />));
      await advance(5);
      assert.equal(cartographic.mock.callCount(), calls, 'unrelated renders must not repeat the geographic pick');
    }
    // Keep the same point and geographic anchor: rotation, anisotropic scales,
    // height and geometry-center edits all alter the physical frame, not E/N.
    mapConversion = { ...conversion, xAxisAbscissa: 0, xAxisOrdinate: 1,
      factorX: 2, factorY: 3, orthogonalHeight: 200000 };
    coordinateInfo = { ...info, originalBounds: {
      min: { ...info.originalBounds.min, x: 2030 }, max: { ...info.originalBounds.max, x: 2050 },
    }, shiftedBounds: {
      min: { ...info.shiftedBounds.min, x: 30 }, max: { ...info.shiftedBounds.max, x: 50 },
    } };
    const point = { x: 37, y: 19, z: -31 };
    const bridge = await createCesiumBridge(mapConversion, geographicCrs, coordinateInfo, 0.001);
    assert.ok(bridge);
    const ecef = Cesium.Matrix4.multiplyByPoint(buildCesiumModelMatrix(Cesium, bridge, coordinateInfo),
      new Cesium.Cartesian3(point.x, point.y, point.z), new Cesium.Cartesian3());
    const expected = Cesium.Cartographic.fromCartesian(ecef);
    act(() => seed(geographicCrs, mapConversion, coordinateInfo));
    await waitFor(() => {
      const text = host.querySelector('[data-testid="lat-lon"]')?.textContent;
      if (!text) return false;
      const result: { lon: number; lat: number } = JSON.parse(text);
      return Math.abs(result.lon - Cesium.Math.toDegrees(expected.longitude)) < 1e-10
        && Math.abs(result.lat - Cesium.Math.toDegrees(expected.latitude)) < 1e-10;
    }, 'a same-angle frame edit must invalidate the picked-point readout');
  } finally {
    act(() => root.unmount()); host.remove();
  }
});

it('projected measurements retain metre E/N and real UTM latitude/longitude (#7060)', async () => {
  const zero = { x: 0, y: 0, z: 0 };
  seed({ id: 3, name: 'EPSG:32632', mapUnitScale: 1 },
    { ...conversion, eastings: 500000, northings: 0, orthogonalHeight: 0,
      xAxisAbscissa: 1, xAxisOrdinate: 0, factorX: 1, factorY: 1, factorZ: 1, scale: 0.001 },
    { originShift: zero, originalBounds: { min: zero, max: zero }, shiftedBounds: { min: zero, max: zero }, hasLargeCoordinates: false });
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  try {
    act(() => root.render(<Probe point={zero} />));
    await waitFor(() => !!host.querySelector('[data-testid="lat-lon"]')?.textContent, 'projected coordinate did not resolve');
    const text = host.querySelector('[data-testid="lat-lon"]')?.textContent;
    assert.ok(text);
    const actual: { lon: number; lat: number } = JSON.parse(text);
    assert.ok(Math.abs(actual.lon - 9) < 1e-10 && Math.abs(actual.lat) < 1e-10);
    assert.match(host.querySelector('[data-testid="enh"]')?.textContent ?? '', /500000\.000/);
  } finally { act(() => root.unmount()); host.remove(); }
});

it('geographic readout follows the model when authored heights switch to ellipsoidal (#7060)', async () => {
  const crs: ProjectedCRS = { id: 3, name: 'EPSG:4326', mapUnitScale: 1 };
  const mapConversion: MapConversion = { ...conversion, eastings: 5, northings: 52,
    orthogonalHeight: 100, xAxisAbscissa: 1, xAxisOrdinate: 0,
    factorX: 1, factorY: 1, factorZ: 1 };
  const zero = { x: 0, y: 0, z: 0 };
  const bounds = { min: { x: -30000, y: -10, z: -30000 }, max: { x: 30000, y: 10, z: 30000 } };
  const coordinateInfo: CoordinateInfo = { originShift: zero, originalBounds: bounds,
    shiftedBounds: bounds, hasLargeCoordinates: false };
  seed(crs, mapConversion, coordinateInfo);
  useViewerStore.setState({ cesiumHeightsAreEllipsoidal: false });
  const point = { x: 10000, y: 0, z: -20000 };
  const Cesium = await loadCesium();
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  let previous: { lon: number; lat: number } | undefined;
  try {
    for (const ellipsoidal of [false, true, false]) {
      const bridge = await createCesiumBridge(mapConversion, crs, coordinateInfo, 0.001, undefined, ellipsoidal);
      assert.ok(bridge);
      const rendered = Cesium.Matrix4.multiplyByPoint(buildCesiumModelMatrix(Cesium, bridge, coordinateInfo),
        new Cesium.Cartesian3(point.x, point.y, point.z), new Cesium.Cartesian3());
      const expected = Cesium.Cartographic.fromCartesian(rendered);
      act(() => {
        useViewerStore.setState({ cesiumHeightsAreEllipsoidal: ellipsoidal });
        root.render(<Probe point={point} />);
      });
      await waitFor(() => {
        const text = host.querySelector('[data-testid="lat-lon"]')?.textContent;
        if (!text) return false;
        const actual: { lon: number; lat: number } = JSON.parse(text);
        return Math.abs(actual.lon - Cesium.Math.toDegrees(expected.longitude)) < 1e-10
          && Math.abs(actual.lat - Cesium.Math.toDegrees(expected.latitude)) < 1e-10;
      }, 'height-mode changes must rebuild the readout in the actual model frame');
      const current = { lon: Cesium.Math.toDegrees(expected.longitude), lat: Cesium.Math.toDegrees(expected.latitude) };
      if (previous) assert.notDeepEqual(current, previous, 'the control must distinguish the two physical altitude frames');
      previous = current;
    }
  } finally { act(() => root.unmount()); host.remove(); }
});
