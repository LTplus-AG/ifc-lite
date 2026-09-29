/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  computeWallJoin,
  wallBodyLateralRange,
  wallBodyOutline,
  type PlanPoint,
  type WallJoin,
  type WallJoinWall,
} from './wall-join.js';

const DEG = Math.PI / 180;
const polar = (from: PlanPoint, angleDeg: number, length: number): PlanPoint =>
  [from[0] + Math.cos(angleDeg * DEG) * length, from[1] + Math.sin(angleDeg * DEG) * length];

/** The joined body of `wall` as a plan quad (counter-clockwise). */
function bodyQuad(wall: WallJoinWall): PlanPoint[] {
  const { corners, length } = wallBodyOutline(wall);
  const d: PlanPoint = [(wall.end[0] - wall.start[0]) / length, (wall.end[1] - wall.start[1]) / length];
  const n: PlanPoint = [-d[1], d[0]];
  return corners.map(([x, y]) => [wall.start[0] + x * d[0] + y * n[0], wall.start[1] + x * d[1] + y * n[1]]);
}

function inConvex(quad: PlanPoint[], p: PlanPoint): boolean {
  for (let i = 0; i < quad.length; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % quad.length];
    if ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) < 0) return false;
  }
  return true;
}

/**
 * A wall as a band between its two faces, independent of the join code: the
 * lateral range comes from thickness/alignment/offset, the rest from the raw
 * axis the test drew.
 */
function band(wall: WallJoinWall) {
  const len = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
  const d: PlanPoint = [(wall.end[0] - wall.start[0]) / len, (wall.end[1] - wall.start[1]) / len];
  const n: PlanPoint = [-d[1], d[0]];
  const [lo, hi] = wallBodyLateralRange(wall);
  const lateral = (p: PlanPoint) => (p[0] - wall.start[0]) * n[0] + (p[1] - wall.start[1]) * n[1];
  return {
    d, n, lo, hi, lateral,
    inside: (p: PlanPoint) => lateral(p) >= lo && lateral(p) <= hi,
    /** A face line (lateral = y) as a half-plane test: same side as `ref`. */
    sameSide: (y: number, ref: PlanPoint, p: PlanPoint) => Math.sign(lateral(p) - y) === Math.sign(lateral(ref) - y),
  };
}

/**
 * The ideal joined footprint near the joint `point`, from the walls as drawn:
 *  L    = (band A before B's outer face) ∪ (band B before A's outer face)
 *  T    = band of the through wall ∪ (band of the other on its own side of the through axis)
 *  butt = each band on its own side of the plane square to the axis at the joint
 * `farA`/`farB` are points well inside each wall, away from the joint.
 */
function expectedSolid(kind: WallJoin['kind'], a: WallJoinWall, b: WallJoinWall, farA: PlanPoint, farB: PlanPoint, throughIsA: boolean, point: PlanPoint) {
  const A = band(a);
  const B = band(b);
  if (kind === 'L') {
    // The outer face of B is the one farther from A's body, and vice versa.
    const outerB = B.lateral(farA) < 0 ? B.hi : B.lo;
    const outerA = A.lateral(farB) < 0 ? A.hi : A.lo;
    return (p: PlanPoint) =>
      (A.inside(p) && B.sameSide(outerB, farA, p)) || (B.inside(p) && A.sameSide(outerA, farB, p));
  }
  if (kind === 'T') {
    const [R, W, farW, wall] = throughIsA ? [A, B, farB, a] : [B, A, farA, b];
    const axisY = (p: PlanPoint) => (p[0] - wall.start[0]) * R.n[0] + (p[1] - wall.start[1]) * R.n[1];
    return (p: PlanPoint) => R.inside(p) || (W.inside(p) && Math.sign(axisY(p)) === Math.sign(axisY(farW)));
  }
  const along = (p: PlanPoint) => (p[0] - point[0]) * A.d[0] + (p[1] - point[1]) * A.d[1];
  return (p: PlanPoint) =>
    (A.inside(p) && Math.sign(along(p)) === Math.sign(along(farA))) || (B.inside(p) && Math.sign(along(p)) === Math.sign(along(farB)));
}

/**
 * Sample a jittered grid around the joint: every point of the ideal footprint
 * must be in exactly one joined body (no gap, no overlap), every other point in
 * none (no spur past the corner).
 */
function expectClean(join: WallJoin, a: WallJoinWall, b: WallJoinWall, farA: PlanPoint, farB: PlanPoint, radius = 0.9) {
  const quads = [bodyQuad(join.a.wall), bodyQuad(join.b.wall)];
  const solid = expectedSolid(join.kind, a, b, farA, farB, join.relating === 'a', join.point);
  const failures: string[] = [];
  let solidCount = 0;
  const step = 0.0173;
  for (let dx = -radius + 0.00731; dx < radius; dx += step) {
    for (let dy = -radius + 0.00419; dy < radius; dy += step) {
      const p: PlanPoint = [join.point[0] + dx, join.point[1] + dy];
      const count = quads.filter((q) => inConvex(q, p)).length;
      const want = solid(p) ? 1 : 0;
      solidCount += want;
      if (count !== want && failures.length < 5) failures.push(`(${p[0].toFixed(3)}, ${p[1].toFixed(3)}): ${count} bodies, want ${want}`);
    }
  }
  expect(failures).toEqual([]);
  expect(solidCount).toBeGreaterThan(100);
}

describe('computeWallJoin: L corner', () => {
  it('at 90 degrees: the through wall reaches the outer face, the other stops at the inner face', () => {
    const a: WallJoinWall = { start: [-5, 0], end: [0, 0], thickness: 0.2 };
    const b: WallJoinWall = { start: [0, 0], end: [0, 5], thickness: 0.2 };
    const join = computeWallJoin(a, b);
    expect(join.kind).toBe('L');
    expect(join.relating).toBe('a');
    expect(join.point[0]).toBeCloseTo(0, 12);
    expect(join.point[1]).toBeCloseTo(0, 12);
    expect(join.a).toMatchObject({ connection: 'ATEND', runsThrough: true });
    expect(join.b).toMatchObject({ connection: 'ATSTART', runsThrough: false });
    expect(join.a.wall.endCut!.left).toBeCloseTo(0.1, 12);
    expect(join.a.wall.endCut!.right).toBeCloseTo(0.1, 12);
    expect(join.b.wall.startCut!.left).toBeCloseTo(-0.1, 12);
    expect(join.b.wall.startCut!.right).toBeCloseTo(-0.1, 12);
    expect(wallBodyOutline(join.a.wall).rectangular).toBe(true);
    expect(wallBodyOutline(join.b.wall).rectangular).toBe(true);
    expectClean(join, a, b, [-3, 0], [0, 3]);
  });

  it('the thicker wall runs through unless priority says otherwise', () => {
    const a: WallJoinWall = { start: [-5, 0], end: [0, 0], thickness: 0.2 };
    const b: WallJoinWall = { start: [0, 0], end: [0, 5], thickness: 0.4 };
    expect(computeWallJoin(a, b).relating).toBe('b');
    const forced = computeWallJoin(a, b, { priority: 'a' });
    expect(forced.relating).toBe('a');
    expect(forced.a.runsThrough).toBe(true);
    expect(forced.a.wall.endCut!.left).toBeCloseTo(0.2, 12);
    expectClean(forced, a, b, [-3, 0], [0, 3]);
  });

  const angles = [20, 45, 60, 90, 110, 135, 160];
  const orientations = [
    { name: 'end-start', flipA: false, flipB: false },
    { name: 'start-start', flipA: true, flipB: false },
    { name: 'end-end', flipA: false, flipB: true },
    { name: 'start-end', flipA: true, flipB: true },
  ];
  for (const angle of angles) {
    for (const o of orientations) {
      it(`at ${angle} degrees (${o.name}), equal thickness, any rotation`, () => {
        const corner: PlanPoint = [3.2, -1.7];
        const rot = 17 + angle;
        const farA = polar(corner, rot + 180, 5);
        const farB = polar(corner, rot + 180 - angle, 5);
        const a: WallJoinWall = o.flipA ? { start: corner, end: farA, thickness: 0.25 } : { start: farA, end: corner, thickness: 0.25 };
        const b: WallJoinWall = o.flipB ? { start: farB, end: corner, thickness: 0.25 } : { start: corner, end: farB, thickness: 0.25 };
        const join = computeWallJoin(a, b);
        expect(join.kind).toBe('L');
        expect(join.a.connection).toBe(o.flipA ? 'ATSTART' : 'ATEND');
        expect(join.b.connection).toBe(o.flipB ? 'ATEND' : 'ATSTART');
        expect(wallBodyOutline(join.a.wall).rectangular).toBe(angle === 90);
        expectClean(join, a, b, polar(corner, rot + 180, 3), polar(corner, rot + 180 - angle, 3));
      });
    }
  }

  it.each([30, 75, 90, 125])('at %i degrees with a thickness mismatch and offset alignments', (angle) => {
    const corner: PlanPoint = [0, 0];
    const a: WallJoinWall = { start: polar(corner, 180, 5), end: corner, thickness: 0.3, alignment: 'left' };
    const b: WallJoinWall = { start: corner, end: polar(corner, 180 - angle, 5), thickness: 0.12, alignment: 'right', offset: 0.02 };
    for (const priority of ['a', 'b'] as const) {
      const join = computeWallJoin(a, b, { priority, tolerance: 0.5 });
      expect(join.relating).toBe(priority);
      expectClean(join, a, b, polar(corner, 180, 3), polar(corner, 180 - angle, 3));
    }
  });

  it('snaps axis ends drawn short of or past the corner onto the crossing', () => {
    const a: WallJoinWall = { start: [-5, 0], end: [-0.1, 0], thickness: 0.2 };
    const b: WallJoinWall = { start: [0, -0.15], end: [0, 5], thickness: 0.2 };
    const join = computeWallJoin(a, b);
    expect(join.a.wall.end).toEqual([0, 0]);
    expect(join.b.wall.start[0]).toBeCloseTo(0, 12);
    expect(join.b.wall.start[1]).toBeCloseTo(0, 12);
    expectClean(join, a, b, [-3, 0], [0, 3]);
  });

  it('keeps the cut already on the other end', () => {
    const a: WallJoinWall = { start: [-5, 0], end: [0, 0], thickness: 0.2, startCut: { left: 0.1, right: 0.1 } };
    const b: WallJoinWall = { start: [0, 0], end: [0, 5], thickness: 0.2 };
    expect(computeWallJoin(a, b).a.wall.startCut).toEqual({ left: 0.1, right: 0.1 });
  });
});

describe('computeWallJoin: T', () => {
  it.each([90, 35, 70, 120, 150])('at %i degrees: the path wall runs through untouched', (angle) => {
    const r: WallJoinWall = { start: [-4, 1], end: [4, 1], thickness: 0.3 };
    const hit: PlanPoint = [0.6, 1];
    const far = polar(hit, angle, 5);
    // Drawn to the face of the through wall, not its axis.
    const drawnEnd = polar(hit, angle, 0.15 / Math.sin(angle * DEG));
    const w: WallJoinWall = { start: far, end: drawnEnd, thickness: 0.2 };
    const join = computeWallJoin(r, w);
    expect(join.kind).toBe('T');
    expect(join.relating).toBe('a');
    expect(join.a).toMatchObject({ connection: 'ATPATH', runsThrough: true });
    expect(join.a.wall).toEqual(r);
    expect(join.b.connection).toBe('ATEND');
    expect(join.b.wall.end[0]).toBeCloseTo(hit[0], 12);
    expect(join.b.wall.end[1]).toBeCloseTo(hit[1], 12);
    expect(wallBodyOutline(join.b.wall).rectangular).toBe(angle === 90);
    expectClean(join, r, w, [-3, 1], polar(hit, angle, 3));
  });

  it('with the ending wall first, a thickness mismatch and offset bodies on both', () => {
    const r: WallJoinWall = { start: [0, -4], end: [0, 4], thickness: 0.4, alignment: 'right', offset: -0.05 };
    const w: WallJoinWall = { start: [0, 0.5], end: polar([0, 0.5], 200, 5), thickness: 0.15, alignment: 'left' };
    const join = computeWallJoin(w, r);
    expect(join.kind).toBe('T');
    expect(join.relating).toBe('b');
    expect(join.a.connection).toBe('ATSTART');
    expect(join.b.connection).toBe('ATPATH');
    expectClean(join, w, r, polar([0, 0.5], 200, 3), [0, 3]);
  });

  it('works for a T from the right-hand side of the through wall', () => {
    const r: WallJoinWall = { start: [4, 0], end: [-4, 0], thickness: 0.3, offset: 0.1 };
    const w: WallJoinWall = { start: [1, -5], end: [1, 0], thickness: 0.2 };
    const join = computeWallJoin(r, w);
    expectClean(join, r, w, [-3, 0], [1, -3]);
  });
});

describe('computeWallJoin: butt (in line)', () => {
  it('meets square at the shared point, with a thickness mismatch and offset', () => {
    const a: WallJoinWall = { start: [0, 0], end: [3, 0], thickness: 0.3 };
    const b: WallJoinWall = { start: [3.05, 0], end: [6, 0], thickness: 0.2, alignment: 'left' };
    const join = computeWallJoin(a, b);
    expect(join.kind).toBe('butt');
    expect(join.point[0]).toBeCloseTo(3.025, 12);
    expect(join.a).toMatchObject({ connection: 'ATEND', runsThrough: false });
    expect(join.b).toMatchObject({ connection: 'ATSTART', runsThrough: false });
    expect(join.a.wall.endCut).toEqual({ left: 0, right: 0 });
    expect(join.b.wall.startCut).toEqual({ left: 0, right: 0 });
    expectClean(join, a, b, [1, 0], [5, 0]);
  });

  it.each([0, 33, 127, 251])('at %i degrees, anti-parallel (end to end)', (angle) => {
    const p: PlanPoint = [2, 2];
    const a: WallJoinWall = { start: polar(p, angle + 180, 4), end: p, thickness: 0.2, offset: 0.05 };
    const b: WallJoinWall = { start: polar(p, angle, 4), end: p, thickness: 0.25 };
    const join = computeWallJoin(a, b, { priority: 'b' });
    expect(join.kind).toBe('butt');
    expect(join.relating).toBe('b');
    expect(join.b.connection).toBe('ATEND');
    expectClean(join, a, b, polar(p, angle + 180, 3), polar(p, angle, 3));
  });
});

describe('computeWallJoin: refusals', () => {
  it('refuses crossing walls', () => {
    expect(() => computeWallJoin(
      { start: [-2, 0], end: [2, 0], thickness: 0.2 },
      { start: [0, -2], end: [0, 2], thickness: 0.2 },
    )).toThrow(/cross/);
  });
  it('refuses walls that do not reach each other', () => {
    expect(() => computeWallJoin(
      { start: [-5, 0], end: [-2, 0], thickness: 0.2 },
      { start: [0, 1], end: [0, 5], thickness: 0.2 },
    )).toThrow(/do not meet/);
  });
  it('refuses parallel walls that are not in line', () => {
    expect(() => computeWallJoin(
      { start: [0, 0], end: [3, 0], thickness: 0.2 },
      { start: [3, 0.5], end: [6, 0.5], thickness: 0.2 },
    )).toThrow(/not in line/);
  });
  it('refuses in-line walls that overlap', () => {
    expect(() => computeWallJoin(
      { start: [0, 0], end: [3, 0], thickness: 0.2 },
      { start: [2, 0], end: [6, 0], thickness: 0.2 },
    )).toThrow(/end to end/);
  });
  it('refuses a corner that leaves a wall with no body', () => {
    expect(() => computeWallJoin(
      { start: [-5, 0], end: [0, 0], thickness: 2 },
      { start: [0, 0], end: [0, 0.5], thickness: 0.2 },
      { priority: 'a' },
    )).toThrow(/too short/);
  });
  it('refuses bad input', () => {
    const ok: WallJoinWall = { start: [0, 0], end: [1, 0], thickness: 0.2 };
    expect(() => computeWallJoin({ ...ok, thickness: 0 }, ok)).toThrow(/thickness/);
    expect(() => computeWallJoin({ ...ok, end: [0, 0] }, ok)).toThrow(/distinct/);
    expect(() => computeWallJoin({ ...ok, start: [Number.NaN, 0] }, ok)).toThrow(/non-finite/);
    expect(() => computeWallJoin(ok, { start: [1, 0], end: [1, 1], thickness: 0.2 }, { tolerance: -1 })).toThrow(/tolerance/);
  });
});

describe('wallBodyOutline', () => {
  it('puts the axis on the named face', () => {
    expect(wallBodyLateralRange({ thickness: 0.2 })).toEqual([-0.1, 0.1]);
    expect(wallBodyLateralRange({ thickness: 0.2, alignment: 'left' })).toEqual([-0.2, 0]);
    expect(wallBodyLateralRange({ thickness: 0.2, alignment: 'right' })).toEqual([0, 0.2]);
    const [lo, hi] = wallBodyLateralRange({ thickness: 0.2, offset: 0.05 });
    expect(lo).toBeCloseTo(-0.05, 12);
    expect(hi).toBeCloseTo(0.15, 12);
  });
  it('reports slanted ends as non-rectangular', () => {
    const outline = wallBodyOutline({ start: [0, 0], end: [4, 0], thickness: 0.2, endCut: { left: 0.1, right: -0.1 } });
    expect(outline.rectangular).toBe(false);
    expect(outline.corners).toEqual([[-0, -0.1], [3.9, -0.1], [4.1, 0.1], [-0, 0.1]]);
  });
});
