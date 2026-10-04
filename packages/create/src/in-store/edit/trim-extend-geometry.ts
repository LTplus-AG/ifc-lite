/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The reach arithmetic behind `element.trimExtend` (charter #6232, C1): where
 * a wall's or beam's axis meets a boundary line, and whether that is a trim
 * (the boundary cuts across the element) or an extension (the element stops
 * short of it). Pure plan geometry: no store, no i18n.
 *
 * Everything is metres in the storey's local frame. A target is a straight
 * axis `p0 + dir · at`, `at` in 0..length; a beam may rise, so `dir` is 3D and
 * the crossing is found on its plan projection (a boundary is a vertical
 * plane). A boundary is a line through `a` and `b`, of which only the stretch
 * `tMin..tMax` (in units of `b - a`) exists: a wall's axis or a slab edge is a
 * segment, a grid axis a line.
 */

type Vec2 = readonly [number, number];
type Vec3 = [number, number, number];

/** The line a target is trimmed or extended to. */
export interface ReachBoundary {
  readonly a: Vec2;
  readonly b: Vec2;
  /** The stretch of the line that exists, in units of `b - a`; ±Infinity for a line without ends. */
  readonly tMin: number;
  readonly tMax: number;
  /** How far past `tMin` / `tMax` the crossing may fall and still count, metres (a wall's half thickness). */
  readonly reach: number;
}

/** A straight element axis. */
export interface ReachTarget {
  readonly p0: Vec3;
  /** Unit direction, start to end; may rise. */
  readonly dir: Vec3;
  readonly length: number;
}

export type ReachMode = 'trim' | 'extend';
export type ReachEnd = 'start' | 'end';

/** Why a target cannot reach the boundary; the command turns each into a sentence. */
export type ReachRefusal =
  /** The element runs along the boundary: they never cross. */
  | 'parallel'
  /** Vertical, so it has no plan axis to cross. */
  | 'vertical'
  /** The lines cross, but past the end of the boundary. */
  | 'boundaryShort'
  /** Extend, but the boundary cuts across the element: Shift trims. */
  | 'crossesInside'
  /** Trim, but the element ends before the boundary: Shift extends. */
  | 'notReached'
  /** Extend, but the boundary lies past the other end than the clicked one. */
  | 'otherEnd'
  /** Trim would leave less than the minimum length. */
  | 'tooShort'
  /** The end is already on the boundary and there is nothing to join. */
  | 'alreadyThere';

export type ReachPlan =
  | {
    readonly ok: true;
    /** `extend` also covers an end already on the boundary (a join without a move). */
    readonly op: ReachMode;
    /** The end that moves. */
    readonly end: ReachEnd;
    /** Distance from the current start to the moved end's new place, along `dir`. */
    readonly at: number;
    /** The new axis ends, storey-local. */
    readonly start: Vec3;
    readonly stop: Vec3;
    readonly length: number;
    /** Metres the end moves outward: positive extends, negative trims. */
    readonly moved: number;
    /** The crossing in plan. */
    readonly point: Vec2;
  }
  | { readonly ok: false; readonly reason: ReachRefusal };

/** A crossing this close to an end (metres) is AT that end. */
const AT_END = 1e-3;
/** Directions with a smaller sine between them are parallel. */
const PARALLEL_SIN = 1e-3;
/** A plan axis shorter than this per metre of axis is a vertical element. */
const MIN_PLAN_AXIS = 0.05;

export interface Crossing {
  /** Distance along the target from its start (may be negative or past the end). */
  readonly at: number;
  /** Position along the boundary, in units of `b - a`. */
  readonly t: number;
  readonly point: Vec2;
}

/** Where the target's axis line crosses the boundary line, or why it does not. */
export function crossing(target: ReachTarget, boundary: ReachBoundary): Crossing | ReachRefusal {
  const [dx, dy] = target.dir;
  const planLength = Math.hypot(dx, dy);
  if (planLength < MIN_PLAN_AXIS) return 'vertical';
  const bx = boundary.b[0] - boundary.a[0];
  const by = boundary.b[1] - boundary.a[1];
  const boundaryLength = Math.hypot(bx, by);
  if (!(boundaryLength > 1e-9)) return 'parallel';
  const denom = dx * by - dy * bx;
  if (Math.abs(denom) <= PARALLEL_SIN * planLength * boundaryLength) return 'parallel';
  const wx = boundary.a[0] - target.p0[0];
  const wy = boundary.a[1] - target.p0[1];
  // p0 + at·dir = a + t·(b - a), on the plan projection.
  const at = (wx * by - wy * bx) / denom;
  const t = (wx * dy - wy * dx) / denom;
  return { at, t, point: [boundary.a[0] + t * bx, boundary.a[1] + t * by] };
}

function onBoundary(boundary: ReachBoundary, t: number): boolean {
  const length = Math.hypot(boundary.b[0] - boundary.a[0], boundary.b[1] - boundary.a[1]);
  const slack = boundary.reach / length;
  return t >= boundary.tMin - slack && t <= boundary.tMax + slack;
}

/** The axis with the end at `at` moved to `to`: new start and end. */
function reshaped(target: ReachTarget, end: ReachEnd, to: number): { start: Vec3; stop: Vec3; length: number } {
  const from = end === 'start' ? to : 0;
  const upTo = end === 'end' ? to : target.length;
  const point = (s: number): Vec3 => [target.p0[0] + target.dir[0] * s, target.p0[1] + target.dir[1] * s, target.p0[2] + target.dir[2] * s];
  return { start: point(from), stop: point(upTo), length: upTo - from };
}

/**
 * Trim or extend `target` to `boundary`. `click` is where along the target
 * (metres from its start, clamped to the element) it was clicked.
 *
 *  - extend: the end nearest the click moves out to the boundary; it must be
 *    the end the boundary lies beyond.
 *  - trim: the boundary must cross the element; the side the click is on (the
 *    end nearest it) is removed, the far side stays.
 *
 * `joins` says the result is joined to the boundary (a wall to a wall): an end
 * already on the boundary is then a valid extension by nothing, which makes
 * the join; without it there is nothing to do and the plan is refused.
 */
export function planReach(
  target: ReachTarget,
  boundary: ReachBoundary,
  mode: ReachMode,
  click: number,
  minLength: number,
  joins: boolean,
): ReachPlan {
  const cross = crossing(target, boundary);
  if (typeof cross === 'string') return { ok: false, reason: cross };
  if (!onBoundary(boundary, cross.t)) return { ok: false, reason: 'boundaryShort' };
  const { at, point } = cross;
  const { length } = target;
  const clicked: ReachEnd = click < length / 2 ? 'start' : 'end';

  const done = (op: ReachMode, end: ReachEnd, to: number): ReachPlan => {
    const next = reshaped(target, end, to);
    return {
      ok: true, op, end, at: to, start: next.start, stop: next.stop, length: next.length,
      moved: end === 'end' ? to - length : -to, point,
    };
  };

  // An end already on the boundary: nothing moves, so only a join can come of it.
  const atStart = Math.abs(at) <= AT_END;
  const atEnd = Math.abs(at - length) <= AT_END;
  if (atStart || atEnd) {
    if (!joins) return { ok: false, reason: 'alreadyThere' };
    const end: ReachEnd = atStart && atEnd ? clicked : atStart ? 'start' : 'end';
    return done('extend', end, end === 'start' ? 0 : length);
  }

  if (mode === 'extend') {
    if (at > 0 && at < length) return { ok: false, reason: 'crossesInside' };
    const beyond: ReachEnd = at > length ? 'end' : 'start';
    if (beyond !== clicked) return { ok: false, reason: 'otherEnd' };
    return done('extend', beyond, at);
  }

  if (!(at > 0 && at < length)) return { ok: false, reason: 'notReached' };
  // The click's side of the crossing goes.
  const removed: ReachEnd = click < at ? 'start' : 'end';
  const left = removed === 'start' ? length - at : at;
  if (left < minLength) return { ok: false, reason: 'tooShort' };
  return done('trim', removed, at);
}

/** Distance along the target's plan axis line from its start to the projection of `p`, in axis metres, clamped to the element. */
export function clickAlong(target: ReachTarget, p: Vec2): number {
  const [dx, dy] = target.dir;
  const planLength = Math.hypot(dx, dy);
  const s = ((p[0] - target.p0[0]) * dx + (p[1] - target.p0[1]) * dy) / (planLength * planLength);
  return Math.min(target.length, Math.max(0, s));
}
