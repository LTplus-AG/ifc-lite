/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Wall joins (#6232 D1): where two straight walls meet, decide which one runs
 * through and how far each body extends past, or stops short of, its axis end,
 * so the two bodies meet with no overlap and no gap. Pure plan geometry: no
 * editor, no store.
 *
 * Three kinds, told apart by where the two axes' lines cross:
 *
 *  - `L`    both walls end at the crossing (a corner). One wall runs through
 *           to the outer corner, the other stops at its inner face.
 *  - `T`    one wall ends on the other's path. The path wall runs through
 *           unchanged, the ending wall stops at its near face.
 *  - `butt` the walls are collinear and meet end to end. Both stop square at
 *           the shared point, whatever their thicknesses or offsets.
 *
 * The joined end of each axis is snapped to the crossing, so a wall drawn to
 * the other's face (or a little short of it) gets an axis that meets the
 * other's axis, which is what `IfcRelConnectsPathElements` describes.
 *
 * A body end is a cut across the wall's thickness: how far the body reaches
 * past the axis end along its left face and along its right face. A right-angle
 * join or a butt join cuts square (both the same), so the body stays an
 * `IfcRectangleProfileDef`. At any other angle the cut runs along the other
 * wall's face, which a rectangle cannot follow: the body becomes a four-point
 * `IfcArbitraryClosedProfileDef`. It is still a butt join (one wall runs through,
 * the other stops at its face), not a mitre, and no boolean clipping is used.
 */

/** A point in the storey plan, metres. */
export type PlanPoint = [number, number];

/** Which face of the wall its axis runs along. `left`/`right` are relative to Start -> End. */
export type WallAlignment = 'center' | 'left' | 'right';

/** `IfcConnectionTypeEnum` values a wall join writes. */
export type WallConnectionType = 'ATSTART' | 'ATEND' | 'ATPATH';

/**
 * How far a wall body reaches past one end of its axis, in metres, measured
 * along the axis at each face. Positive extends past the end, negative trims
 * back from it. Equal values are a square cut.
 */
export interface WallEndCut {
  /** At the left face (left of Start -> End). */
  left: number;
  /** At the right face. */
  right: number;
}

/** A straight wall as the join sees it: plan axis, thickness and where the body sits across the axis. */
export interface WallJoinWall {
  start: PlanPoint;
  end: PlanPoint;
  /** Metres, > 0. */
  thickness: number;
  /** Default `center`. */
  alignment?: WallAlignment;
  /** Extra shift of the body across the axis, metres, positive to the left. Default 0. */
  offset?: number;
  /** Body end at Start. Default square at the axis end. */
  startCut?: WallEndCut;
  /** Body end at End. Default square at the axis end. */
  endCut?: WallEndCut;
}

export type WallJoinKind = 'L' | 'T' | 'butt';

export interface WallJoinSide {
  /** Where this wall takes part: the end that is joined, or its path for the through wall of a T. */
  connection: WallConnectionType;
  /** True for the wall whose body runs through the joint. */
  runsThrough: boolean;
  /** The wall after the join: joined end snapped to the joint, body cut there. The other end is kept as it was. */
  wall: WallJoinWall;
}

export interface WallJoin {
  kind: WallJoinKind;
  /** Where the axes meet, storey plan metres. */
  point: PlanPoint;
  /** The wall written as `RelatingElement`: the one that runs through (wall `a` for a butt join). */
  relating: 'a' | 'b';
  a: WallJoinSide;
  b: WallJoinSide;
}

export interface WallJoinOptions {
  /**
   * How far (metres, along each axis) an axis end may sit from the crossing and
   * still count as joined there. Default twice the larger thickness, which
   * covers a wall drawn to the other's face.
   */
  tolerance?: number;
  /**
   * Which wall runs through at an `L` corner, and is the relating wall of a
   * `butt` join. Default: the thicker wall, `a` on a tie. Ignored for a `T`,
   * where the path wall always runs through.
   */
  priority?: 'a' | 'b';
}

/** The wall body's plan outline in the wall's own frame: origin at Start, +X along the axis, +Y to the left. */
export interface WallBodyOutline {
  /** Right-start, right-end, left-end, left-start (counter-clockwise). */
  corners: [PlanPoint, PlanPoint, PlanPoint, PlanPoint];
  /** Both ends are square, so the outline is a rectangle. */
  rectangular: boolean;
  /** Axis length, Start to End. */
  length: number;
  /** Body extent across the axis. */
  yMin: number;
  yMax: number;
}

/** Directions closer to parallel than this (sine of the angle) are treated as parallel. */
const PARALLEL_SIN = 1e-6;
/** Length slack for "the same point" / "on the line" / "non-empty face". */
const LENGTH_EPS = 1e-9;
const SQUARE_EPS = 1e-9;

const sub = (a: PlanPoint, b: PlanPoint): PlanPoint => [a[0] - b[0], a[1] - b[1]];
const add = (a: PlanPoint, b: PlanPoint): PlanPoint => [a[0] + b[0], a[1] + b[1]];
const scale = (a: PlanPoint, s: number): PlanPoint => [a[0] * s, a[1] * s];
const dot = (a: PlanPoint, b: PlanPoint): number => a[0] * b[0] + a[1] * b[1];
const cross = (a: PlanPoint, b: PlanPoint): number => a[0] * b[1] - a[1] * b[0];

function assertWall(wall: WallJoinWall, label: string, op: string): void {
  const finite = [...wall.start, ...wall.end, wall.thickness, wall.offset ?? 0,
    wall.startCut?.left ?? 0, wall.startCut?.right ?? 0, wall.endCut?.left ?? 0, wall.endCut?.right ?? 0];
  if (finite.some((v) => !Number.isFinite(v))) throw new Error(`${op}: wall ${label} has a non-finite coordinate or dimension`);
  if (!(wall.thickness > 0)) throw new Error(`${op}: wall ${label} thickness must be positive`);
  if (Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]) <= LENGTH_EPS) {
    throw new Error(`${op}: wall ${label} Start and End must be distinct points`);
  }
  const alignment = wall.alignment ?? 'center';
  if (alignment !== 'center' && alignment !== 'left' && alignment !== 'right') {
    throw new Error(`${op}: wall ${label} alignment must be center, left or right; got ${String(alignment)}`);
  }
}

/** The body's extent across the axis, `[min, max]`, positive to the left of Start -> End. */
export function wallBodyLateralRange(wall: Pick<WallJoinWall, 'thickness' | 'alignment' | 'offset'>): [number, number] {
  const half = wall.thickness / 2;
  const alignment = wall.alignment ?? 'center';
  // The axis runs along the named face, so the body lies on the other side of it.
  const centre = (wall.offset ?? 0) + (alignment === 'left' ? -half : alignment === 'right' ? half : 0);
  return [centre - half, centre + half];
}

/**
 * The body outline of `wall` in its own frame. Throws when the cuts leave a
 * face with no length (the ends cross), which no single extrusion can build.
 */
export function wallBodyOutline(wall: WallJoinWall): WallBodyOutline {
  assertWall(wall, '', 'wallBodyOutline');
  const length = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
  const [yMin, yMax] = wallBodyLateralRange(wall);
  const s = wall.startCut ?? { left: 0, right: 0 };
  const e = wall.endCut ?? { left: 0, right: 0 };
  const corners: WallBodyOutline['corners'] = [
    [-s.right, yMin],
    [length + e.right, yMin],
    [length + e.left, yMax],
    [-s.left, yMax],
  ];
  if (corners[1][0] - corners[0][0] <= LENGTH_EPS || corners[2][0] - corners[3][0] <= LENGTH_EPS) {
    throw new Error('wallBodyOutline: the body ends cross; the wall is too short for this join');
  }
  const rectangular = Math.abs(s.left - s.right) <= SQUARE_EPS && Math.abs(e.left - e.right) <= SQUARE_EPS;
  return { corners, rectangular, length, yMin, yMax };
}

interface Frame {
  wall: WallJoinWall;
  origin: PlanPoint;
  dir: PlanPoint;
  /** Left normal of `dir`. */
  normal: PlanPoint;
  length: number;
  yMin: number;
  yMax: number;
}

function frameOf(wall: WallJoinWall): Frame {
  const d = sub(wall.end, wall.start);
  const length = Math.hypot(d[0], d[1]);
  const dir = scale(d, 1 / length);
  const [yMin, yMax] = wallBodyLateralRange(wall);
  return { wall, origin: wall.start, dir, normal: [-dir[1], dir[0]], length, yMin, yMax };
}

type Place = 'ATSTART' | 'ATEND' | 'ATPATH' | 'OFF';

/** Where parameter `s` (metres along the axis from Start) falls on a wall of `length`. */
function placeOn(s: number, length: number, tolerance: number): Place {
  const fromStart = Math.abs(s);
  const fromEnd = Math.abs(s - length);
  if (fromStart <= tolerance || fromEnd <= tolerance) return fromStart <= fromEnd ? 'ATSTART' : 'ATEND';
  return s > 0 && s < length ? 'ATPATH' : 'OFF';
}

/** Outward direction of the body at a joined end. */
function outward(f: Frame, end: 'ATSTART' | 'ATEND'): PlanPoint {
  return end === 'ATEND' ? f.dir : scale(f.dir, -1);
}

/**
 * The cut at a joined end of `f` that lies along the line through `linePoint`
 * with direction `lineDir`: distance past the axis end (the joint `p`) at each
 * face, measured outward.
 */
function cutAlong(f: Frame, end: 'ATSTART' | 'ATEND', p: PlanPoint, linePoint: PlanPoint, lineDir: PlanPoint): WallEndCut {
  const u = outward(f, end);
  const denom = cross(u, lineDir);
  // p + s·u + y·n = linePoint + r·lineDir  =>  s = cross(linePoint - p - y·n, lineDir) / cross(u, lineDir)
  const at = (y: number) => cross(sub(sub(linePoint, p), scale(f.normal, y)), lineDir) / denom;
  return { left: at(f.yMax), right: at(f.yMin) };
}

/** `f`'s wall with the joined end moved to `p` and cut by `cut`. */
function joinedWall(f: Frame, end: 'ATSTART' | 'ATEND', p: PlanPoint, cut: WallEndCut): WallJoinWall {
  const wall: WallJoinWall = end === 'ATSTART'
    ? { ...f.wall, start: [p[0], p[1]], startCut: cut }
    : { ...f.wall, end: [p[0], p[1]], endCut: cut };
  wallBodyOutline(wall);
  return wall;
}

/** Which side (+1 left, -1 right) of `f`'s axis the direction `v` points to. */
function sideOf(f: Frame, v: PlanPoint): 1 | -1 {
  return dot(v, f.normal) >= 0 ? 1 : -1;
}

/**
 * Join two straight walls. Works at any angle in plan; throws when the walls
 * do not meet within `tolerance`, when they cross (split one first), or when
 * they are parallel without being collinear and end to end.
 */
export function computeWallJoin(a: WallJoinWall, b: WallJoinWall, options: WallJoinOptions = {}): WallJoin {
  const op = 'computeWallJoin';
  assertWall(a, 'a', op);
  assertWall(b, 'b', op);
  const tolerance = options.tolerance ?? 2 * Math.max(a.thickness, b.thickness);
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error(`${op}: tolerance must be a finite, non-negative length`);
  if (options.priority !== undefined && options.priority !== 'a' && options.priority !== 'b') {
    throw new Error(`${op}: priority must be 'a' or 'b'`);
  }
  const fa = frameOf(a);
  const fb = frameOf(b);
  const denom = cross(fa.dir, fb.dir);

  if (Math.abs(denom) <= PARALLEL_SIN) return buttJoin(fa, fb, tolerance, options, op);

  const w = sub(fb.origin, fa.origin);
  const sA = cross(w, fb.dir) / denom;
  const sB = cross(w, fa.dir) / denom;
  const point = add(fa.origin, scale(fa.dir, sA));
  const placeA = placeOn(sA, fa.length, tolerance);
  const placeB = placeOn(sB, fb.length, tolerance);

  if (placeA === 'OFF' || placeB === 'OFF') {
    throw new Error(`${op}: the walls do not meet (their axes cross more than ${tolerance} m past an end)`);
  }
  if (placeA === 'ATPATH' && placeB === 'ATPATH') {
    throw new Error(`${op}: the walls cross each other; split one of them at the crossing first`);
  }

  if (placeA === 'ATPATH' || placeB === 'ATPATH') {
    // T: the path wall runs through untouched; the other stops at its near face.
    const throughIsA = placeA === 'ATPATH';
    const [fr, fw] = throughIsA ? [fa, fb] : [fb, fa];
    const endW = (throughIsA ? placeB : placeA) as 'ATSTART' | 'ATEND';
    const ending = endingSide(fr, fw, endW, point);
    const through: WallJoinSide = { connection: 'ATPATH', runsThrough: true, wall: { ...fr.wall } };
    return {
      kind: 'T',
      point,
      relating: throughIsA ? 'a' : 'b',
      a: throughIsA ? through : ending,
      b: throughIsA ? ending : through,
    };
  }

  // L: both walls end at the corner.
  const throughIsA = (options.priority ?? (b.thickness > a.thickness ? 'b' : 'a')) === 'a';
  const [fr, fw] = throughIsA ? [fa, fb] : [fb, fa];
  const [endR, endW] = (throughIsA ? [placeA, placeB] : [placeB, placeA]) as ['ATSTART' | 'ATEND', 'ATSTART' | 'ATEND'];
  const ending = endingSide(fr, fw, endW, point);
  // The through wall reaches the ending wall's outer face: the face on the far
  // side from where the through wall comes in.
  const comesFrom = sideOf(fw, scale(outward(fr, endR), -1));
  const outerY = comesFrom > 0 ? fw.yMin : fw.yMax;
  const cut = cutAlong(fr, endR, point, add(point, scale(fw.normal, outerY)), fw.dir);
  const through: WallJoinSide = { connection: endR, runsThrough: true, wall: joinedWall(fr, endR, point, cut) };
  return {
    kind: 'L',
    point,
    relating: throughIsA ? 'a' : 'b',
    a: throughIsA ? through : ending,
    b: throughIsA ? ending : through,
  };
}

/** The wall that stops at the through wall's face: the face on the side it comes in from. */
function endingSide(fr: Frame, fw: Frame, endW: 'ATSTART' | 'ATEND', point: PlanPoint): WallJoinSide {
  const comesFrom = sideOf(fr, scale(outward(fw, endW), -1));
  const faceY = comesFrom > 0 ? fr.yMax : fr.yMin;
  const cut = cutAlong(fw, endW, point, add(point, scale(fr.normal, faceY)), fr.dir);
  return { connection: endW, runsThrough: false, wall: joinedWall(fw, endW, point, cut) };
}

function buttJoin(fa: Frame, fb: Frame, tolerance: number, options: WallJoinOptions, op: string): WallJoin {
  const reach = Math.max(fa.length, fb.length);
  if (Math.abs(cross(sub(fb.origin, fa.origin), fa.dir)) > Math.max(1e-6 * reach, LENGTH_EPS)) {
    throw new Error(`${op}: the walls are parallel but not in line; a join needs the axes to meet`);
  }
  const ends = ['ATSTART', 'ATEND'] as const;
  const endPoint = (f: Frame, end: 'ATSTART' | 'ATEND') => (end === 'ATSTART' ? f.wall.start : f.wall.end);
  let best: { endA: 'ATSTART' | 'ATEND'; endB: 'ATSTART' | 'ATEND'; gap: number } | null = null;
  for (const endA of ends) {
    for (const endB of ends) {
      // End to end means the two bodies leave the joint in opposite directions.
      if (dot(outward(fa, endA), outward(fb, endB)) >= 0) continue;
      const gap = Math.hypot(...sub(endPoint(fa, endA), endPoint(fb, endB)));
      if (!best || gap < best.gap) best = { endA, endB, gap };
    }
  }
  // The ends must meet within tolerance, and the walls must not overlap along the line.
  const overlap = best
    ? dot(sub(endPoint(fb, best.endB), endPoint(fa, best.endA)), outward(fa, best.endA)) < -tolerance
    : true;
  if (!best || best.gap > tolerance || overlap) {
    throw new Error(`${op}: the walls are in line but do not meet end to end within ${tolerance} m`);
  }
  const pa = endPoint(fa, best.endA);
  const pb = endPoint(fb, best.endB);
  const point: PlanPoint = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
  const square: WallEndCut = { left: 0, right: 0 };
  const relating = options.priority ?? 'a';
  return {
    kind: 'butt',
    point,
    relating,
    a: { connection: best.endA, runsThrough: false, wall: joinedWall(fa, best.endA, point, square) },
    b: { connection: best.endB, runsThrough: false, wall: joinedWall(fb, best.endB, point, square) },
  };
}
