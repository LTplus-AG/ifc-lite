/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  hasUsableMapGeoref,
  ifcOriginViewerPoint,
  mapCoordinateDecimals,
  viewerPointToProjected,
  type UsableEffectiveGeoref,
} from './pick-to-geo.js';

const ORIGIN0 = { x: 0, y: 0, z: 0 };

function approx(actual: number, expected: number, eps = 1e-6): void {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `expected ${actual} to be within ${eps} of ${expected}`,
  );
}

/**
 * Effective georef for apps/viewer/public/samples/building-architecture.ifc:
 *   IFCSIUNIT LENGTHUNIT MILLI METRE            -> lengthUnitScale 0.001
 *   IFCPROJECTEDCRS 'EPSG:32760', MapUnit MILLI -> mapUnitScale 0.001
 *   IFCMAPCONVERSION eastings 729013348.8297004,
 *     northings 9063992684.697363, orthogonalHeight 1300.0000000000011,
 *     xAxisAbscissa 0.4999999999999999 (cos 60deg),
 *     xAxisOrdinate 0.8660254037844387 (sin 60deg), scale 1.0
 */
const BUILDING_ARCH: UsableEffectiveGeoref = {
  hasGeoreference: true,
  source: 'mapConversion',
  lengthUnitScale: 0.001,
  projectedCRS: {
    id: 18,
    name: 'EPSG:32760',
    mapUnit: 'MILLIMETRE',
    mapUnitScale: 0.001,
  },
  mapConversion: {
    id: 19,
    sourceCRS: 11,
    targetCRS: 18,
    eastings: 729013348.8297004,
    northings: 9063992684.697363,
    orthogonalHeight: 1300.0000000000011,
    xAxisAbscissa: 0.4999999999999999,
    xAxisOrdinate: 0.8660254037844387,
    scale: 1,
  },
} as UsableEffectiveGeoref;

const ABSCISSA = 0.4999999999999999;
const ORDINATE = 0.8660254037844387;

describe('viewerPointToProjected', () => {
  it('maps the anchor IFC origin to the authored MapConversion offsets', () => {
    const p = viewerPointToProjected(ORIGIN0, BUILDING_ARCH, ORIGIN0);
    // mm map units: origin lands exactly on the authored eastings/northings/height.
    approx(p.eastings, 729013348.8297004, 1e-3);
    approx(p.northings, 9063992684.697363, 1e-3);
    approx(p.height, 1300.0000000000011, 1e-6);
    assert.strictEqual(p.crsName, 'EPSG:32760');
  });

  it('rotates a +1m viewer-X offset by the 60deg grid rotation and scales to mm', () => {
    // +1m along viewer X. E delta = cos60 * 1m = 0.5m -> 500 mm map units;
    // N delta = sin60 * 1m = 0.866m -> 866 mm. Magnitude stays 1000 mm (1m).
    const p = viewerPointToProjected({ x: 1, y: 0, z: 0 }, BUILDING_ARCH, ORIGIN0);
    approx(p.eastings - 729013348.8297004, ABSCISSA * 1000, 1e-6);
    approx(p.northings - 9063992684.697363, ORDINATE * 1000, 1e-6);
    const de = p.eastings - 729013348.8297004;
    const dn = p.northings - 9063992684.697363;
    approx(Math.hypot(de, dn), 1000, 1e-6);
  });

  it('maps +1m viewer-Z per the local_to_map sign convention (rust/core/src/georef.rs)', () => {
    // Viewer Z-up mapping: ifcX = viewerX, ifcY = -viewerZ. With
    // local_to_map east = absc*ifcX - ordi*ifcY, north = ordi*ifcX + absc*ifcY,
    // a +1m viewer Z gives ifcY = -1 -> E += ordi*1000, N += -absc*1000.
    const p = viewerPointToProjected({ x: 0, y: 0, z: 1 }, BUILDING_ARCH, ORIGIN0);
    approx(p.eastings - 729013348.8297004, ORDINATE * 1000, 1e-6);
    approx(p.northings - 9063992684.697363, -ABSCISSA * 1000, 1e-6);
  });

  it('converts orthogonal height in mm map units (1m up = +1000)', () => {
    const p = viewerPointToProjected({ x: 0, y: 1, z: 0 }, BUILDING_ARCH, ORIGIN0);
    approx(p.height - 1300.0000000000011, 1000, 1e-6);
  });

  it('honours the origin offset (federated anchor frame)', () => {
    // A picked point equal to the origin viewer position resolves to the pivot.
    const originViewer = { x: 12, y: 3, z: -7 };
    const p = viewerPointToProjected(originViewer, BUILDING_ARCH, originViewer);
    approx(p.eastings, 729013348.8297004, 1e-3);
    approx(p.northings, 9063992684.697363, 1e-3);
    approx(p.height, 1300.0000000000011, 1e-6);
  });

  it('does not inflate a metre CRS with no rotation (unit trap guard)', () => {
    // metre project + metre map units, identity rotation: +1m viewer X is
    // exactly +1 easting map unit, NOT 1000 (the transformToWorld trap).
    const metreGeoref: UsableEffectiveGeoref = {
      hasGeoreference: true,
      source: 'mapConversion',
      lengthUnitScale: 1,
      projectedCRS: { id: 1, name: 'EPSG:2056', mapUnit: 'METRE', mapUnitScale: 1 },
      mapConversion: {
        id: 2,
        sourceCRS: 0,
        targetCRS: 1,
        eastings: 2600000,
        northings: 1200000,
        orthogonalHeight: 400,
        xAxisAbscissa: 1,
        xAxisOrdinate: 0,
        scale: 1,
      },
    } as UsableEffectiveGeoref;
    const p = viewerPointToProjected({ x: 1, y: 2, z: -3 }, metreGeoref, ORIGIN0);
    approx(p.eastings, 2600001, 1e-6);
    approx(p.northings, 1200003, 1e-6); // ifcY = -viewerZ = 3 -> +3 north
    approx(p.height, 402, 1e-6);
  });
});

describe('hasUsableMapGeoref', () => {
  it('accepts a real map conversion + named projected CRS', () => {
    assert.strictEqual(hasUsableMapGeoref(BUILDING_ARCH), true);
  });

  it('rejects null/undefined', () => {
    assert.strictEqual(hasUsableMapGeoref(null), false);
    assert.strictEqual(hasUsableMapGeoref(undefined), false);
  });

  it('rejects a georef missing the map conversion', () => {
    const noConversion = {
      hasGeoreference: true,
      source: 'mapConversion',
      lengthUnitScale: 1,
      projectedCRS: { id: 1, name: 'EPSG:32760', mapUnitScale: 1 },
      mapConversion: undefined,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.strictEqual(hasUsableMapGeoref(noConversion as any), false);
  });

  it('rejects the siteLocation source (legacy EPSG:4326 lat/lon)', () => {
    const siteLocation = {
      ...BUILDING_ARCH,
      source: 'siteLocation',
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.strictEqual(hasUsableMapGeoref(siteLocation as any), false);
  });
});

describe('mapCoordinateDecimals', () => {
  it('uses 0 decimals for a millimetre CRS', () => {
    assert.strictEqual(mapCoordinateDecimals({ mapUnitScale: 0.001 }, 0.001), 0);
  });

  it('uses 3 decimals for a metre CRS', () => {
    assert.strictEqual(mapCoordinateDecimals({ mapUnitScale: 1 }, 1), 3);
    assert.strictEqual(mapCoordinateDecimals(undefined, 1), 3);
  });

  it('clamps to [0, 3]', () => {
    // Coarse (kilometre) map units cap at 3 decimals; sub-mm units floor at 0.
    assert.strictEqual(mapCoordinateDecimals({ mapUnitScale: 1000 }, 1), 3);
    assert.strictEqual(mapCoordinateDecimals({ mapUnitScale: 0.0001 }, 1), 0);
  });
});

describe('ifcOriginViewerPoint', () => {
  it('returns the negated total Y-up offset (origin shift + RTC)', () => {
    const zero = ifcOriginViewerPoint(undefined);
    // Use == against 0 so the harmless -0 from negating 0 still passes.
    assert.ok(zero.x === 0 && zero.y === 0 && zero.z === 0);
    const p = ifcOriginViewerPoint({
      originShift: { x: 10, y: 5, z: -2 },
      // RTC is IFC Z-up; viewer maps {x, z, -y}.
      wasmRtcOffset: { x: 1, y: 2, z: 3 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    // total = shift + {rtc.x, rtc.z, -rtc.y} = {11, 8, -4}; negated:
    assert.deepStrictEqual(p, { x: -11, y: -8, z: 4 });
  });
});
