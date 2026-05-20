/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { computeCesiumModelOrigin } from './cesium-bridge.js';
import {
  computeFootprintGeoJSON,
  computeModelCenterInIfcMeters,
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

  it('handles Bonsai files with explicit MapUnit=m + mm project + unset MapConversion.Scale', async () => {
    // Regression for Hans's IXAS_KW 018_georeffed.ifc — the file is spec-broken
    // in the same way most Bonsai/IfcOpenShell exports are:
    //
    //   IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)     ← project unit mm
    //   IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)            ← MapUnit explicitly m
    //   IFCMAPCONVERSION(#ctx,#crs,126500,480000,…,$) ← Scale UNSET
    //
    // Per the IFC schema the unset Scale defaults to 1.0; combined with the
    // mm-vs-m unit gap, our spec-strict effective scale becomes (1*1)/0.001
    // = 1000, inflating every viewer-space metre 1000× when added to the
    // map offsets. A 12 km infrastructure model becomes 12 000 km long,
    // which proj4's sterea extrapolates to the projection's antipode in the
    // South Pacific. The heuristic in getEffectiveHorizontalScale honours
    // the author's intent: Scale unset + units don't match → effective 1.
    const crs: ProjectedCRS = {
      id: 1,
      name: 'EPSG:28992',
      mapUnit: 'METRE',
      mapUnitScale: 1, // explicit IfcProjectedCRS.MapUnit=METRE
    };
    const conversion: MapConversion = {
      id: 2,
      sourceCRS: 10,
      targetCRS: 1,
      eastings: 126500,
      northings: 480000,
      orthogonalHeight: 0,
      xAxisAbscissa: 1,
      xAxisOrdinate: 0,
      scale: undefined, // ← the bug: Bonsai leaves Scale unset
    };
    // Project length unit = mm (0.001), as in Hans's file.
    const latLon = await reprojectToLatLon(conversion, crs, undefined, 0.001);
    assert.ok(latLon, 'should resolve');
    assert.ok(latLon!.lat > 51 && latLon!.lat < 54, `lat = ${latLon!.lat} (expected ~52°N for NL)`);
    assert.ok(latLon!.lon > 3 && latLon!.lon < 8, `lon = ${latLon!.lon} (expected ~5°E for NL)`);
  });

  it('treats unset MapUnit as METRES, not project length unit (Bonsai/IfcOpenShell convention)', async () => {
    // Regression for the antipode bug: a file with LengthUnit=mm and
    // MapConversion eastings/northings authored in METRES (typical surveyor
    // workflow) was being interpreted per the IFC spec letter — multiplied
    // by 0.001 to "convert mm → metres" — pushing the projected coords
    // outside RD New's valid range. proj4's sterea projection then
    // extrapolated to the projection's antipode, landing the model in the
    // South Pacific instead of the Netherlands.
    const crs: ProjectedCRS = {
      id: 1,
      name: 'EPSG:28992',
      // mapUnit deliberately unset — triggers the heuristic.
    };
    const conversion: MapConversion = {
      id: 2,
      sourceCRS: 10,
      targetCRS: 1,
      eastings: 126500,   // metres, as the file author intended
      northings: 480000,
      orthogonalHeight: 0,
      xAxisAbscissa: 1,
      xAxisOrdinate: 0,
      scale: 1,
    };
    // Project unit = millimetres (lengthUnitScale=0.001).
    const latLon = await reprojectToLatLon(conversion, crs, undefined, 0.001);
    assert.ok(latLon, 'should resolve');
    // Should land in the Netherlands (~52°N, ~5°E) — NOT at the antipode
    // (~−52°S, ~−175°W) which the spec-strict interpretation produces.
    assert.ok(latLon!.lat > 51 && latLon!.lat < 54, `lat = ${latLon!.lat} (expected ~52°N for NL)`);
    assert.ok(latLon!.lon > 3 && latLon!.lon < 8, `lon = ${latLon!.lon} (expected ~5°E for NL)`);
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
