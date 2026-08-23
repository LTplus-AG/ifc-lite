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

/**
 * `MIN_SNAP_TOLERANCE` from `packages/renderer/src/snap-weld.ts` — the
 * weld/snap floor a real pick inherits, and the same constant the module doc
 * anchors its straight-run noise ceiling to.
 */
const MIN_SNAP_TOLERANCE = 1 / 65536;

/**
 * Push each point off the fixture's plane by a few multiples of the snap
 * tolerance, alternating sign — what a pick off a tessellated f32 mesh
 * actually looks like, as against `pointsOnCircle`'s output, which is
 * coplanar to float precision because it is built from an orthonormal basis.
 * Deterministic (no RNG): a fixture that only fails on some seeds is not a
 * fixture.
 */
function offPlane(points: Point3[], normal: Point3): Point3[] {
  const n = Math.hypot(normal.x, normal.y, normal.z);
  const nn = { x: normal.x / n, y: normal.y / n, z: normal.z / n };
  return points.map((p, i) => {
    const d = ((i % 3) + 1) * (i % 2 === 0 ? 1 : -1) * MIN_SNAP_TOLERANCE;
    return { x: p.x + nn.x * d, y: p.y + nn.y * d, z: p.z + nn.z * d };
  });
}

/** Every ordering of `items`. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) out.push([items[i], ...tail]);
  }
  return out;
}

const factorial = (n: number): number => (n <= 1 ? 1 : n * factorial(n - 1));

const SWEEP_RADIUS_M = 1.8;

/**
 * One off-plane arc per pick count a user actually reaches, with EVERY
 * ordering of its picks. 3 through 6 covers the tool's minimum, the count the
 * documented double-click finish produces by default, and two more; 6 picks is
 * 720 orders, so the whole sweep is a few thousand fits and runs in
 * milliseconds.
 */
function orderSweep(): { count: number; picks: Point3[]; orders: Point3[][] }[] {
  const arc = (86 * Math.PI) / 180;
  return [3, 4, 5, 6].map((count) => {
    const picks = offPlane(pointsOnCircle(CENTER, SWEEP_RADIUS_M, TILTED_NORMAL, 0, arc, count), TILTED_NORMAL);
    return { count, picks, orders: permutations(picks) };
  });
}

/** "ACBD"-style name for one ordering, so a failure says which click order broke. */
const labelOf = (picks: readonly Point3[], order: readonly Point3[]): string =>
  order.map((p) => String.fromCharCode(65 + picks.indexOf(p))).join('');

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

  it('does not depend on the order the arc was picked in — every order, at every pick count a user reaches', () => {
    // The predecessor of this test could not fail. It used FIVE picks, one of
    // the counts where the old Newell-over-the-click-sequence plane happens to
    // survive every ordering, and points straight off `pointsOnCircle`, which
    // builds from an orthonormal basis and so are coplanar to float precision
    // — neither condition holds in the running app. Four picks is what the
    // documented finish gesture produces by default (`handleRadiusClick`
    // appends on every click, a physical double-click fires click/click/
    // dblclick, and `finishRadius` drops the one trailing near-duplicate), and
    // real picks land on a tessellated f32 mesh after snapping, tens of
    // microns off any single plane. Under those two conditions the old plane
    // fit reported a 2 m arc as a 2.8 km one on 1 order in 3 — with BOTH gate
    // checks passing, because the sagitta never consults the plane and the
    // residual is near zero precisely because the points do sit on the huge
    // circle a collapsed basis fits them with.
    //
    // So: sweep EVERY ordering, at every count from the minimum up, with the
    // picks pushed off-plane by a realistic amount. And assert both
    // directions — a plane fit that refused these would pass an
    // orderings-agree test while being just as broken.
    for (const { count, picks, orders } of orderSweep()) {
      assert.equal(orders.length, factorial(count), `sweep must be exhaustive at ${count} picks`);
      for (const order of orders) {
        const where = `${count} picks, order ${labelOf(picks, order)}`;
        const got = fitRadius(order);
        assert.equal(got.kind, 'fitted', `${where}: refused a real arc`);
        if (got.kind !== 'fitted') continue;
        assert.ok(
          Math.abs(got.radiusM - SWEEP_RADIUS_M) < 1e-3,
          `${where}: reported ${got.radiusM} m for a ${SWEEP_RADIUS_M} m arc`,
        );
      }
    }
  });

  it('returns bit-identical numbers for every click order, not merely close ones', () => {
    // The companion to the sweep above, and a stricter claim than it: float
    // addition is not associative, so an implementation can be order-blind in
    // its MATHS and still wobble in its last bits by summing in click order.
    // `canonicalOrder` is what makes the answer identical instead of close,
    // and this is the assertion that holds it to that.
    for (const { count, picks, orders } of orderSweep()) {
      const first = fitRadius(orders[0]);
      assert.equal(first.kind, 'fitted');
      if (first.kind !== 'fitted') continue;
      for (const order of orders) {
        const got = fitRadius(order);
        if (got.kind !== 'fitted') continue; // the sweep above owns that failure
        const where = `${count} picks, order ${labelOf(picks, order)}`;
        assert.equal(got.radiusM, first.radiusM, `${where}: ${got.radiusM} m vs ${first.radiusM} m`);
        assert.equal(got.sagittaM, first.sagittaM, `${where}: sagitta differs`);
        assert.equal(got.residualM, first.residualM, `${where}: residual differs`);
      }
    }
  });

  it('fits the arc the same way whichever end the user started from, off-plane picks and all', () => {
    // The one concrete gesture from the report, kept as its own case so a
    // regression names itself: a 90 degree arc picked A, B, D, then back to
    // fill the gap at C.
    const abcd = offPlane(pointsOnCircle(CENTER, 2, TILTED_NORMAL, 0, Math.PI / 2, 4), TILTED_NORMAL);
    const inOrder = fitRadius(abcd);
    const gapLast = fitRadius([abcd[0], abcd[1], abcd[3], abcd[2]]);
    assert.equal(inOrder.kind, 'fitted');
    assert.equal(gapLast.kind, 'fitted');
    if (inOrder.kind !== 'fitted' || gapLast.kind !== 'fitted') return;
    near(inOrder.radiusM, 2, 1e-3);
    assert.equal(gapLast.radiusM, inOrder.radiusM);
  });

  it('accepts a perfect circle picked diametrically-opposite-pairs first', () => {
    // Exactly coplanar picks are where the old sum cancelled to EXACTLY zero
    // rather than merely collapsing: `planeNormal` returned null and the panel
    // rendered "Not circular (straight)" for a perfect circle. Clicking two
    // opposite points before the two between them is natural in a radius tool.
    const quad = pointsOnCircle(CENTER, 2, TILTED_NORMAL, 0, (3 * Math.PI) / 2, 4);
    const paired = fitRadius([quad[1], quad[3], quad[0], quad[2]]);
    assert.equal(paired.kind, 'fitted', 'a perfect circle must not be refused as straight');
    if (paired.kind !== 'fitted') return;
    near(paired.radiusM, 2, 1e-9);
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
    // offsets are ASYMMETRIC about the midpoint. That was load-bearing under
    // the original Newell plane fit — a symmetric zigzag cancelled in its sum
    // and was refused for "no curvature" before ever reaching the fit — and
    // it no longer is: checked directly, a symmetric and an antisymmetric
    // zigzag both reach the fit and are refused there too under the
    // covariance plane. The offsets stay as they are because the fixture
    // still exercises exactly what it was written for, which is the part
    // asserted below: this input is refused AT THE FIT, with
    // `reason: 'poor-fit'`, not earlier.
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

/**
 * The poor-fit gate was pinned only from the REFUSE side: every fitted
 * fixture above lies on the analytic circle to float precision (residual
 * ~1e-16, six thousand times under the budget) and every refused one misses
 * a single circle by centimetres. Nothing sat between them, so the gate's
 * SCALE was free — verified by mutation: dropping the `/ n` from
 * `Math.sqrt(sumSqResidual / n)`, which turns the RMS residual into a plain
 * sum-of-squares and tightens the gate by sqrt(n) (~2.2x at five picks),
 * left all 17 tests green. A user's noisy-but-genuinely-circular picks would
 * start reading "Not circular" with nothing red.
 *
 * These two put a fixture on each side of the budget, close enough that a
 * scale change of ~1.4x either way crosses it.
 */
describe('fitRadius — the poor-fit budget, from the accept side as well', () => {
  /**
   * An arc whose picks alternate `amp` inside and outside the true radius,
   * IN the fit plane (so `sagitta` and the plane fit are untouched and only
   * the circle residual moves). The RMS residual comes out at ~0.86*amp, so
   * `amp` is a dial that lands the measurement either side of the gate.
   */
  function radiallyNoisyArc(radius: number, count: number, arcRad: number, amp: number): Point3[] {
    const { u, v } = planeBasis(TILTED_NORMAL);
    const pts: Point3[] = [];
    for (let i = 0; i < count; i++) {
      const a = (arcRad * i) / (count - 1);
      const r = radius + (i % 2 === 0 ? amp : -amp);
      const c = Math.cos(a) * r;
      const s = Math.sin(a) * r;
      pts.push({
        x: CENTER.x + u.x * c + v.x * s,
        y: CENTER.y + u.y * c + v.y * s,
        z: CENTER.z + u.z * c + v.z * s,
      });
    }
    return pts;
  }

  /** `SAGITTA_FLOOR_M * RESIDUAL_BUDGET`; RESIDUAL_BUDGET (3) is not exported. */
  const RESIDUAL_BUDGET_M = SAGITTA_FLOOR_M * 3;
  const ARC_RAD = (86 * Math.PI) / 180;

  it('accepts picks whose residual sits just UNDER the budget, and reports it', () => {
    const r = fitRadius(radiallyNoisyArc(SWEEP_RADIUS_M, 5, ARC_RAD, 2e-4));
    assert.equal(r.kind, 'fitted', `expected a fit, got ${JSON.stringify(r)}`);
    if (r.kind !== 'fitted') return;
    near(r.radiusM, SWEEP_RADIUS_M, 1e-3);
    // Squarely inside the gate but nowhere near zero: this is the assertion
    // the sum-of-squares mutation fails, since it scales the residual by
    // sqrt(5) and pushes it past the budget (and past this bound).
    assert.ok(
      r.residualM > RESIDUAL_BUDGET_M * 0.4 && r.residualM < RESIDUAL_BUDGET_M * 0.8,
      `residual ${r.residualM} must sit in the upper half of the ${RESIDUAL_BUDGET_M} m budget, ` +
        'or the gate scale is unpinned again',
    );
  });

  it('refuses the same arc once the noise doubles and the residual clears the budget', () => {
    const r = fitRadius(radiallyNoisyArc(SWEEP_RADIUS_M, 5, ARC_RAD, 4e-4));
    assert.equal(r.kind, 'refused', `expected a refusal, got ${JSON.stringify(r)}`);
    if (r.kind !== 'refused') return;
    assert.equal(r.reason, 'poor-fit');
    assert.ok(
      r.residualM !== undefined && r.residualM > RESIDUAL_BUDGET_M,
      `a poor-fit refusal must carry the residual that caused it, got ${r.residualM}`,
    );
  });
});

describe('fitRadius — insufficient input', () => {
  it('refuses with too few points rather than fitting a circle through two', () => {
    const r = fitRadius([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }]);
    assert.equal(r.kind, 'insufficient-points');
    if (r.kind === 'insufficient-points') assert.equal(r.count, 2);
    assert.ok(MIN_RADIUS_POINTS === 3);
  });

  it('at exactly MIN_RADIUS_POINTS the fit-quality half of the gate has no reach', () => {
    // Not a wish — a pin on what the gate actually does, so the module doc
    // and the code cannot drift apart again. Three non-collinear points lie
    // exactly on one circle, so the fit interpolates rather than regresses:
    // `residualM` is zero whatever the picks are, and `poor-fit` is
    // unreachable at this count. Only the curvature check guards a three-pick
    // reading, which is why the module doc says so in as many words.
    const noisy = offPlane(pointsOnCircle(CENTER, 20, TILTED_NORMAL, 0, 0.015, 3), TILTED_NORMAL);
    const r = fitRadius(noisy);
    assert.equal(r.kind, 'fitted');
    if (r.kind !== 'fitted') return;
    assert.ok(r.residualM < 1e-12, `three picks interpolate exactly; residual was ${r.residualM}`);
    // The snap noise those three picks carry moves the reading by centimetres
    // on a 20 m radius, and nothing in the gate objects. `formatRadius` still
    // prints three decimals — the fit's precision, not the measurement's.
    assert.ok(Math.abs(r.radiusM - 20) > 1e-3, `expected the noise to move the reading, got ${r.radiusM}`);
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
