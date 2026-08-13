/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import type { CoordinateInfo } from '@ifc-lite/geometry';

import type { MapConversion } from '@ifc-lite/parser';

import { computeKmzAltitude, resolveKmzHeading } from './kmz-export.js';

describe('computeKmzAltitude', () => {
  it('scales OrthogonalHeight from map units to metres (mm-CRS file is not 1000x off)', () => {
    // OrthogonalHeight authored as 500000 mm with a mm map unit = 500 m MSL.
    assert.strictEqual(computeKmzAltitude(500_000, { mapUnitScale: 0.001 }, 1, undefined), 500);
  });

  it('folds the wasm RTC Z offset back in (RTC-rebased models are not placed rtc.z too low)', () => {
    // The COLLADA exporter bakes post-RTC mesh Z; the KML altitude must restore it.
    const coordinateInfo = { wasmRtcOffset: { x: 0, y: 0, z: 417 } } as CoordinateInfo;
    assert.strictEqual(computeKmzAltitude(100, undefined, 1, coordinateInfo), 517);
  });

  it('defaults to 0 with no OrthogonalHeight, CRS, or coordinate info', () => {
    assert.strictEqual(computeKmzAltitude(undefined, undefined, 1, undefined), 0);
  });

  it('matches the pre-fix behaviour for the common metre-CRS, non-RTC model', () => {
    assert.strictEqual(computeKmzAltitude(455.5, { mapUnitScale: 1 }, 1, {} as CoordinateInfo), 455.5);
  });
});

describe('resolveKmzHeading', () => {
  // Deep review of #2534 (2026-08-10, louistrue) — blocking issue on
  // kmz-export.ts:97-108: `buildKmzForModel` got the PIN position through
  // the map-absolute guard (#2526, via `reprojectToLatLon`) but passed the
  // AUTHORED xAxisAbscissa/xAxisOrdinate straight through as the KML
  // heading. For the #2526 file shape (90-degree authored rotation, already
  // map-axis-aligned geometry), that rotated an otherwise-correctly-placed
  // .dae by 90 degrees in Google Earth. `resolveKmzHeading` must return the
  // SAME identity axis the position uses.
  function makeConversion(overrides: Partial<MapConversion> = {}): MapConversion {
    return {
      id: 1, sourceCRS: 1, targetCRS: 2,
      eastings: 311_988.181, northings: 5_996_148.565, orthogonalHeight: 0,
      xAxisAbscissa: 0, xAxisOrdinate: 1, scale: 1,
      ...overrides,
    };
  }

  it('returns the identity axis (not the authored 90-degree rotation) for a map-absolute file', () => {
    const conversion = makeConversion();
    // Geometry centre ~37m from the declared anchor — inside the 10km
    // detection window (#2526 signature).
    const coordinateInfo = {
      originShift: { x: 0, y: 0, z: 0 },
      wasmRtcOffset: { x: 312_018.898, y: 5_996_169.654, z: 14 },
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
      hasLargeCoordinates: true,
    } as CoordinateInfo;
    const heading = resolveKmzHeading(conversion, { mapUnitScale: 1 }, 1, coordinateInfo);
    assert.strictEqual(heading.xAxisAbscissa, 1, 'heading must be the identity axis, not the authored rotation');
    assert.strictEqual(heading.xAxisOrdinate, 0, 'heading must be the identity axis, not the authored rotation');
  });

  it('keeps the authored axis for a compliant (non map-absolute) file', () => {
    const conversion = makeConversion({ eastings: 5000, northings: 3000, xAxisAbscissa: 0.6, xAxisOrdinate: 0.8 });
    const coordinateInfo = {
      originShift: { x: 0, y: 0, z: 0 },
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 3, z: 10 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 3, z: 10 } },
      hasLargeCoordinates: false,
    } as CoordinateInfo;
    const heading = resolveKmzHeading(conversion, { mapUnitScale: 1 }, 1, coordinateInfo);
    assert.strictEqual(heading.xAxisAbscissa, 0.6);
    assert.strictEqual(heading.xAxisOrdinate, 0.8);
  });
});
