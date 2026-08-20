/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Fixtures here are deliberately OFF-ORIGIN and on a TILTED plane, and the
 * "known arc" fixture is a coarse, sparsely-sampled tessellation of a real
 * circle rather than a dense/exact ring: a fixture centred at the origin with
 * points placed by angle alone cannot distinguish a correct plane-projection
 * + Kasa fit from one that silently assumes the XY plane or a centroid of
 * zero, so every case below is built off-origin, off-axis, and (for the
 * straight-run case) mirrors the actual tessellation-fragment shape #2199
 * reported rather than a synthetic straight line.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  fitRadius,
  formatRadius,
  MIN_RADIUS_POINTS,
  SAGITTA_FLOOR_M,
  type Point3,
} from './radius';

const near = (a: number, b: number, tol: number) =>
  assert.ok(Math.abs(a - b) < tol, `expected ~${b}, got ${a} (tol ${tol})`);

/** Orthonormal in-plane basis for an arbitrary (non axis-aligned) normal. */
function planeBasis(normal: Point3): { u: Point3; v: Point3 } {
  const n = Math.hypot(normal.x, normal.y, normal.z);
  const nn = { x: normal.x / n, y: normal.y / n, z: normal.z / n };
  const seed = Math.abs(nn.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const uRaw = {
    x: seed.y * nn.z - seed.z * nn.y,
    y: seed.z * nn.x - seed.x * nn.z,
    z: seed.x * nn.y - seed.y * nn.x,
  };
  const uLen = Math.hypot(uRaw.x, uRaw.y, uRaw.z);
  const u = { x: uRaw.x / uLen, y: uRaw.y / uLen, z: uRaw.z / uLen };
  const v = {
    x: nn.y * u.z - nn.z * u.y,
    y: nn.z * u.x - nn.x * u.z,
    z: nn.x * u.y - nn.y * u.x,
  };
  return { u, v };
}

/** `count` points evenly spaced across [startAngle, endAngle] on a real circle. */
function pointsOnCircle(
  center: Point3,
  radius: number,
  normal: Point3,
  startAngle: number,
  endAngle: number,
  count: number,
): Point3[] {
  const { u, v } = planeBasis(normal);
  const pts: Point3[] = [];
  for (let i = 0; i < count; i++) {
    const a = startAngle + ((endAngle - startAngle) * i) / (count - 1);
    const c = Math.cos(a) * radius;
    const s = Math.sin(a) * radius;
    pts.push({
      x: center.x + u.x * c + v.x * s,
      y: center.y + u.y * c + v.y * s,
      z: center.z + u.z * c + v.z * s,
    });
  }
  return pts;
}

// An off-origin centre and a deliberately tilted, non axis-aligned normal —
// shared by every circular fixture below.
const CENTER: Point3 = { x: 104.25, y: -18.7, z: 6.4 };
const TILTED_NORMAL: Point3 = { x: 1, y: 2, z: 3 };

describe('fitRadius — genuine arc', () => {
  it('recovers a known off-origin radius from a coarse tessellated sample', () => {
    // 2.5 m radius, 6 points spanning a 90 degree arc — about the density
    // `calculate_circle_segments` gives a small circle profile (8-32
    // segments/full circle), not a dense idealised ring.
    const radius = 2.5;
    const pts = pointsOnCircle(CENTER, radius, TILTED_NORMAL, 0, Math.PI / 2, 6);
    const r = fitRadius(pts);
    assert.equal(r.kind, 'fitted');
    if (r.kind !== 'fitted') return;
    near(r.radiusM, radius, 1e-6);
    near(r.diameterM, radius * 2, 1e-6);
    assert.equal(r.source.kind, 'fitted-tessellation');
    if (r.source.kind === 'fitted-tessellation') assert.equal(r.source.pointCount, 6);
    // Residual for exact points on the analytic circle must be tiny — this
    // is what "the fit explains the data" looks like.
    assert.ok(r.residualM < 1e-9, `residual should be ~0, got ${r.residualM}`);
  });

  it('does not depend on the order the arc was picked in', () => {
    const pts = pointsOnCircle(CENTER, 1.8, TILTED_NORMAL, -0.6, 0.9, 5);
    const forward = fitRadius(pts);
    const reversed = fitRadius([...pts].reverse());
    const shuffled = fitRadius([pts[2], pts[0], pts[4], pts[1], pts[3]]);
    assert.equal(forward.kind, 'fitted');
    assert.equal(reversed.kind, 'fitted');
    assert.equal(shuffled.kind, 'fitted');
    if (forward.kind === 'fitted' && reversed.kind === 'fitted' && shuffled.kind === 'fitted') {
      near(forward.radiusM, reversed.radiusM, 1e-9);
      near(forward.radiusM, shuffled.radiusM, 1e-9);
    }
  });

  it('formats a fitted radius with its tessellation provenance', () => {
    const pts = pointsOnCircle(CENTER, 2.5, TILTED_NORMAL, 0, Math.PI / 2, 6);
    const label = formatRadius(fitRadius(pts));
    assert.match(label, /R 2\.500 m/);
    assert.match(label, /D 5\.000 m/);
    assert.match(label, /fitted from 6 tessellation points/);
  });
});

describe('fitRadius — straight run refuses rather than reporting a huge radius', () => {
  it('refuses the exact four-collinear-tessellation-chord shape #2199 reported', () => {
    // Mirrors the reported fragmentation of one straight slab edge into four
    // collinear pieces (0.2000 / 1.8000 / 1.6000 / 0.2000 m), off-origin and
    // along a non axis-aligned direction — five collinear points, the same
    // shape a straight edge's tessellation chords actually produce.
    const origin: Point3 = { x: 52.4, y: 11.05, z: -3.2 };
    const dir = { x: 0.6, y: 0.48, z: 0.64 }; // unit vector, off-axis
    const cumulative = [0, 0.2, 2.0, 3.6, 3.8];
    const pts: Point3[] = cumulative.map((d) => ({
      x: origin.x + dir.x * d,
      y: origin.y + dir.y * d,
      z: origin.z + dir.z * d,
    }));

    const r = fitRadius(pts);
    assert.equal(r.kind, 'refused');
    if (r.kind === 'refused') {
      assert.equal(r.reason, 'no-curvature');
      assert.ok(r.sagittaM < SAGITTA_FLOOR_M, `sagitta ${r.sagittaM} should be under the floor`);
    }
    // The bug this guards against: a naive Kasa fit on this exact input
    // returns a "circle" — assert there is structurally no radius on this
    // outcome to report, not merely that we chose not to print one.
    assert.ok(!('radiusM' in r));
  });

  it('refuses a straight run even with floating-point jitter at the weld-tolerance floor', () => {
    // Realistic noise ceiling for a "straight" run: the snap/weld tolerance
    // (1/65536 m, see radius.ts's module doc) rather than exact collinearity.
    const WELD_TOLERANCE_M = 1 / 65536;
    const origin: Point3 = { x: -7.3, y: 40.1, z: 2.05 };
    const dir = { x: 0.8, y: -0.36, z: 0.48 };
    const jitter = [0, -1, 1, -1, 1].map((s) => s * WELD_TOLERANCE_M * 0.5);
    const cumulative = [0, 0.4, 1.1, 1.7, 2.0];
    const pts: Point3[] = cumulative.map((d, i) => ({
      x: origin.x + dir.x * d + jitter[i],
      y: origin.y + dir.y * d,
      z: origin.z + dir.z * d - jitter[i],
    }));

    const r = fitRadius(pts);
    assert.equal(r.kind, 'refused');
    if (r.kind === 'refused') assert.equal(r.reason, 'no-curvature');
  });

  it('formats a straight-run refusal as a stated non-measurement, not a number', () => {
    const pts: Point3[] = [0, 0.2, 2.0, 3.6, 3.8].map((d) => ({
      x: 10 + d * 0.6,
      y: -5 + d * 0.8,
      z: 3,
    }));
    const label = formatRadius(fitRadius(pts));
    assert.equal(label, 'Not circular (straight)');
  });
});

describe('fitRadius — gentle curve either side of the curvature floor', () => {
  // Fixed radius, sagitta controlled purely via the half-angle spanned —
  // s = R * (1 - cos(theta)) for points spanning [-theta, +theta].
  const R = 1000;
  const half = (targetSagitta: number) => Math.acos(1 - targetSagitta / R);

  it('just above the floor: fits (does not refuse)', () => {
    const theta = half(SAGITTA_FLOOR_M * 1.5);
    const pts = pointsOnCircle(CENTER, R, TILTED_NORMAL, -theta, theta, 5);
    const r = fitRadius(pts);
    assert.equal(r.kind, 'fitted', `expected fitted, got ${JSON.stringify(r)}`);
    if (r.kind === 'fitted') near(r.radiusM, R, 0.5);
  });

  it('just below the floor: refuses', () => {
    const theta = half(SAGITTA_FLOOR_M * 0.7);
    const pts = pointsOnCircle(CENTER, R, TILTED_NORMAL, -theta, theta, 5);
    const r = fitRadius(pts);
    assert.equal(r.kind, 'refused', `expected refused, got ${JSON.stringify(r)}`);
    if (r.kind === 'refused') assert.equal(r.reason, 'no-curvature');
  });
});

describe('fitRadius — poor circular fit is refused even with real curvature', () => {
  it('refuses points that curve but do not lie on one circle (an S-bend)', () => {
    // Enough aggregate deviation from the chord to clear the curvature floor,
    // but an inflection partway along (bulging one way, then the other) — no
    // single circle explains this, so the fit residual must be large. The
    // offsets are deliberately ASYMMETRIC about the midpoint: a symmetric
    // zigzag cancels in the plane-normal sum (Newell's method over a
    // perfectly antisymmetric sequence nets to ~0) and would be rejected for
    // "no curvature" before the fit — a real fixture, not a shortcut. this
    // one was checked directly against `fitRadius` to confirm it reaches the
    // fit and is refused there (`reason: 'poor-fit'`), not earlier.
    const origin: Point3 = { x: 3.1, y: 8.2, z: -1.4 };
    const dir = { x: 1, y: 0, z: 0 };
    const perp = { x: 0, y: 0, z: 1 };
    const bulge = SAGITTA_FLOOR_M * 20; // well above the curvature floor
    const offsets = [0, 1, 2, 1, -1, -2];
    const pts: Point3[] = offsets.map((s, i) => {
      const d = i * 0.3;
      return {
        x: origin.x + dir.x * d + perp.x * s * bulge,
        y: origin.y + dir.y * d + perp.y * s * bulge,
        z: origin.z + dir.z * d + perp.z * s * bulge,
      };
    });
    const r = fitRadius(pts);
    assert.equal(r.kind, 'refused', `expected refused, got ${JSON.stringify(r)}`);
    if (r.kind === 'refused') assert.equal(r.reason, 'poor-fit');
  });
});

describe('fitRadius — insufficient input', () => {
  it('refuses with too few points rather than fitting a circle through two', () => {
    const r = fitRadius([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }]);
    assert.equal(r.kind, 'insufficient-points');
    if (r.kind === 'insufficient-points') assert.equal(r.count, 2);
    assert.ok(MIN_RADIUS_POINTS === 3);
  });
});

describe('fitRadius — coincident points', () => {
  // Three (or near-three) identical picks -- the real-world shape of a user
  // clicking the same snap point twice by accident. `sagitta()` puts both of
  // its span endpoints at the same point when every point is identical, so
  // the chord has zero length and every point's distance from it is exactly
  // 0 -- this is caught by the SAGITTA floor, the same "no-curvature" gate
  // the collinear-run tests above exercise, well before the fit ever builds
  // the Kasa normal-equation matrix. It is not the determinant-degeneracy
  // guard (`Math.abs(det) < 1e-15`) that fires here: mutating that guard's
  // threshold to `1e15` (so it refuses almost everything) leaves this
  // exact-coincident case unchanged -- still refused via `no-curvature` with
  // `sagittaM: 0` -- while it does turn the module's own "genuine arc" tests
  // red, which confirms the determinant guard is real and reachable, just
  // not on this input. See the RED/GREEN notes in the PR/commit for the
  // verification.
  const CENTER: Point3 = { x: 104.25, y: -18.7, z: 6.4 };

  it('refuses three exactly-coincident points as having no curvature, not a fit error or a crash', () => {
    const pts: Point3[] = [CENTER, CENTER, CENTER];
    const r = fitRadius(pts);
    assert.equal(r.kind, 'refused');
    if (r.kind === 'refused') {
      assert.equal(r.reason, 'no-curvature');
      assert.equal(r.sagittaM, 0);
    }
    assert.ok(!('radiusM' in r));
  });

  it('refuses near-coincident points (float noise around one snap point) the same way', () => {
    // The reachable real-world case: a user clicking twice on the same snap
    // point, landing within float noise rather than exactly on it.
    const jitter = 1e-9;
    const pts: Point3[] = [
      CENTER,
      { x: CENTER.x + jitter, y: CENTER.y, z: CENTER.z },
      { x: CENTER.x, y: CENTER.y + jitter, z: CENTER.z - jitter },
    ];
    const r = fitRadius(pts);
    assert.equal(r.kind, 'refused');
    if (r.kind === 'refused') {
      assert.equal(r.reason, 'no-curvature');
      assert.ok(r.sagittaM < SAGITTA_FLOOR_M, `sagitta ${r.sagittaM} should be under the floor`);
    }
  });

  it('formats a coincident-points refusal as a stated non-measurement, not a number', () => {
    const label = formatRadius(fitRadius([CENTER, CENTER, CENTER]));
    assert.equal(label, 'Not circular (straight)');
  });
});
