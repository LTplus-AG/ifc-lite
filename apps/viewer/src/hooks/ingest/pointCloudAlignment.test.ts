/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  applyMapConversion,
  computePointCloudAlignment,
  invertMapConversion,
  type MapConversionParams,
} from './pointCloudAlignment.js';
import type { ModelGeoref } from './federationAlign.js';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';

function assertClose(actual: number, expected: number, eps = 1e-6, msg?: string): void {
  assert.ok(
    Math.abs(actual - expected) < eps,
    `${msg ?? ''} expected ${expected}, got ${actual} (Δ=${Math.abs(actual - expected)})`,
  );
}

describe('invertMapConversion / applyMapConversion (issue #1804)', () => {
  it('round-trips map -> local -> map back to identity (no rotation)', () => {
    const params: MapConversionParams = {
      eastings: 500_000,
      northings: 5_000_000,
      orthogonalHeight: 100,
    };
    const local = invertMapConversion(params, 500_010, 5_000_020, 105);
    assert.ok(local);
    assertClose(local.x, 10);
    assertClose(local.y, 20);
    assertClose(local.z, 5);

    const back = applyMapConversion(params, local.x, local.y, local.z);
    assert.ok(back);
    assertClose(back.e, 500_010);
    assertClose(back.n, 5_000_020);
    assertClose(back.h, 105);
  });

  it('a worked example with a 90-degree rotation', () => {
    const params: MapConversionParams = {
      eastings: 0,
      northings: 0,
      orthogonalHeight: 0,
      xAxisAbscissa: 0, // cos(90deg)
      xAxisOrdinate: 1, // sin(90deg)
    };
    // Forward: local (10,0,0) -> map (0,10,0) under a 90deg CCW rotation.
    const map = applyMapConversion(params, 10, 0, 0);
    assert.ok(map);
    assertClose(map.e, 0);
    assertClose(map.n, 10);

    // Inverse must recover the original local point.
    const local = invertMapConversion(params, map.e, map.n, map.h);
    assert.ok(local);
    assertClose(local.x, 10);
    assertClose(local.y, 0);
  });

  it('round-trips with an arbitrary rotation + scale != 1', () => {
    const angle = 37 * (Math.PI / 180);
    const params: MapConversionParams = {
      eastings: 123_456.789,
      northings: 9_876_543.21,
      orthogonalHeight: 42.5,
      xAxisAbscissa: Math.cos(angle),
      xAxisOrdinate: Math.sin(angle),
      scale: 0.9996, // e.g. a UTM central-meridian scale factor
    };
    for (const [x, y, z] of [[0, 0, 0], [15, -8, 3], [-1000, 2500, -12]] as const) {
      const map = applyMapConversion(params, x, y, z);
      assert.ok(map);
      const local = invertMapConversion(params, map.e, map.n, map.h);
      assert.ok(local);
      assertClose(local.x, x, 1e-6, 'x');
      assertClose(local.y, y, 1e-6, 'y');
      assertClose(local.z, z, 1e-6, 'z');
    }
  });

  it('normalizes a non-unit XAxisAbscissa/XAxisOrdinate direction vector', () => {
    // (2,0) encodes the same "no rotation" direction as (1,0) once
    // normalized — a file that authors non-unit axis components must not
    // silently double the effective scale.
    const unit: MapConversionParams = { eastings: 0, northings: 0, orthogonalHeight: 0 };
    const nonUnit: MapConversionParams = {
      eastings: 0,
      northings: 0,
      orthogonalHeight: 0,
      xAxisAbscissa: 2,
      xAxisOrdinate: 0,
    };
    const a = applyMapConversion(unit, 10, 5, 0);
    const b = applyMapConversion(nonUnit, 10, 5, 0);
    assert.ok(a && b);
    assertClose(a.e, b.e);
    assertClose(a.n, b.n);
  });

  it('guards the degenerate xAxisAbscissa=xAxisOrdinate=0 direction', () => {
    const params: MapConversionParams = {
      eastings: 0,
      northings: 0,
      orthogonalHeight: 0,
      xAxisAbscissa: 0,
      xAxisOrdinate: 0,
    };
    assert.strictEqual(invertMapConversion(params, 1, 1, 1), null);
    assert.strictEqual(applyMapConversion(params, 1, 1, 1), null);
  });

  it('guards a ~zero Scale on the inverse (would otherwise divide by zero)', () => {
    const params: MapConversionParams = {
      eastings: 0,
      northings: 0,
      orthogonalHeight: 0,
      scale: 0,
    };
    assert.strictEqual(invertMapConversion(params, 1, 1, 1), null);
  });
});

function makeGeoref(overrides: {
  mapConversion?: Partial<MapConversion>;
  projectedCRS?: Partial<ProjectedCRS>;
  lengthUnitScale?: number;
  coordinateInfo?: ModelGeoref['coordinateInfo'];
} = {}): ModelGeoref {
  const mapConversion: MapConversion = {
    id: 1,
    sourceCRS: 0,
    targetCRS: 0,
    eastings: 500_000,
    northings: 5_000_000,
    orthogonalHeight: 100,
    xAxisAbscissa: 1,
    xAxisOrdinate: 0,
    scale: 1,
    ...overrides.mapConversion,
  };
  const projectedCRS: ProjectedCRS = {
    id: 2,
    name: 'EPSG:32632',
    mapUnitScale: 1,
    ...overrides.projectedCRS,
  };
  return {
    mapConversion,
    projectedCRS,
    lengthUnitScale: overrides.lengthUnitScale ?? 1,
    coordinateInfo: overrides.coordinateInfo,
  };
}

describe('computePointCloudAlignment (issue #1804)', () => {
  it('maps a scan point at the map-conversion origin to the negated viewer shift', () => {
    const georef = makeGeoref({
      coordinateInfo: {
        originShift: { x: 3, y: 0, z: -4 },
        originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
        shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
        hasLargeCoordinates: false,
        wasmRtcOffset: { x: 500_000, y: 5_000_000, z: 100 },
      },
    });
    const t = computePointCloudAlignment(georef);
    assert.ok(t);

    // decodeOriginOffset subtracts the map-conversion translation, so a
    // point AT (eastings, northings, orthogonalHeight) decodes to (0,0,0)
    // local, then swaps Z-up->Y-up to (px,py,pz) = (0,0,-0) = (0,0,0).
    assert.deepStrictEqual(
      [...t.decodeOriginOffset].map((v) => Math.round(v)),
      [500_000, 5_000_000, 100],
    );

    // Applying the aligned matrix to the origin (px=py=pz=0) yields just
    // the translation column: -off, where off = totalYupOffset(coordinateInfo)
    // combines originShift + wasmRtcOffset (Z-up->Y-up).
    // rtcYup = { x: 500000, y: 100, z: -5000000 }; off = shift + rtcYup
    //        = { x: 3+500000, y: 0+100, z: -4-5000000 }
    const m = t.alignedMatrix;
    assertClose(m[12], -(3 + 500_000), 1e-3);
    assertClose(m[13], -(0 + 100), 1e-3);
    assertClose(m[14], -(-4 - 5_000_000), 1e-3);
  });

  it('rotation in the aligned matrix matches a directly-computed inverse-map point', () => {
    const angle = 20 * (Math.PI / 180);
    const georef = makeGeoref({
      mapConversion: {
        xAxisAbscissa: Math.cos(angle),
        xAxisOrdinate: Math.sin(angle),
      },
    });
    const t = computePointCloudAlignment(georef);
    assert.ok(t);

    // Pick a raw LAS point away from the map-conversion origin, subtract
    // decodeOriginOffset (as the decoder would, in f64), swap Z-up->Y-up
    // (px=dE, py=dH, pz=-dN), then apply the aligned matrix — the result
    // must match `invertMapConversion` composed with the Y-up axis swap
    // and zero viewer shift (no coordinateInfo => off=0,0,0).
    const raw: [number, number, number] = [500_030, 4_999_980, 105];
    const [oe, on, oh] = t.decodeOriginOffset;
    const dE = raw[0] - oe;
    const dN = raw[1] - on;
    const dH = raw[2] - oh;
    const px = dE, py = dH, pz = -dN;

    const m = t.alignedMatrix;
    const outX = m[0] * px + m[4] * py + m[8] * pz + m[12];
    const outY = m[1] * px + m[5] * py + m[9] * pz + m[13];
    const outZ = m[2] * px + m[6] * py + m[10] * pz + m[14];

    const expected = invertMapConversion(
      {
        eastings: 500_000, northings: 5_000_000, orthogonalHeight: 100,
        xAxisAbscissa: Math.cos(angle), xAxisOrdinate: Math.sin(angle),
      },
      raw[0], raw[1], raw[2],
    );
    assert.ok(expected);
    assertClose(outX, expected.x, 1e-3);
    assertClose(outY, expected.z, 1e-3);
    assertClose(outZ, -expected.y, 1e-3);
  });

  it('the unaligned matrix undoes only the decode-time offset (raw placement)', () => {
    const georef = makeGeoref();
    const t = computePointCloudAlignment(georef);
    assert.ok(t);
    const m = t.unalignedMatrix;
    // Pure translation, no rotation/scale.
    assert.strictEqual(m[0], 1); assert.strictEqual(m[5], 1); assert.strictEqual(m[10], 1);
    assertClose(m[12], 500_000);
    assertClose(m[13], 100);
    assertClose(m[14], -5_000_000);
  });

  it('returns null for a degenerate axis direction', () => {
    const georef = makeGeoref({ mapConversion: { xAxisAbscissa: 0, xAxisOrdinate: 0 } });
    assert.strictEqual(computePointCloudAlignment(georef), null);
  });

  it('returns null when the effective scale is ~zero', () => {
    const georef = makeGeoref({ mapConversion: { scale: 0 } });
    assert.strictEqual(computePointCloudAlignment(georef), null);
  });
});
