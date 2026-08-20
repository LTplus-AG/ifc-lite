/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { computeCesiumModelOrigin } from './cesium-bridge.js';
import {
  computeFootprintGeoJSON,
  computeModelCenterInIfcMeters,
  effectiveMapConversionForGeometry,
  reprojectFromLatLon,
  reprojectionInputKey,
  reprojectPointToLatLon,
  reprojectToLatLon,
  resolveProjection,
  sanitizeProj4,
} from './reproject.js';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';

const close = (a: number, b: number, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${a} to be close to ${b}`);

/**
 * The producer's invariant is `shiftedBounds = originalBounds - originShift`
 * (utils/localParsingUtils.ts). The previous fixture set a non-zero
 * `originShift` while making the two bound sets IDENTICAL — a shape no
 * producer can emit — so any consumer reading the wrong one of the pair
 * produced the same numbers and the suite could not tell them apart. That is
 * why the double-shift in `computeModelCenterInIfcMeters` survived.
 *
 * These bounds satisfy the invariant, so the two are now distinguishable.
 */
function makeCoordinateInfo(): CoordinateInfo {
  return {
    originShift: { x: 1000, y: 5, z: 2000 },
    originalBounds: {
      min: { x: 990, y: 4, z: 1980 },
      max: { x: 1010, y: 16, z: 2020 },
    },
    shiftedBounds: {
      min: { x: -10, y: -1, z: -20 },
      max: { x: 10, y: 11, z: 20 },
    },
    hasLargeCoordinates: true,
    wasmRtcOffset: { x: 3, y: 7, z: 11 },
  };
}

describe('sanitizeProj4 datum shift (#1357)', () => {
  const SJTSK = '+towgs84=570.8,85.7,462.8,4.998,1.587,5.261,3.56';

  it('adds the datum +towgs84 to an offset-datum def that lacks any shift (e.g. Ferro Krovak EPSG:2065)', () => {
    const ferro = '+proj=krovak +axis=swu +lat_0=49.5 +lon_0=42.5 +alpha=30.2881397527778 '
      + '+k=0.9999 +x_0=0 +y_0=0 +ellps=bessel +pm=ferro +units=m +no_defs';
    // The bundled EPSG index (packages/data) reports this code's datum as
    // "S-JTSK (Ferro)", not "S-JTSK" — verified against
    // packages/data/src/generated/epsg-index.generated.ts. Using the plain
    // "S-JTSK" name here made this fixture unable to observe a datum-key
    // lookup miss: production always passes the "(Ferro)" form for 2065.
    const out = sanitizeProj4(ferro, '2065', 'S-JTSK (Ferro)');
    assert.ok(out.includes(SJTSK), `expected +towgs84 to be injected, got: ${out}`);
    assert.ok(out.includes('+pm=ferro'), 'must preserve the rest of the definition');
  });

  it('adds the datum +towgs84 for OSGB36 (EPSG:27700) using the bundled index datum name', () => {
    // packages/data's bundled entry for 27700 reports datum "OSGB36" (no
    // space, no "1936"), which must resolve through the same lookup as the
    // 'osgb 1936' key below.
    const OSGB = '+towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489';
    const withGrid = '+proj=tmerc +ellps=airy +nadgrids=OSTN15_NTv2_OSGBtoETRS.gsb +units=m +no_defs';
    const out = sanitizeProj4(withGrid, '27700', 'OSGB36');
    assert.ok(!out.includes('+nadgrids'), 'must drop the unusable grid reference');
    assert.ok(out.includes(OSGB), `expected OSGB36 +towgs84 to be injected, got: ${out}`);
  });

  it('strips an unusable +nadgrids and substitutes the datum +towgs84', () => {
    const withGrid = '+proj=krovak +ellps=bessel +nadgrids=cz_cuzk_CR-2005.tif +units=m +no_defs';
    const out = sanitizeProj4(withGrid, '5514', 'S-JTSK');
    assert.ok(!out.includes('+nadgrids'), 'must drop the grid reference');
    assert.ok(out.includes(SJTSK), 'must add the +towgs84 fallback');
  });

  it('leaves an existing +towgs84 untouched', () => {
    const def = '+proj=utm +zone=33 +ellps=bessel +towgs84=1,2,3,0,0,0,0 +units=m +no_defs';
    assert.equal(sanitizeProj4(def, '9999', 'S-JTSK'), def);
  });

  it('leaves a WGS84-aligned def (unknown datum) unchanged', () => {
    const def = '+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs';
    assert.equal(sanitizeProj4(def, '32632', 'WGS 84'), def);
  });
});

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

  it('round-trips with a non-identity rotation AND a non-zero geometry center (mutation-testing round 6)', async () => {
    // Every other round-trip test in this file uses BOTH xAxisOrdinate: 0
    // (no rotation) AND an omitted/default coordinateInfo (geometry center
    // ifcX = ifcY = 0). Mutation testing found that combination makes the
    // rotation cross-term (ordinate * ifcX/ifcY) in computeProjectedCenter
    // and reprojectFromLatLon's inverse vanish for EITHER reason alone, so a
    // sign flip in either function's rotation term survives undetected. This
    // fixture uses a non-trivial rotation AND a non-zero model-center offset
    // so the cross-term is load-bearing in both directions.
    const crs: ProjectedCRS = { id: 1, name: 'EPSG:28992', mapUnit: 'METRE', mapUnitScale: 1 };
    const conversion: MapConversion = {
      id: 2,
      sourceCRS: 10,
      targetCRS: 1,
      eastings: 121687.331,
      northings: 487326.994,
      orthogonalHeight: 0,
      xAxisAbscissa: 0.6,
      xAxisOrdinate: 0.8,
      scale: 1,
    };
    const coordinateInfo = makeCoordinateInfo();
    const { ifcX, ifcY } = computeModelCenterInIfcMeters(coordinateInfo);
    assert.notStrictEqual(conversion.xAxisOrdinate, 0, 'fixture must use a non-zero rotation ordinate');
    assert.notStrictEqual(ifcX, 0, 'fixture must use a non-zero geometry-center ifcX');
    assert.notStrictEqual(ifcY, 0, 'fixture must use a non-zero geometry-center ifcY');

    const latLon = await reprojectToLatLon(conversion, crs, coordinateInfo);
    assert.ok(latLon);
    const roundTrip = await reprojectFromLatLon(latLon!, crs, conversion, coordinateInfo);
    assert.ok(roundTrip);
    assert.ok(
      Math.abs(roundTrip!.easting - conversion.eastings) < 0.01,
      `easting round-trip: ${roundTrip!.easting} vs ${conversion.eastings}`,
    );
    assert.ok(
      Math.abs(roundTrip!.northing - conversion.northings) < 0.01,
      `northing round-trip: ${roundTrip!.northing} vs ${conversion.northings}`,
    );
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

  it('resolves legacy IfcSite (geographic EPSG:4326) georeferencing — eastings/northings are lon/lat', async () => {
    // The legacy-IfcSite path (extractLegacySiteGeoreference) synthesises a geographic
    // CRS with eastings = longitude and northings = latitude. reprojectToLatLon must
    // return those degrees directly (no projected-metre maths), so the KMZ / Google
    // Earth export works for models georeferenced only by IfcSite.RefLatitude /
    // RefLongitude, not just IfcMapConversion + a projected CRS (#1427).
    const crs: ProjectedCRS = {
      id: 1,
      name: 'EPSG:4326',
      mapProjection: 'Geographic',
      geodeticDatum: 'WGS84',
      mapUnit: 'DEGREE',
    };
    const conversion: MapConversion = {
      id: 2,
      sourceCRS: 0,
      targetCRS: 1,
      eastings: 5.38, // longitude
      northings: 52.15, // latitude
      orthogonalHeight: 12,
      scale: 1,
    };
    const latLon = await reprojectToLatLon(conversion, crs);
    assert.ok(latLon, 'legacy IfcSite geolocation should resolve');
    assert.ok(Math.abs(latLon!.lat - 52.15) < 1e-9, `lat = ${latLon!.lat} (expected 52.15)`);
    assert.ok(Math.abs(latLon!.lon - 5.38) < 1e-9, `lon = ${latLon!.lon} (expected 5.38)`);
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

  it('places each footprint corner at the position an independent rotation+shift+RTC calculation predicts (mutation-testing round 6)', async () => {
    // The "preserves corner count" test above only checks length===5 and
    // ring[0]===ring[4] (closure) — mutation testing found it does NOT pin
    // the actual corner positions: dropping the RTC offset, dropping the
    // origin shift, flipping the rotation sign, negating the Y-up->Z-up
    // ifcY flip, or reordering the four corners all left it green. This
    // test recomputes each corner independently (same documented formula,
    // written separately from computeFootprintGeoJSON's implementation) and
    // asserts the real function's output matches within a tight tolerance.
    const crs: ProjectedCRS = { id: 1, name: 'EPSG:32632', mapUnit: 'METRE', mapUnitScale: 1 };
    const conversion: MapConversion = {
      id: 2,
      sourceCRS: 1,
      targetCRS: 1,
      eastings: 500_000,
      northings: 5_000_000,
      orthogonalHeight: 0,
      // Non-identity rotation (unit vector, NOT the (1, 0) no-rotation case)
      // so a sign flip on either axis actually moves the projected point.
      xAxisAbscissa: 0.6,
      xAxisOrdinate: 0.8,
      scale: 1,
    };
    const coordinateInfo: CoordinateInfo = {
      // Non-zero shift and RTC so dropping either term is detectable.
      // shiftedBounds = originalBounds - originShift (createCoordinateInfo's
      // invariant): identical bound sets here would have made this test
      // unable to tell computeFootprintGeoJSON reading `shiftedBounds` apart
      // from an accidental `originalBounds` read (see the module doc above).
      originShift: { x: 100, y: 5, z: -50 },
      originalBounds: { min: { x: -10, y: -1, z: -20 }, max: { x: 10, y: 11, z: 20 } },
      shiftedBounds: { min: { x: -110, y: -6, z: 30 }, max: { x: -90, y: 6, z: 70 } },
      hasLargeCoordinates: false,
      wasmRtcOffset: { x: 7, y: 3, z: 11 },
    };
    // Fixture sanity: these are the exact properties whose absence made the
    // count/closure-only test above vacuous. If any of these decay back to
    // the identity/zero case, this test stops discriminating the mutations
    // it was written to catch.
    assert.notStrictEqual(conversion.xAxisOrdinate, 0, 'fixture must use a non-zero rotation ordinate');
    assert.notStrictEqual(coordinateInfo.originShift.x, 0, 'fixture must use a non-zero origin shift');
    assert.notStrictEqual(coordinateInfo.wasmRtcOffset!.x, 0, 'fixture must use a non-zero RTC offset');

    const footprint = await computeFootprintGeoJSON(conversion, crs, coordinateInfo, 1);
    assert.ok(footprint);
    assert.strictEqual(footprint!.length, 5);

    const projDef = await resolveProjection(crs);
    assert.ok(projDef);
    const proj4mod = (await import('proj4')).default;

    const { abscissa, ordinate } = { abscissa: conversion.xAxisAbscissa!, ordinate: conversion.xAxisOrdinate! };
    const rtc = coordinateInfo.wasmRtcOffset!;
    const shift = coordinateInfo.originShift;
    const rtcYup = { x: rtc.x, z: -rtc.y };
    const bounds = coordinateInfo.shiftedBounds;
    const expectedCorners = [
      { x: bounds.min.x, z: bounds.min.z },
      { x: bounds.max.x, z: bounds.min.z },
      { x: bounds.max.x, z: bounds.max.z },
      { x: bounds.min.x, z: bounds.max.z },
    ].map((c) => {
      const worldX = c.x + shift.x + rtcYup.x;
      const worldZ = c.z + shift.z + rtcYup.z;
      const ifcX = worldX;
      const ifcY = -worldZ;
      const easting = conversion.eastings + (abscissa * ifcX - ordinate * ifcY);
      const northing = conversion.northings + (ordinate * ifcX + abscissa * ifcY);
      const [lon, lat] = proj4mod(projDef!, 'WGS84', [easting, northing]);
      return [lon, lat] as [number, number];
    });

    for (let i = 0; i < 4; i++) {
      close(footprint![i][0], expectedCorners[i][0], 1e-6);
      close(footprint![i][1], expectedCorners[i][1], 1e-6);
    }
  });
});

describe('computeCesiumModelOrigin geoid correction default (#1355)', () => {
  // A Dutch RD-New file with NO VerticalDatum declared — the common case the
  // bug missed. Before the fix the orthometric->ellipsoidal correction was
  // gated on a declared VerticalDatum, so this model sank ~N (~+43 m in NL)
  // below the world terrain. The correction is now the DEFAULT.
  const nlCrs: ProjectedCRS = {
    id: 1,
    name: 'EPSG:28992',
    mapUnit: 'METRE',
    mapUnitScale: 1,
    // verticalDatum intentionally omitted.
  };
  const nlConversion: MapConversion = {
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

  it('adds the geoid undulation N by default even without a VerticalDatum', async () => {
    const origin = await computeCesiumModelOrigin(nlConversion, nlCrs);
    assert.ok(origin, 'should resolve EPSG:28992 offline');
    // Lands in the Netherlands (~52 N, ~5 E) where EGM96 N is ~+43 m.
    assert.ok(origin!.latitude > 51 && origin!.latitude < 54, `lat = ${origin!.latitude}`);
    assert.ok(
      origin!.geoidUndulation > 40 && origin!.geoidUndulation < 48,
      `geoidUndulation = ${origin!.geoidUndulation} (expected ~+43 m for NL)`,
    );
    // Ellipsoidal height fed to Cesium = orthometric authored height + N.
    assert.strictEqual(origin!.ifcOriginHeight, 0);
    assert.ok(
      Math.abs(origin!.height - (origin!.ifcOriginHeight + origin!.geoidUndulation)) < 1e-9,
      `height ${origin!.height} should equal ifcOriginHeight + N`,
    );
  });

  it('skips the correction when heights are flagged ellipsoidal (opt-out)', async () => {
    const origin = await computeCesiumModelOrigin(
      nlConversion, nlCrs, undefined, 1, undefined, /* heightsAreEllipsoidal */ true,
    );
    assert.ok(origin);
    assert.strictEqual(origin!.geoidUndulation, 0);
    assert.strictEqual(origin!.height, origin!.ifcOriginHeight);
  });
});

describe('reprojectPointToLatLon (#1657 measure geo lat/lon)', () => {
  // building-architecture.ifc constants (EPSG:32760, UTM zone 60S), offsets in
  // millimetres (mapUnitScale 0.001) — mirrors pick-to-geo.test.ts.
  const BUILDING_ARCH_EASTINGS_MM = 729013348.8297004;
  const BUILDING_ARCH_NORTHINGS_MM = 9063992684.697363;
  const mmCrs: ProjectedCRS = {
    id: 18,
    name: 'EPSG:32760',
    mapUnit: 'MILLIMETRE',
    mapUnitScale: 0.001,
  };
  const metreCrs: ProjectedCRS = {
    id: 18,
    name: 'EPSG:32760',
    mapUnit: 'METRE',
    mapUnitScale: 1,
  };

  it('reprojects a picked E/N (mm CRS) to WGS84 in the expected UTM-60S region', async () => {
    const latLon = await reprojectPointToLatLon(
      BUILDING_ARCH_EASTINGS_MM,
      BUILDING_ARCH_NORTHINGS_MM,
      mmCrs,
      0.001,
    );
    assert.ok(latLon, 'should resolve for a bundled UTM code');
    // Zone 60S, central meridian 177E: this E/N lands just east of the antimeridian
    // in the southern hemisphere.
    assert.ok(latLon!.lat < 0 && latLon!.lat > -20, `lat = ${latLon!.lat} (expected southern)`);
    assert.ok(latLon!.lon > 170 && latLon!.lon <= 180, `lon = ${latLon!.lon} (expected ~zone 60)`);
  });

  it('honours the map-unit scale: mm offsets and equivalent metre offsets agree', async () => {
    const fromMm = await reprojectPointToLatLon(
      BUILDING_ARCH_EASTINGS_MM,
      BUILDING_ARCH_NORTHINGS_MM,
      mmCrs,
      0.001,
    );
    const fromMetres = await reprojectPointToLatLon(
      BUILDING_ARCH_EASTINGS_MM * 0.001,
      BUILDING_ARCH_NORTHINGS_MM * 0.001,
      metreCrs,
      1,
    );
    assert.ok(fromMm && fromMetres);
    assert.ok(Math.abs(fromMm!.lat - fromMetres!.lat) < 1e-9, 'lat must match across unit scaling');
    assert.ok(Math.abs(fromMm!.lon - fromMetres!.lon) < 1e-9, 'lon must match across unit scaling');
  });

  it('returns null (never throws) for an unresolvable CRS', async () => {
    const unknown: ProjectedCRS = { id: 1, name: 'TOTALLY_UNKNOWN_CRS' };
    const latLon = await reprojectPointToLatLon(500000, 5000000, unknown, 1);
    assert.strictEqual(latLon, null);
  });
});

describe('reprojectionInputKey (effect dependency correctness)', () => {
  const crs: ProjectedCRS = {
    id: 1,
    name: 'EPSG:32760',
    mapUnit: 'MILLIMETRE',
    mapUnitScale: 0.001,
    mapZone: '60S',
    description: 'WGS 84 / UTM zone 60S',
    mapProjection: 'UTM',
  };

  it('quantises sub-millimetre E/N jitter to the same key', () => {
    // mm CRS: eastings are millimetres, so nudges within the same millimetre
    // bucket round identically (both 729013348.x -> 729013348).
    const a = reprojectionInputKey(729013348.1, 9063992684.1, crs, 0.001);
    const b = reprojectionInputKey(729013348.4, 9063992684.4, crs, 0.001);
    assert.strictEqual(a, b, 'sub-mm changes must not change the key');
  });

  it('changes the key when E/N moves by more than a millimetre', () => {
    const a = reprojectionInputKey(729013348.1, 9063992684.1, crs, 0.001);
    const b = reprojectionInputKey(729013350.1, 9063992684.1, crs, 0.001);
    assert.notStrictEqual(a, b, 'a >1 mm move must change the key');
  });

  it('folds every reprojection input (codex #1671 P2): a projection-metadata edit changes the key even when name + E/N are unchanged', () => {
    const base = reprojectionInputKey(729013348.1, 9063992684.1, crs, 0.001);
    // Each field resolveProjection / reprojectPointToLatLon reads must move the key.
    const edits: Array<Partial<ProjectedCRS>> = [
      { mapZone: '59S' },
      { description: 'something else' },
      { mapProjection: 'TM' },
      { mapUnitScale: 1 },
    ];
    for (const edit of edits) {
      const mutated = reprojectionInputKey(729013348.1, 9063992684.1, { ...crs, ...edit }, 0.001);
      assert.notStrictEqual(mutated, base, `editing ${Object.keys(edit)[0]} must change the key`);
    }
    // lengthUnitScale is a non-CRS input the reprojection reads too.
    const diffLength = reprojectionInputKey(729013348.1, 9063992684.1, crs, 0.01);
    assert.notStrictEqual(diffLength, base, 'a lengthUnitScale change must change the key');
  });
});

describe('map-absolute geometry detection (#2526 Vectorworks EPSG:25833)', () => {
  // Shape of the issue #2526 file: Vectorworks placed the IfcSite at the
  // ABSOLUTE map coordinates (311988180.54 mm E, 5996148564.99 mm N, 14 m up)
  // while ALSO writing an IfcMapConversion with the same offsets (in metres)
  // and a 90-degree XAxis rotation. The wasm RTC pre-pass rebased the huge
  // placement, so the browser-frame CoordinateInfo carries the absolute
  // position in wasmRtcOffset (IFC Z-up metres).
  const vwCoordinateInfo: CoordinateInfo = {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: {
      min: { x: -29.07, y: -0.2, z: -13.68 },
      max: { x: 5.98, y: 3.76, z: 31.68 },
    },
    shiftedBounds: {
      min: { x: -29.07, y: -0.2, z: -13.68 },
      max: { x: 5.98, y: 3.76, z: 31.68 },
    },
    hasLargeCoordinates: false,
    wasmRtcOffset: { x: 312018.898, y: 5996169.654, z: 14 },
  };
  const vwConversion: MapConversion = {
    id: 73,
    sourceCRS: 41,
    targetCRS: 71,
    eastings: 311988.181,
    northings: 5996148.565,
    orthogonalHeight: 0,
    xAxisAbscissa: 0,
    xAxisOrdinate: 1,
  };
  const vwCrs: ProjectedCRS = {
    id: 71,
    name: 'EPSG:25833 ETRS89 / UTM zone 33N',
    geodeticDatum: 'ETRS89',
    mapUnit: 'METRE',
    mapUnitScale: 1,
  };

  // Absolute model centre in IFC Z-up metres (bounds centre + rtc offset):
  //   ifcX = -11.545 + 312018.898 = 312007.353
  //   ifcY = -(9.0 - 5996169.654) = 5996160.654
  const CENTER_E = 312007.353;
  const CENTER_N = 5996160.654;

  it('rebases the conversion to identity when geometry already sits at the declared map anchor', () => {
    const effective = effectiveMapConversionForGeometry(vwConversion, 1, vwCoordinateInfo);
    assert.strictEqual(effective.eastings, 0);
    assert.strictEqual(effective.northings, 0);
    assert.strictEqual(effective.xAxisAbscissa, 1);
    assert.strictEqual(effective.xAxisOrdinate, 0);
    // Authored height and identity fields survive untouched.
    assert.strictEqual(effective.orthogonalHeight, vwConversion.orthogonalHeight);
    assert.strictEqual(effective.id, vwConversion.id);
  });

  it('keeps the conversion for a compliant file whose geometry sits near the local origin', () => {
    const compliant: CoordinateInfo = {
      ...vwCoordinateInfo,
      wasmRtcOffset: undefined,
    };
    const effective = effectiveMapConversionForGeometry(vwConversion, 1, compliant);
    assert.strictEqual(effective, vwConversion);
  });

  it('keeps the conversion when the declared anchor is below projected-CRS magnitude', () => {
    // Small anchor + nearby geometry centre: NOT the Vectorworks signature —
    // rebasing here would silently drop a legitimate small offset + rotation.
    const smallConversion: MapConversion = {
      ...vwConversion, eastings: 2000, northings: 3000,
    };
    const nearAnchor: CoordinateInfo = {
      ...vwCoordinateInfo,
      wasmRtcOffset: { x: 2100, y: -3050, z: 0 },
    };
    const effective = effectiveMapConversionForGeometry(smallConversion, 1, nearAnchor);
    assert.strictEqual(effective, smallConversion);
  });

  it('keeps the conversion without coordinateInfo', () => {
    assert.strictEqual(effectiveMapConversionForGeometry(vwConversion, 1, undefined), vwConversion);
  });

  it('honours the map unit scale when comparing the anchor to the geometry centre', () => {
    // Same file authored with MapUnit = MILLIMETRE: offsets 1000x larger,
    // mapUnitScale 0.001 — the metre-space anchor is identical, so the
    // detection must still fire.
    const mmConversion: MapConversion = {
      ...vwConversion,
      eastings: 311988181,
      northings: 5996148565,
    };
    const effective = effectiveMapConversionForGeometry(mmConversion, 0.001, vwCoordinateInfo);
    assert.strictEqual(effective.eastings, 0);
    assert.strictEqual(effective.northings, 0);
  });

  it('reprojectToLatLon lands the pin at the model, not double-transformed into the Atlantic', async () => {
    const latLon = await reprojectToLatLon(vwConversion, vwCrs, vwCoordinateInfo, 0.001);
    assert.ok(latLon, 'expected a lat/lon');
    // EPSG:25833 (312007, 5996161) is Rostock, Germany: 54.079N 12.126E.
    close(latLon.lat, 54.0791, 5e-3);
    close(latLon.lon, 12.1261, 5e-3);
  });

  it('computeCesiumModelOrigin places the georeferenced context at the absolute centre and keeps the authored height', async () => {
    const origin = await computeCesiumModelOrigin(vwConversion, vwCrs, vwCoordinateInfo, 0.001);
    assert.ok(origin, 'expected an origin');
    close(origin.easting, CENTER_E, 0.01);
    close(origin.northing, CENTER_N, 0.01);
    // OrthogonalHeight 0 + absolute IFC Z centre (1.78 + 14).
    close(origin.ifcOriginHeight, 15.78, 0.01);
  });

  it('the map-pick Apply loop stays self-consistent: saving reprojectFromLatLon output and recomputing lands the pin where picked', async () => {
    // LocationMap's Apply saves reprojectFromLatLon's E/N into the mutated
    // MapConversion while the authored rotation stays. The invariant that
    // must hold for a map-absolute file is NOT the shape of the intermediate
    // values but that the recomputed pin equals the picked location — the
    // saved anchor moves the mutated conversion out of the map-absolute
    // detection window, so the forward math applies the authored rotation to
    // exactly the values the inverse accounted for.
    const picked = { lat: 54.081, lon: 12.13 };
    const saved = await reprojectFromLatLon(picked, vwCrs, vwConversion, vwCoordinateInfo, 0.001);
    assert.ok(saved, 'expected projected coordinates');
    const mutated: MapConversion = {
      ...vwConversion,
      eastings: saved.easting,
      northings: saved.northing,
    };
    const recomputed = await reprojectToLatLon(mutated, vwCrs, vwCoordinateInfo, 0.001);
    assert.ok(recomputed, 'expected a recomputed pin');
    close(recomputed.lat, picked.lat, 1e-6);
    close(recomputed.lon, picked.lon, 1e-6);
  });

  it('computeFootprintGeoJSON draws the footprint around the pin instead of rotating it through the double transform', async () => {
    const ring = await computeFootprintGeoJSON(vwConversion, vwCrs, vwCoordinateInfo, 0.001);
    assert.ok(ring, 'expected a footprint');
    const pin = await reprojectToLatLon(vwConversion, vwCrs, vwCoordinateInfo, 0.001);
    assert.ok(pin);
    for (const [lon, lat] of ring) {
      // Every corner within ~100 m of the pin (model is ~45 m across).
      close(lat, pin.lat, 2e-3);
      close(lon, pin.lon, 2e-3);
    }
  });
});
