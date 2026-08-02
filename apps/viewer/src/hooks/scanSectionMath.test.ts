/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scan section-layer math (issue #1805): band selection, projection, and
 * the render-frame shift point clouds need to line up with the section cut.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  pointCloudRenderFrameShift,
  toRenderFrame,
  resolveScanSectionPosition,
  signedBandDistance,
  isPointInBand,
  projectScanPoint,
  selectScanBand,
  mergeScanBandSelections,
  type ScanSectionPlane,
  type ScanPointSample,
} from './scanSectionMath.js';
import { dxfWorldShift } from './dxfUnderlayMath.js';

const close = (a: number, b: number, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);

describe('pointCloudRenderFrameShift', () => {
  it('matches dxfWorldShift on the plan (x, z) pair — one formula, two call sites', () => {
    const coordinateInfo = {
      wasmRtcOffset: { x: 1000, y: 2000, z: 5 },
      originShift: { x: 3, y: 9, z: -7 },
    } as never;
    const shift = pointCloudRenderFrameShift(coordinateInfo);
    const dxf = dxfWorldShift(coordinateInfo);
    // dxfWorldShift.x is the plan-X shift; dxfWorldShift.y is the plan-Z
    // shift (drawing y = -renderZ, so dxf.y = -(-shift.z) = ... see
    // dxfUnderlayMath.ts's own derivation). Both were derived independently
    // from reproject.ts's `computeModelCenterInIfcMeters`; this test pins
    // them to the same numbers so a future edit to one can't silently
    // diverge from the other.
    close(shift.x, dxf.x);
    close(shift.z, -dxf.y);
  });

  it('adds the elevation (Y) term absent from the plan-only DXF shift', () => {
    const shift = pointCloudRenderFrameShift({
      wasmRtcOffset: { x: 0, y: 0, z: 40 },
      originShift: { x: 0, y: 5, z: 0 },
    } as never);
    close(shift.y, 45); // rtc.z + shift.y
  });

  it('degenerates to zero with no coordinate info', () => {
    const shift = pointCloudRenderFrameShift(undefined);
    close(shift.x, 0);
    close(shift.y, 0);
    close(shift.z, 0);
  });
});

describe('toRenderFrame', () => {
  it('subtracts the shift component-wise', () => {
    const p = toRenderFrame({ x: 10, y: 20, z: 30 }, { x: 1, y: 2, z: 3 });
    close(p.x, 9);
    close(p.y, 18);
    close(p.z, 27);
  });
});

describe('resolveScanSectionPosition', () => {
  // Regression guard for the store contract: `SectionPlane.position` is a
  // 0-100 PERCENTAGE of model bounds (store/types.ts), and the scan layer
  // must resolve it over `shiftedBounds` with the exact formula
  // `useDrawingGeneration` uses to place the cut — using the raw
  // percentage as metres put the band on a different plane than the drawn
  // geometry for almost every model.
  const coordinateInfo = {
    shiftedBounds: {
      min: { x: -4, y: 2, z: -10 },
      max: { x: 6, y: 12, z: 30 },
    },
  } as never;

  it('maps 0 / 50 / 100 % onto the shifted-bounds axis range', () => {
    close(resolveScanSectionPosition(0, 'y', coordinateInfo), 2);
    close(resolveScanSectionPosition(50, 'y', coordinateInfo), 7);
    close(resolveScanSectionPosition(100, 'y', coordinateInfo), 12);
    close(resolveScanSectionPosition(25, 'z', coordinateInfo), 0); // -10 + 0.25*40
    close(resolveScanSectionPosition(50, 'x', coordinateInfo), 1);
  });

  it('collapses to the axis minimum on degenerate/absent bounds', () => {
    close(resolveScanSectionPosition(50, 'y', undefined), 0);
  });

  it('percentage slider selects the band at the DRAWN cut plane, not at "percent metres"', () => {
    // Model spans y ∈ [2, 12]; slider at 30% → cut at y = 5.
    // A point at y=5 must be in band; a point at y=30 ("percent as
    // metres" trap) must not.
    const positions = new Float32Array([0, 5, 0, 0, 30, 0]);
    const sample: ScanPointSample = { positions, count: 2 };
    const plane: ScanSectionPlane = {
      axis: 'y',
      position: resolveScanSectionPosition(30, 'y', coordinateInfo),
      flipped: false,
    };
    const result = selectScanBand({ sample, coordinateInfo, plane, thickness: 0.2 });
    assert.strictEqual(result.totalInBand, 1);
    close(result.points[0].point.x, 0);
  });
});

describe('signedBandDistance / isPointInBand (cardinal)', () => {
  const plane: ScanSectionPlane = { axis: 'y', position: 5, flipped: false };

  it('is zero exactly on the plane and signed off it', () => {
    close(signedBandDistance({ x: 0, y: 5, z: 0 }, plane), 0);
    close(signedBandDistance({ x: 0, y: 5.2, z: 0 }, plane), 0.2);
    close(signedBandDistance({ x: 0, y: 4.7, z: 0 }, plane), -0.3);
  });

  it('band membership ignores `flipped` — flip only mirrors the projected U axis', () => {
    const flipped: ScanSectionPlane = { ...plane, flipped: true };
    const p = { x: 0, y: 5.1, z: 0 };
    assert.strictEqual(isPointInBand(p, plane, 0.3), isPointInBand(p, flipped, 0.3));
    assert.ok(isPointInBand(p, plane, 0.3));
    assert.ok(!isPointInBand(p, plane, 0.1));
  });
});

describe('signedBandDistance (custom plane)', () => {
  it('matches signedDistanceToPlane against the custom normal/distance', () => {
    const plane: ScanSectionPlane = {
      axis: 'y',
      position: 0,
      flipped: false,
      custom: {
        normal: [0, 0, 1],
        distance: 2,
        origin: [0, 0, 2],
        tangent: [1, 0, 0],
        bitangent: [0, 1, 0],
      },
    };
    close(signedBandDistance({ x: 5, y: 5, z: 2 }, plane), 0);
    close(signedBandDistance({ x: 5, y: 5, z: 2.5 }, plane), 0.5);
  });

  it('a degenerate zero normal excludes every point instead of admitting all', () => {
    // `dot(p, n) - d` is 0 for every point when n is zero-length, which
    // without a guard drops the WHOLE cloud into the band (PR #1874 review).
    const degenerate: ScanSectionPlane = {
      axis: 'y',
      position: 0,
      flipped: false,
      custom: {
        normal: [0, 0, 0],
        distance: 0,
        origin: [0, 0, 0],
        tangent: [1, 0, 0],
        bitangent: [0, 0, 1],
      },
    };
    assert.equal(signedBandDistance({ x: 100, y: 100, z: 100 }, degenerate), Infinity);
    assert.equal(isPointInBand({ x: 0, y: 0, z: 0 }, degenerate, 10), false);
  });
});

describe('projectScanPoint (cardinal)', () => {
  it('plan (down = y axis): x stays X, y becomes Z, matching section-cutter.ts', () => {
    const plane: ScanSectionPlane = { axis: 'y', position: 0, flipped: false };
    const p2 = projectScanPoint({ x: 3, y: 100, z: -4 }, plane);
    close(p2.x, 3);
    close(p2.y, -4);
  });

  it('flipped mirrors the U axis only', () => {
    const plane: ScanSectionPlane = { axis: 'y', position: 0, flipped: true };
    const p2 = projectScanPoint({ x: 3, y: 100, z: -4 }, plane);
    close(p2.x, -3);
    close(p2.y, -4);
  });

  it('vertical section (front = z axis): projects to (x, y)', () => {
    const plane: ScanSectionPlane = { axis: 'z', position: 0, flipped: false };
    const p2 = projectScanPoint({ x: 3, y: 7, z: -4 }, plane);
    close(p2.x, 3);
    close(p2.y, 7);
  });

  it('vertical section (side = x axis): projects to (z, y)', () => {
    const plane: ScanSectionPlane = { axis: 'x', position: 0, flipped: false };
    const p2 = projectScanPoint({ x: 3, y: 7, z: -4 }, plane);
    close(p2.x, -4);
    close(p2.y, 7);
  });
});

describe('projectScanPoint (custom plane)', () => {
  it('projects via dot(point - origin, tangent/bitangent)', () => {
    const plane: ScanSectionPlane = {
      axis: 'y',
      position: 0,
      flipped: false,
      custom: {
        normal: [0, 0, 1],
        distance: 2,
        origin: [1, 1, 2],
        tangent: [1, 0, 0],
        bitangent: [0, 1, 0],
      },
    };
    const p2 = projectScanPoint({ x: 4, y: 6, z: 2 }, plane);
    close(p2.x, 3); // 4 - origin.x(1)
    close(p2.y, 5); // 6 - origin.y(1)
  });
});

describe('selectScanBand', () => {
  function sample(points: Array<[number, number, number]>, opts: {
    colors?: Uint8Array | Float32Array;
    classifications?: Uint8Array;
  } = {}): ScanPointSample {
    const positions = new Float32Array(points.length * 3);
    points.forEach(([x, y, z], i) => {
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
    });
    return { positions, count: points.length, colors: opts.colors, classifications: opts.classifications };
  }

  it('keeps only points inside the band and projects them (plan section)', () => {
    const s = sample([
      [1, 5, 2],   // in band (y=5, position=5, thickness .3 -> [4.85,5.15])
      [1, 5.1, 2], // in band
      [1, 6, 2],   // out of band
      [1, 4, 2],   // out of band
    ]);
    const plane: ScanSectionPlane = { axis: 'y', position: 5, flipped: false };
    const result = selectScanBand({ sample: s, coordinateInfo: undefined, plane, thickness: 0.3 });
    assert.strictEqual(result.totalInBand, 2);
    assert.strictEqual(result.renderedCount, 2);
    assert.strictEqual(result.stride, 1);
    close(result.points[0].point.x, 1);
    close(result.points[0].point.y, 2);
  });

  it('applies the render-frame shift before the band test', () => {
    const s = sample([[0, 100, 0]]); // raw Y (elevation) = 100
    const plane: ScanSectionPlane = { axis: 'y', position: 3, flipped: false };
    // shift.y = rtc.z + originShift.y = 97 -> render Y = 100 - 97 = 3 (on-plane)
    const coordinateInfo = { wasmRtcOffset: { x: 0, y: 0, z: 97 }, originShift: { x: 0, y: 0, z: 0 } } as never;
    const result = selectScanBand({ sample: s, coordinateInfo, plane, thickness: 0.1 });
    assert.strictEqual(result.totalInBand, 1);
  });

  it('vertical (front) section keeps points at the right Z depth, not Y', () => {
    const s = sample([
      [1, 2, 5],   // z=5, on a front-axis plane at position=5
      [1, 9, 5.05],
      [1, 2, 8],   // out of band
    ]);
    const plane: ScanSectionPlane = { axis: 'z', position: 5, flipped: false };
    const result = selectScanBand({ sample: s, coordinateInfo: undefined, plane, thickness: 0.2 });
    assert.strictEqual(result.totalInBand, 2);
  });

  it('mirrors the projected U axis on a flipped cardinal section', () => {
    const s = sample([[2, 5, 0]]);
    const unflipped = selectScanBand({
      sample: s, coordinateInfo: undefined, thickness: 1,
      plane: { axis: 'y', position: 5, flipped: false },
    });
    const flipped = selectScanBand({
      sample: s, coordinateInfo: undefined, thickness: 1,
      plane: { axis: 'y', position: 5, flipped: true },
    });
    close(unflipped.points[0].point.x, 2);
    close(flipped.points[0].point.x, -2);
  });

  it('filters by the LAS class-visibility mask', () => {
    const s = sample(
      [[0, 5, 0], [1, 5, 0]],
      { classifications: new Uint8Array([2, 7]) },
    );
    // Hide class 7: word0 = all bits except bit 7.
    const mask = [0xFFFFFFFF & ~(1 << 7), 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF];
    const result = selectScanBand({
      sample: s, coordinateInfo: undefined, classMask: mask, thickness: 1,
      plane: { axis: 'y', position: 5, flipped: false },
    });
    assert.strictEqual(result.totalInBand, 1);
    close(result.points[0].point.x, 0);
  });

  it('carries per-point colour when the sample has it (Uint8 and Float32)', () => {
    const s8 = sample([[0, 5, 0]], { colors: new Uint8Array([255, 0, 128]) });
    const r8 = selectScanBand({ sample: s8, coordinateInfo: undefined, thickness: 1, plane: { axis: 'y', position: 5, flipped: false } });
    assert.deepStrictEqual(r8.points[0].color?.map((c) => Math.round(c * 255)), [255, 0, 128]);

    const sf = sample([[0, 5, 0]], { colors: new Float32Array([1, 0, 0.5]) });
    const rf = selectScanBand({ sample: sf, coordinateInfo: undefined, thickness: 1, plane: { axis: 'y', position: 5, flipped: false } });
    close(rf.points[0].color?.[2] ?? -1, 0.5);
  });

  it('decimates deterministically above the render cap', () => {
    const points: Array<[number, number, number]> = [];
    for (let i = 0; i < 1000; i++) points.push([i, 5, 0]);
    const s = sample(points);
    const plane: ScanSectionPlane = { axis: 'y', position: 5, flipped: false };
    const run = () => selectScanBand({ sample: s, coordinateInfo: undefined, plane, thickness: 1, maxRendered: 100 });
    const a = run();
    const b = run();
    assert.strictEqual(a.totalInBand, 1000);
    assert.strictEqual(a.stride, 10);
    assert.ok(a.renderedCount <= 100);
    assert.ok(a.renderedCount > 0);
    // Deterministic: repeated calls over the same input yield the identical set.
    assert.deepStrictEqual(a.points.map((p) => p.point.x), b.points.map((p) => p.point.x));
  });

  it('does not decimate when under the cap', () => {
    const s = sample([[0, 5, 0], [1, 5, 0]]);
    const result = selectScanBand({
      sample: s, coordinateInfo: undefined, thickness: 1, maxRendered: 500_000,
      plane: { axis: 'y', position: 5, flipped: false },
    });
    assert.strictEqual(result.stride, 1);
    assert.strictEqual(result.renderedCount, 2);
  });
});

describe('mergeScanBandSelections', () => {
  it('enforces the render cap across merged assets, not just per asset', () => {
    // Two "assets" each already at a 1000-point per-asset cap: the merged
    // result must still respect a 1000-point total, deterministically.
    const mk = (offset: number) => ({
      points: Array.from({ length: 1000 }, (_, i) => ({ point: { x: offset + i, y: 0 } })),
      totalInBand: 1000,
      renderedCount: 1000,
      stride: 1,
    });
    const merged = mergeScanBandSelections([mk(0), mk(10_000)], 1000);
    assert.ok(merged.renderedCount <= 1000, `expected <= 1000, got ${merged.renderedCount}`);
    assert.strictEqual(merged.totalInBand, 2000);
    assert.strictEqual(merged.stride, 2);
    const again = mergeScanBandSelections([mk(0), mk(10_000)], 1000);
    assert.deepStrictEqual(
      merged.points.map((p) => p.point.x),
      again.points.map((p) => p.point.x),
    );
    // Both assets still represented after the merge-level decimation.
    assert.ok(merged.points.some((p) => p.point.x < 10_000));
    assert.ok(merged.points.some((p) => p.point.x >= 10_000));
  });

  it('merges render-cap-scale selections without overflowing the call stack', () => {
    // `push(...points)` turns every point into a call argument and throws
    // RangeError somewhere above ~100k; the cap is 500k, so a merge at
    // scale must use a plain loop.
    const big = {
      points: Array.from({ length: 300_000 }, (_, i) => ({ point: { x: i, y: 0 } })),
      totalInBand: 300_000,
      renderedCount: 300_000,
      stride: 1,
    };
    const merged = mergeScanBandSelections([big]);
    assert.strictEqual(merged.renderedCount, 300_000);
  });

  it('sums counts and reports the largest per-asset stride', () => {
    const a = { points: [{ point: { x: 0, y: 0 } }], totalInBand: 10, renderedCount: 1, stride: 10 };
    const b = {
      points: Array.from({ length: 5 }, (_, i) => ({ point: { x: i + 1, y: 1 } })),
      totalInBand: 5,
      renderedCount: 5,
      stride: 1,
    };
    const merged = mergeScanBandSelections([a, b]);
    assert.strictEqual(merged.totalInBand, 15);
    assert.strictEqual(merged.renderedCount, 6);
    assert.strictEqual(merged.stride, 10);
    assert.strictEqual(merged.points.length, 6);
  });
});

/**
 * Aligned-scan reconciliation for the 2D overlay (#1804 x #1805).
 *
 * The scan cache holds RAW decoder points; an aligned asset is drawn
 * through its GPU matrix. Without folding that matrix in here, the 2D
 * section overlay selects a band around pre-alignment coordinates while
 * the 3D view shows the scan aligned to the building — the two views
 * disagree about where the same scan is.
 */
describe('selectScanBand with an aligned point cloud', () => {
  /** Column-major 4x4: identity rotation/scale, translation only. */
  function translation(x: number, y: number, z: number): Float32Array {
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
  }

  const plane: ScanSectionPlane = { axis: 'y', position: 5, flipped: false };

  it('selects the band around the RENDERED position, not the raw one', () => {
    // Raw point at y=0. The asset is drawn +5 in y, so it renders at y=5
    // and must fall inside a band centred on y=5.
    const sample: ScanPointSample = { positions: new Float32Array([0, 0, 0]), count: 1 };
    const aligned = selectScanBand({
      sample, coordinateInfo: undefined, plane, thickness: 0.2, model: translation(0, 5, 0),
    });
    assert.strictEqual(aligned.totalInBand, 1, 'aligned point must be in band at its rendered height');
  });

  it('does not select the stale raw position once aligned', () => {
    // Same asset, but the band sits at the RAW height (y=0). Nothing is
    // rendered there any more, so nothing should be selected.
    const sample: ScanPointSample = { positions: new Float32Array([0, 0, 0]), count: 1 };
    const atRaw = selectScanBand({
      sample,
      coordinateInfo: undefined,
      plane: { axis: 'y', position: 0, flipped: false },
      thickness: 0.2,
      model: translation(0, 5, 0),
    });
    assert.strictEqual(atRaw.totalInBand, 0, 'pre-alignment position must no longer be selected');
  });

  it('is unchanged when no matrix is supplied (unaligned fast path)', () => {
    const sample: ScanPointSample = { positions: new Float32Array([0, 5, 0]), count: 1 };
    const bare = selectScanBand({ sample, coordinateInfo: undefined, plane, thickness: 0.2 });
    const identity = selectScanBand({
      sample, coordinateInfo: undefined, plane, thickness: 0.2, model: translation(0, 0, 0),
    });
    assert.strictEqual(bare.totalInBand, 1);
    assert.strictEqual(identity.totalInBand, 1);
    assert.deepStrictEqual(identity.points[0].point, bare.points[0].point);
  });

  it('emits the transformed point, so the count pass and the collect pass agree', () => {
    // Both passes must read the point through the same transform; if only
    // the band test were transformed, totalInBand and points.length would
    // disagree (or the drawn dot would be at the untransformed spot).
    const sample: ScanPointSample = { positions: new Float32Array([3, 0, 0]), count: 1 };
    const out = selectScanBand({
      sample, coordinateInfo: undefined, plane, thickness: 0.2, model: translation(0, 5, 0),
    });
    assert.strictEqual(out.totalInBand, 1);
    assert.strictEqual(out.points.length, 1);
    close(out.points[0].point.x, 3);
  });
});

/**
 * Double-shift regression (#1889 review, Codex P1).
 *
 * `computePointCloudAlignment` folds the ENTIRE viewer shift into
 * `decodeOriginOffset`, so `alignedMatrix` lands directly in the render
 * frame with a zero translation column. Applying the render-frame shift on
 * top of it subtracts that shift twice and displaces the overlay by the
 * model's full RTC/origin offset — which, at map magnitudes, means the
 * section selects nothing at all.
 *
 * The original tests for the aligned path all passed
 * `coordinateInfo: undefined`, making the shift zero and the double
 * subtraction invisible. These use a NON-ZERO shift on purpose.
 */
describe('selectScanBand — aligned matrices must not be shifted twice', () => {
  const coordinateInfo = {
    wasmRtcOffset: { x: 1000, y: 2000, z: 5 },
    originShift: { x: 3, y: 9, z: -7 },
  } as never;

  function translation(x: number, y: number, z: number): Float32Array {
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
  }

  it('an aligned matrix output is used as-is (already render-frame)', () => {
    // The matrix puts the point at render-frame y=5, so a band at y=5
    // must select it — with the shift applied again it would land at
    // y = 5 - shift.y and be missed entirely.
    const sample: ScanPointSample = { positions: new Float32Array([0, 0, 0]), count: 1 };
    const out = selectScanBand({
      sample,
      coordinateInfo,
      plane: { axis: 'y', position: 5, flipped: false },
      thickness: 0.2,
      model: translation(0, 5, 0),
      modelOutputsRenderFrame: true,
    });
    assert.strictEqual(out.totalInBand, 1, 'aligned output must not be shifted a second time');
    close(out.points[0].point.x, 0);
  });

  it('an UNALIGNED matrix output still gets the render-frame shift', () => {
    // `unalignedMatrix` restores absolute native coordinates, so the
    // world -> render-frame shift still applies. Point lands at
    // render-frame y = 5 - shift.y, where shift.y = rtc.z + originShift.y.
    const shift = pointCloudRenderFrameShift(coordinateInfo);
    const sample: ScanPointSample = { positions: new Float32Array([0, 0, 0]), count: 1 };
    const out = selectScanBand({
      sample,
      coordinateInfo,
      plane: { axis: 'y', position: 5 - shift.y, flipped: false },
      thickness: 0.2,
      model: translation(0, 5, 0),
      modelOutputsRenderFrame: false,
    });
    assert.strictEqual(out.totalInBand, 1, 'unaligned output must still be shifted into the render frame');
  });

  it('no matrix at all is unaffected by the flag', () => {
    const shift = pointCloudRenderFrameShift(coordinateInfo);
    const sample: ScanPointSample = { positions: new Float32Array([0, 5, 0]), count: 1 };
    const out = selectScanBand({
      sample,
      coordinateInfo,
      plane: { axis: 'y', position: 5 - shift.y, flipped: false },
      thickness: 0.2,
    });
    assert.strictEqual(out.totalInBand, 1, 'raw cached points still take the render-frame shift');
  });
});
