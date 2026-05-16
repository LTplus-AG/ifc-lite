/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { computeCesiumModelOrigin } from './cesium-bridge.js';
import {
  computeFootprintGeoJSON,
  computeModelCenterInIfcMeters,
  inspectProjectionDef,
  reprojectFromLatLon,
  reprojectToLatLon,
  resolveProjection,
} from './reproject.js';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';

function makeCoordinateInfo(): CoordinateInfo {
  return {
    originShift: { x: 1000, y: 5, z: 2000 },
    originalBounds: {
      min: { x: -10, y: -1, z: -20 },
      max: { x: 10, y: 11, z: 20 },
    },
    shiftedBounds: {
      min: { x: -10, y: -1, z: -20 },
      max: { x: 10, y: 11, z: 20 },
    },
    hasLargeCoordinates: true,
    wasmRtcOffset: { x: 3, y: 7, z: 11 },
  };
}

describe('reproject helpers', () => {
  it('computes the IFC-space model center from originShift and RTC', () => {
    const center = computeModelCenterInIfcMeters(makeCoordinateInfo());
    assert.deepStrictEqual(center, {
      ifcX: 1003,
      ifcY: -1993,
      ifcZ: 21,
    });
  });

  it('round-trips the #652 EPSG:5514 issue fixture coordinates', async () => {
    const crs: ProjectedCRS = {
      id: 114,
      name: 'EPSG:5514',
      verticalDatum: 'EPSG:8357',
      mapUnit: 'METRE',
      mapUnitScale: 1,
    };
    const conversion: MapConversion = {
      id: 115,
      sourceCRS: 14,
      targetCRS: 114,
      eastings: -740344,
      northings: -1048817,
      orthogonalHeight: 244,
      scale: 0.001,
    };

    const latLon = await reprojectToLatLon(conversion, crs, undefined, 0.001);
    assert.ok(latLon);
    const roundTrip = await reprojectFromLatLon(latLon!, crs, conversion, undefined, 0.001);
    assert.ok(roundTrip);
    assert.ok(Math.abs(roundTrip!.easting - conversion.eastings) < 0.001);
    assert.ok(Math.abs(roundTrip!.northing - conversion.northings) < 0.001);

    const origin = await computeCesiumModelOrigin(conversion, crs, undefined, 0.001);
    assert.ok(origin);
    assert.ok(Math.abs(origin!.longitude - latLon!.lon) < 1e-9);
    assert.ok(Math.abs(origin!.latitude - latLon!.lat) < 1e-9);
    assert.strictEqual(origin!.ifcOriginHeight, 244);
    assert.strictEqual(origin!.horizontalScale, 1);
  });

  it('resolves EPSG:28992 and round-trips projected coordinates', async () => {
    const crs: ProjectedCRS = {
      id: 1,
      name: 'EPSG:28992',
      mapUnit: 'METRE',
      mapUnitScale: 1,
    };
    const conversion: MapConversion = {
      id: 2,
      sourceCRS: 10,
      targetCRS: 1,
      eastings: 121687.331,
      northings: 487326.994,
      orthogonalHeight: 0,
      xAxisAbscissa: 1,
      xAxisOrdinate: 0,
      scale: 1,
    };

    const projDef = await resolveProjection(crs);
    assert.ok(projDef);

    const latLon = await reprojectToLatLon(conversion, crs);
    assert.ok(latLon);
    const roundTrip = await reprojectFromLatLon(latLon!, crs, conversion);
    assert.ok(roundTrip);
    assert.ok(Math.abs(roundTrip!.easting - conversion.eastings) < 0.01);
    assert.ok(Math.abs(roundTrip!.northing - conversion.northings) < 0.01);
  });

  it('resolves Dutch RD New from a non-EPSG name via WELL_KNOWN_CRS', async () => {
    // Some authoring tools emit the human-readable CRS name instead of "EPSG:28992".
    // Without an alias entry, resolveProjection would fall through to the network
    // fetch and break offline. Verify the alias path lands on the same definition.
    const aliasCrs: ProjectedCRS = {
      id: 1,
      name: 'Amersfoort / RD New',
      mapUnit: 'METRE',
      mapUnitScale: 1,
    };
    const def = await resolveProjection(aliasCrs);
    assert.ok(def, 'alias should resolve via WELL_KNOWN_CRS');
    assert.ok(def!.includes('+proj=sterea'), 'should be RD oblique stereographic');
    assert.ok(def!.includes('+towgs84='), 'should carry datum-shift parameters');
  });

  it('exposes projection diagnostics for the GeoreferencingPanel', async () => {
    const crs: ProjectedCRS = { id: 1, name: 'EPSG:28992', mapUnit: 'METRE' };
    const def = await resolveProjection(crs);
    const diag = inspectProjectionDef(def, 'Amersfoort');
    assert.strictEqual(diag.hasTowgs84, true);
    assert.strictEqual(diag.hasNadgrids, false);
    assert.strictEqual(diag.ellipsoid, 'bessel');
    assert.strictEqual(diag.datumKnown, true);
  });

  it('reports an unknown datum when no fallback is registered', () => {
    const fakeDef = '+proj=utm +zone=11 +ellps=clrk80 +units=m +no_defs';
    const diag = inspectProjectionDef(fakeDef, 'Some Obscure Datum');
    assert.strictEqual(diag.datumKnown, false);
    assert.strictEqual(diag.hasTowgs84, false);
  });

  it('builds a closed footprint polygon and preserves corner count', async () => {
    const crs: ProjectedCRS = {
      id: 114,
      name: 'EPSG:5514',
      mapUnit: 'METRE',
      mapUnitScale: 1,
    };
    const conversion: MapConversion = {
      id: 115,
      sourceCRS: 14,
      targetCRS: 114,
      eastings: -740344,
      northings: -1048817,
      orthogonalHeight: 244,
      scale: 0.001,
    };

    const footprint = await computeFootprintGeoJSON(conversion, crs, makeCoordinateInfo(), 0.001);
    assert.ok(footprint);
    assert.strictEqual(footprint!.length, 5);
    assert.deepStrictEqual(footprint![0], footprint![4]);
  });
});
