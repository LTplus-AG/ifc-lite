/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  applyMapConversion,
  computePointCloudAlignment,
  getPointCloudAlignmentMatrix,
  invertMapConversion,
  registerPointCloudAlignment,
  unregisterPointCloudAlignment,
  type MapConversionParams,
} from './pointCloudAlignment.js';
import type { ModelGeoref } from './federationAlign.js';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import {
  decodeAsciiPoints,
  decodePcd,
  decodePly,
  decodeE57Scan,
  type Data3DEntry,
} from '@ifc-lite/pointcloud';

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

  it('guards a ~zero Scale on the FORWARD map too, instead of collapsing the cloud', () => {
    // Without the guard the forward map "succeeds" while stacking every
    // local point onto (Eastings, Northings, OrthogonalHeight).
    const params: MapConversionParams = {
      eastings: 7, northings: 8, orthogonalHeight: 9, scale: 0,
    };
    assert.strictEqual(applyMapConversion(params, 1000, -2000, 30), null);
    assert.strictEqual(applyMapConversion({ ...params, scale: 1e-13 }, 1000, -2000, 30), null);
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

/**
 * Behaviour oracle: full expected chain for one raw scan point, computed
 * independently of the matrix packing. Simulates the decode-time f64
 * subtraction + Z-up→Y-up swap the ingest path performs, applies the
 * aligned matrix, and returns the viewer-space result.
 */
function runAlignmentChain(
  t: NonNullable<ReturnType<typeof computePointCloudAlignment>>,
  raw: readonly [number, number, number],
): { x: number; y: number; z: number } {
  const [oe, on, oh] = t.decodeOriginOffset;
  const px = raw[0] - oe;
  const py = raw[2] - oh;
  const pz = -(raw[1] - on);
  const m = t.alignedMatrix;
  return {
    x: m[0] * px + m[4] * py + m[8] * pz + m[12],
    y: m[1] * px + m[5] * py + m[9] * pz + m[13],
    z: m[2] * px + m[6] * py + m[10] * pz + m[14],
  };
}

describe('computePointCloudAlignment (issue #1804)', () => {
  it('lands a scan point at inverse-map-conversion viewer coordinates, shift folded in', () => {
    // Reference model with a large RTC offset AND an origin shift — the
    // combined viewer shift (totalYupOffset) must be honoured.
    const georef = makeGeoref({
      coordinateInfo: {
        originShift: { x: 3, y: 0, z: -4 },
        // shiftedBounds = originalBounds - originShift (createCoordinateInfo's
        // invariant); computePointCloudAlignment never reads either bounds
        // field (only originShift/wasmRtcOffset), but a fixture no producer
        // could emit is still worth avoiding.
        originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
        shiftedBounds: { min: { x: -3, y: 0, z: 4 }, max: { x: -3, y: 0, z: 4 } },
        hasLargeCoordinates: false,
        wasmRtcOffset: { x: 120, y: -75, z: 6 },
      },
    });
    const t = computePointCloudAlignment(georef);
    assert.ok(t);

    // off = originShift + rtcYup = (3+120, 0+6, -4+75) = (123, 6, 71).
    // Expected viewer position of a raw map point P:
    //   local = invertMapConversion(P); viewer = (local.x, local.z, -local.y) - off
    const raw = [500_030, 4_999_980, 105] as const;
    const local = invertMapConversion(
      { eastings: 500_000, northings: 5_000_000, orthogonalHeight: 100 },
      raw[0], raw[1], raw[2],
    );
    assert.ok(local);
    const out = runAlignmentChain(t, raw);
    assertClose(out.x, local.x - 123, 1e-6, 'x');
    assertClose(out.y, local.z - 6, 1e-6, 'y');
    assertClose(out.z, -local.y - 71, 1e-6, 'z');
  });

  it('folds the whole viewer shift into decodeOriginOffset: matrix translation is EXACTLY zero', () => {
    // f32-precision property (the reason for the fold): even with a huge
    // RTC offset — a file authored directly at Swiss LV95 magnitudes —
    // the aligned matrix must carry NO translation, because a ~1e6 f32
    // translation would quantise to ~0.25 m and defeat the feature.
    const georef = makeGeoref({
      mapConversion: { eastings: 0, northings: 0, orthogonalHeight: 0 },
      coordinateInfo: {
        originShift: { x: 0, y: 0, z: 0 },
        originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
        shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
        hasLargeCoordinates: true,
        wasmRtcOffset: { x: 2_600_000, y: 1_200_000, z: 450 },
      },
    });
    const t = computePointCloudAlignment(georef);
    assert.ok(t);
    assert.strictEqual(t.alignedMatrix[12], 0);
    assert.strictEqual(t.alignedMatrix[13], 0);
    assert.strictEqual(t.alignedMatrix[14], 0);
    // The magnitude moved into the (f64-consumed) decode offset instead:
    // the wasm RTC offset is Z-up (E, N, H) = (2.6e6, 1.2e6, 450), and the
    // map conversion here is identity, so the decode offset IS the RTC
    // offset expressed in map axes.
    assertClose(t.decodeOriginOffset[0], 2_600_000, 1e-6);
    assertClose(t.decodeOriginOffset[1], 1_200_000, 1e-6);
    assertClose(t.decodeOriginOffset[2], 450, 1e-6);
    // Sanity via the full chain: a scan point AT the viewer origin's map
    // position must land at viewer (0,0,0).
    const atOrigin = runAlignmentChain(t, t.decodeOriginOffset);
    assertClose(atOrigin.x, 0, 1e-9);
    assertClose(atOrigin.y, 0, 1e-9);
    assertClose(atOrigin.z, 0, 1e-9);
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

    // No coordinateInfo => viewer shift is zero; the full chain must equal
    // `invertMapConversion` composed with the Y-up axis swap.
    const raw = [500_030, 4_999_980, 105] as const;
    const out = runAlignmentChain(t, raw);
    const expected = invertMapConversion(
      {
        eastings: 500_000, northings: 5_000_000, orthogonalHeight: 100,
        xAxisAbscissa: Math.cos(angle), xAxisOrdinate: Math.sin(angle),
      },
      raw[0], raw[1], raw[2],
    );
    assert.ok(expected);
    // 1e-4 tolerance: the matrix entries are f32 (GPU uniform), so each
    // multiply carries ~6e-8 relative error at these magnitudes.
    assertClose(out.x, expected.x, 1e-4);
    assertClose(out.y, expected.z, 1e-4);
    assertClose(out.z, -expected.y, 1e-4);
  });

  it('converts native map units to viewer metres (foot-based CRS)', () => {
    // Explicit MapUnit = foot: LAS coordinates are stored in feet, the
    // viewer frame is metres. mapUnitScale=0.3048, Scale unset(=1) with
    // mismatched units → getEffectiveHorizontalScale's practical-intent
    // heuristic yields effectiveScale 1, so k = 0.3048 exactly.
    const georef = makeGeoref({
      mapConversion: { eastings: 1_000_000, northings: 2_000_000, orthogonalHeight: 300 },
      projectedCRS: { mapUnitScale: 0.3048 },
    });
    const t = computePointCloudAlignment(georef);
    assert.ok(t);
    // decodeOriginOffset stays in NATIVE units (feet) — it is subtracted
    // from raw native LAS coordinates.
    assertClose(t.decodeOriginOffset[0], 1_000_000, 1e-6);
    assertClose(t.decodeOriginOffset[1], 2_000_000, 1e-6);
    assertClose(t.decodeOriginOffset[2], 300, 1e-6);
    // A point 100 ft east / 50 ft up of the conversion origin lands at
    // 30.48 m east / 15.24 m up in the viewer.
    const out = runAlignmentChain(t, [1_000_100, 2_000_000, 350]);
    assertClose(out.x, 100 * 0.3048, 1e-4);
    assertClose(out.y, 50 * 0.3048, 1e-4);
    assertClose(out.z, 0, 1e-4);
  });

  it('the unaligned matrix undoes only the decode-time offset (raw placement)', () => {
    const georef = makeGeoref();
    const t = computePointCloudAlignment(georef);
    assert.ok(t);
    const m = t.unalignedMatrix;
    // Pure translation, no rotation/scale.
    assert.strictEqual(m[0], 1); assert.strictEqual(m[5], 1); assert.strictEqual(m[10], 1);
    // Restores exactly what decode subtracted, in swapped Y-up axes.
    assertClose(m[12], t.decodeOriginOffset[0]);
    assertClose(m[13], t.decodeOriginOffset[2]);
    assertClose(m[14], -t.decodeOriginOffset[1]);
    // With no coordinateInfo the decode offset is the conversion offsets.
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

/**
 * `getPointCloudAlignmentMatrix` feeds CPU consumers (the 2D scan overlay)
 * the matrix the GPU is currently drawing through, so they place raw
 * cached points where the user actually sees them.
 */
describe('getPointCloudAlignmentMatrix', () => {
  const georef: ModelGeoref = {
    mapConversion: {
      eastings: 2_600_000, northings: 1_200_000, orthogonalHeight: 450,
      xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1,
    } as MapConversion,
    projectedCRS: {} as ProjectedCRS,
    coordinateInfo: undefined,
  } as unknown as ModelGeoref;

  it('returns undefined for a handle with no alignment registered', () => {
    assert.strictEqual(getPointCloudAlignmentMatrix(4242, true), undefined);
  });

  it('returns the UNALIGNED matrix when the toggle is off — not undefined', () => {
    // Regression guard for a CodeRabbit suggestion on PR #1889 (issue
    // #1804 follow-up) that would have broken this: it proposed returning
    // undefined here so callers could take the no-matrix fast path.
    // `unalignedMatrix` is NOT identity: it restores the f64 decode-time
    // origin subtraction, a translation of map magnitude (~2.6e6). Handing
    // callers `undefined` here would leave them on raw decode coordinates
    // while the GPU renders with that offset restored — reintroducing, for
    // the toggle-off case, exactly the frame mismatch this API exists to
    // remove.
    const transform = computePointCloudAlignment(georef);
    assert.ok(transform, 'fixture must produce an alignment');
    registerPointCloudAlignment({ id: 91 }, transform!);
    try {
      const off = getPointCloudAlignmentMatrix(91, false);
      assert.ok(off, 'a registered asset must still report a matrix when unaligned');
      assert.strictEqual(off!.matrix, transform!.unalignedMatrix);
      const isIdentity = off!.matrix[12] === 0 && off!.matrix[13] === 0 && off!.matrix[14] === 0;
      assert.ok(!isIdentity, 'unalignedMatrix carries the decode offset; it is not a no-op');
      // It restores ABSOLUTE native coordinates, so the caller must still
      // apply the world -> render-frame shift.
      assert.strictEqual(off!.outputsRenderFrame, false);

      const on = getPointCloudAlignmentMatrix(91, true);
      assert.strictEqual(on!.matrix, transform!.alignedMatrix);
      // The aligned matrix folds the whole viewer shift into its decode
      // offset (zero translation column), so it is ALREADY render-frame —
      // shifting it again would displace the overlay by the full offset.
      assert.strictEqual(on!.outputsRenderFrame, true);
    } finally {
      unregisterPointCloudAlignment(91);
    }
  });
});

describe('computePointCloudAlignment with map-absolute geometry (#2526)', () => {
  // Vectorworks-style reference model: geometry authored at the ABSOLUTE
  // projected coordinates (rebased into wasmRtcOffset), IfcMapConversion
  // repeating the same anchor with a 90-degree rotation. A .laz scan carries
  // the SAME absolute coordinates, so aligning it must be a pure viewer-shift
  // subtraction (identity conversion) — inverting the authored conversion
  // would rotate the cloud away from the model it was scanned against.
  const mapAbsInfo: NonNullable<ModelGeoref['coordinateInfo']> = {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } },
    shiftedBounds: { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } },
    hasLargeCoordinates: false,
    wasmRtcOffset: { x: 312000, y: 5996150, z: 10 },
  };
  const mapAbsGeoref = (coordinateInfo?: ModelGeoref['coordinateInfo']) => makeGeoref({
    mapConversion: {
      eastings: 312000,
      northings: 5996150,
      orthogonalHeight: 0,
      xAxisAbscissa: 0,
      xAxisOrdinate: 1,
    },
    coordinateInfo,
  });

  it('lands a scan point exactly on the model: identity conversion, viewer shift only', () => {
    const t = computePointCloudAlignment(mapAbsGeoref(mapAbsInfo));
    assert.ok(t);
    // Viewer origin in map space under the NEUTRALISED conversion is the
    // total Y-up offset unswapped to Z-up: (312000, 5996150, 10).
    assertClose(t.decodeOriginOffset[0], 312000, 1e-6, 'decode E');
    assertClose(t.decodeOriginOffset[1], 5996150, 1e-6, 'decode N');
    assertClose(t.decodeOriginOffset[2], 10, 1e-6, 'decode H');
    // Raw scan point (E, N, H) = (312010, 5996140, 12) — same absolute frame
    // as the geometry — must land at viewer (10, 2, 10).
    const out = runAlignmentChain(t, [312010, 5996140, 12]);
    assertClose(out.x, 10, 1e-6, 'x');
    assertClose(out.y, 2, 1e-6, 'y');
    assertClose(out.z, 10, 1e-6, 'z');
  });

  it('control: a compliant reference (no RTC rebase) keeps the authored rotation', () => {
    const compliant = mapAbsGeoref({ ...mapAbsInfo, wasmRtcOffset: undefined });
    const t = computePointCloudAlignment(compliant);
    assert.ok(t);
    // off = 0, authored conversion: decode offset is the anchor itself.
    assertClose(t.decodeOriginOffset[0], 312000, 1e-6, 'decode E');
    assertClose(t.decodeOriginOffset[1], 5996150, 1e-6, 'decode N');
    assertClose(t.decodeOriginOffset[2], 0, 1e-6, 'decode H');
    // map -> local under the authored 90-degree rotation, then Z-up -> Y-up:
    // local = invert(anchor+90deg, raw); expected viewer = (local.x, local.z, -local.y).
    const local = invertMapConversion(
      {
        eastings: 312000,
        northings: 5996150,
        orthogonalHeight: 0,
        xAxisAbscissa: 0,
        xAxisOrdinate: 1,
      },
      312010, 5996140, 12,
    );
    assert.ok(local);
    const out = runAlignmentChain(t, [312010, 5996140, 12]);
    assertClose(out.x, local.x, 1e-6, 'x');
    assertClose(out.y, local.z, 1e-6, 'y');
    assertClose(out.z, -local.y, 1e-6, 'z');
  });
});

/**
 * PR #2623 review — confirmed defect: `decodeOriginOffset` was ALWAYS
 * expressed in the map CRS's native `MapUnit` (feet, in this fixture),
 * regardless of the point-cloud format consuming it. That was safe while a
 * LAS/LAZ-only gate kept the offset away from every other format — LAS
 * conventionally shares the CRS's MapUnit. This PR removes that gate, so
 * the same offset now feeds E57/PCD/PLY/PTS/XYZ decoders. But E57 cartesian
 * coordinates are spec-mandated to be METRES (ASTM E2807) independent of
 * MapUnit, and PCD/PLY/PTS/XYZ have no unit convention at all — so a
 * MapUnit-native offset subtracted from a metre-native raw coordinate
 * (`decoders do a bare `raw - offset`) landed the cloud thousands of km off
 * for any CRS whose MapUnit isn't already the metre.
 *
 * Fixture matches the review's own repro exactly: MapUnit = foot
 * (mapUnitScale 0.3048), conversion eastings/northings/orthogonalHeight =
 * 1_000_000 / 2_000_000 / 300 (feet) = 304_800 / 609_600 / 91.44 (metres).
 * A scan point sitting EXACTLY at that map position — the metre-native
 * equivalent — must decode to a residual near zero. Decoding it against the
 * MapUnit-native offset instead reproduces the review's measured
 * 1_554_514 m residual bit-for-bit (same fixture numbers), proving these
 * assertions are not vacuous: they fail specifically when the wrong unit is
 * used, not for an unrelated reason.
 */
describe('format-native decode unit for the origin offset (PR #2623 review)', () => {
  const FOOT_GEOREF = makeGeoref({
    mapConversion: { eastings: 1_000_000, northings: 2_000_000, orthogonalHeight: 300 },
    projectedCRS: { mapUnitScale: 0.3048 },
  });
  // The map-space position of the conversion origin, in metres — what an
  // E57/PCD/PLY/PTS/XYZ point AT that position encodes per their (spec or
  // assumed) metre convention.
  const POINT_AT_ORIGIN_METRES: readonly [number, number, number] = [304_800, 609_600, 91.44];

  it("computePointCloudAlignment('metre') converts the offset out of MapUnit into metres", () => {
    const mapUnit = computePointCloudAlignment(FOOT_GEOREF, 'mapUnit');
    const metre = computePointCloudAlignment(FOOT_GEOREF, 'metre');
    assert.ok(mapUnit && metre);
    assert.strictEqual(mapUnit.decodeOriginOffsetUnit, 'mapUnit');
    assert.strictEqual(metre.decodeOriginOffsetUnit, 'metre');
    // Native (feet) — bug-compatible for LAS/LAZ, matches the pre-existing
    // "foot-based CRS" pin above.
    assertClose(mapUnit.decodeOriginOffset[0], 1_000_000, 1e-6);
    assertClose(mapUnit.decodeOriginOffset[1], 2_000_000, 1e-6);
    assertClose(mapUnit.decodeOriginOffset[2], 300, 1e-6);
    // Metres — the fix, for every other format.
    assertClose(metre.decodeOriginOffset[0], 304_800, 1e-6);
    assertClose(metre.decodeOriginOffset[1], 609_600, 1e-6);
    assertClose(metre.decodeOriginOffset[2], 91.44, 1e-6);
    // Defaulting the parameter reproduces the 'mapUnit' behaviour byte for
    // byte — no existing single-argument call site's numbers move.
    const defaulted = computePointCloudAlignment(FOOT_GEOREF);
    assert.ok(defaulted);
    assert.strictEqual(defaulted.decodeOriginOffsetUnit, 'mapUnit');
    assert.strictEqual(defaulted.decodeOriginOffset[0], mapUnit.decodeOriginOffset[0]);
  });

  it("'metre' aligned matrix's k does not double-apply the MapUnit conversion", () => {
    // A distinct bug shape from the offset unit itself: the offset can be
    // metre-correct while the aligned matrix's linear factor `k` still
    // assumes a native-map-unit residual (k = mapUnitScale/scale instead of
    // 1/scale). That silently rescales every 'metre'-format point by
    // mapUnitScale (0.3048 here) instead of leaving it as viewer metres.
    const t = computePointCloudAlignment(FOOT_GEOREF, 'metre');
    assert.ok(t);
    // A point 100 m east / 50 m up of the conversion origin, in the SAME
    // metre-native raw frame E57/PCD/PLY/PTS/XYZ decoders consume.
    const raw: readonly [number, number, number] = [
      POINT_AT_ORIGIN_METRES[0] + 100,
      POINT_AT_ORIGIN_METRES[1],
      POINT_AT_ORIGIN_METRES[2] + 50,
    ];
    const out = runAlignmentChain(t, raw);
    assertClose(out.x, 100, 1e-4, 'x (would read ~30.48 if k wrongly applied mapUnitScale)');
    assertClose(out.y, 50, 1e-4, 'y');
    assertClose(out.z, 0, 1e-4, 'z');
  });

  function residual(pos: Float32Array): number {
    return Math.hypot(pos[0], pos[1], pos[2]);
  }

  it('E57 (decodeE57Scan, no pose): metre offset gives ~0 residual, MapUnit offset reproduces the review\'s 1,554,514 m', () => {
    const wrong = computePointCloudAlignment(FOOT_GEOREF, 'mapUnit');
    const right = computePointCloudAlignment(FOOT_GEOREF, 'metre');
    assert.ok(wrong && right);

    const buildEntry = (): { entry: Data3DEntry; logical: Uint8Array } => {
      const [x, y, z] = POINT_AT_ORIGIN_METRES;
      const lenF64 = 8;
      const headerBytes = 4 + 2 + 3 * 2;
      const packetSize = headerBytes + lenF64 * 3;
      const buf = new ArrayBuffer(packetSize);
      const view = new DataView(buf);
      view.setUint8(0, 1);
      view.setUint8(1, 0);
      view.setUint16(2, packetSize - 1, true);
      view.setUint16(4, 3, true);
      for (let i = 0; i < 3; i++) view.setUint16(6 + i * 2, lenF64, true);
      let cursor = headerBytes;
      view.setFloat64(cursor, x, true); cursor += lenF64;
      view.setFloat64(cursor, y, true); cursor += lenF64;
      view.setFloat64(cursor, z, true);
      const entry: Data3DEntry = {
        guid: 'test',
        recordCount: 1,
        binaryFileOffset: 0,
        prototype: [
          { name: 'cartesianX', kind: 'Float', precision: 'double' },
          { name: 'cartesianY', kind: 'Float', precision: 'double' },
          { name: 'cartesianZ', kind: 'Float', precision: 'double' },
        ],
      };
      return { entry, logical: new Uint8Array(buf) };
    };

    const { entry: entryWrong, logical: logicalWrong } = buildEntry();
    const decodedWrong = decodeE57Scan(logicalWrong, entryWrong, wrong.decodeOriginOffset);
    const residualWrong = residual(decodedWrong.positions);
    assertClose(residualWrong, 1_554_514, 1, 'RED (MapUnit-native offset on a metre-native E57 point)');

    const { entry: entryRight, logical: logicalRight } = buildEntry();
    const decodedRight = decodeE57Scan(logicalRight, entryRight, right.decodeOriginOffset);
    assertClose(residual(decodedRight.positions), 0, 1e-3, 'GREEN (metre offset)');
  });

  it('PCD (decodePcd, ascii): metre offset gives ~0 residual, MapUnit offset does not', () => {
    const wrong = computePointCloudAlignment(FOOT_GEOREF, 'mapUnit');
    const right = computePointCloudAlignment(FOOT_GEOREF, 'metre');
    assert.ok(wrong && right);

    const buildPcd = (): Uint8Array => {
      const [x, y, z] = POINT_AT_ORIGIN_METRES;
      const header = [
        '# .PCD test',
        'VERSION 0.7',
        'FIELDS x y z',
        'SIZE 4 4 4',
        'TYPE F F F',
        'COUNT 1 1 1',
        'WIDTH 1',
        'HEIGHT 1',
        'VIEWPOINT 0 0 0 1 0 0 0',
        'POINTS 1',
        'DATA ascii',
        '',
      ].join('\n');
      return new TextEncoder().encode(`${header}${x} ${y} ${z}\n`);
    };

    const decodedWrong = decodePcd(buildPcd(), wrong.decodeOriginOffset);
    assertClose(residual(decodedWrong.positions), 1_554_514, 1, 'RED (MapUnit-native offset)');

    const decodedRight = decodePcd(buildPcd(), right.decodeOriginOffset);
    assertClose(residual(decodedRight.positions), 0, 1e-3, 'GREEN (metre offset)');
  });

  it('PLY (decodePly, ascii): metre offset gives ~0 residual, MapUnit offset does not', () => {
    const wrong = computePointCloudAlignment(FOOT_GEOREF, 'mapUnit');
    const right = computePointCloudAlignment(FOOT_GEOREF, 'metre');
    assert.ok(wrong && right);

    const buildPly = (): Uint8Array => {
      const [x, y, z] = POINT_AT_ORIGIN_METRES;
      const header =
        'ply\n' +
        'format ascii 1.0\n' +
        'element vertex 1\n' +
        'property float x\nproperty float y\nproperty float z\n' +
        'end_header\n';
      return new TextEncoder().encode(`${header}${x} ${y} ${z}\n`);
    };

    const decodedWrong = decodePly(buildPly(), wrong.decodeOriginOffset);
    assertClose(residual(decodedWrong.positions), 1_554_514, 1, 'RED (MapUnit-native offset)');

    const decodedRight = decodePly(buildPly(), right.decodeOriginOffset);
    assertClose(residual(decodedRight.positions), 0, 1e-3, 'GREEN (metre offset)');
  });

  it('ASCII (decodeAsciiPoints, XYZ and PTS): metre offset gives ~0 residual, MapUnit offset does not', () => {
    const wrong = computePointCloudAlignment(FOOT_GEOREF, 'mapUnit');
    const right = computePointCloudAlignment(FOOT_GEOREF, 'metre');
    assert.ok(wrong && right);
    const [x, y, z] = POINT_AT_ORIGIN_METRES;

    for (const format of ['xyz', 'pts'] as const) {
      const bytes = new TextEncoder().encode(
        format === 'pts' ? `1\n${x} ${y} ${z}\n` : `${x} ${y} ${z}\n`,
      );
      const decodedWrong = decodeAsciiPoints(bytes, format, wrong.decodeOriginOffset);
      assertClose(residual(decodedWrong.positions), 1_554_514, 1, `RED (${format}, MapUnit-native offset)`);

      const decodedRight = decodeAsciiPoints(bytes, format, right.decodeOriginOffset);
      assertClose(residual(decodedRight.positions), 0, 1e-3, `GREEN (${format}, metre offset)`);
    }
  });
});
