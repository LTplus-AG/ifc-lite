/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Snap + constraint engine: shared types (charter #6232, WP3).
 *
 * The engine works in WORKPLANE-LOCAL 2D (metres) plus an optional elevation,
 * so one solver serves both the 3D viewport (ray ∩ workplane) and the 2D plan.
 * Nothing here knows about the DOM, the renderer or the store: candidate
 * producers are `SnapSource`s, and the caller maps `local` back to render space.
 */

/** Workplane-local 2D point, metres. */
export type Vec2 = readonly [number, number];
/** Render-space 3D point (viewer Y-up). */
type Vec3 = readonly [number, number, number];

export type SnapKind =
  | 'endpoint'
  | 'midpoint'
  | 'vertex'
  | 'edge'
  | 'face'
  | 'intersection'
  | 'perpendicular'
  | 'extension'
  | 'parallel'
  | 'grid'
  | 'workplane';

/** Why a guide exists; drives how the HUD draws it. */
type GuideRole = 'edge' | 'extension' | 'axis' | 'perpendicular' | 'parallel' | 'lock';

/**
 * A construction guide in workplane-local 2D. Linear guides carry an origin and
 * a direction that need NOT be unit length: keeping the raw segment delta
 * (`b - a`) makes intersections of axis-aligned or integer-coordinate guides
 * exact instead of normalisation-rounded.
 */
export type Guide =
  | { kind: 'segment'; a: Vec2; b: Vec2; role: GuideRole }
  | { kind: 'line'; origin: Vec2; dir: Vec2; role: GuideRole }
  | { kind: 'ray'; origin: Vec2; dir: Vec2; role: GuideRole }
  | { kind: 'circle'; center: Vec2; radius: number; role: GuideRole };

export interface SnapCandidate {
  kind: SnapKind;
  /** The snap target itself (for an edge: the closest point on it to the cursor). */
  local: Vec2;
  elevation?: number;
  source: 'mesh' | 'semantic' | 'linework' | 'grid' | 'inference';
  entity?: { modelId: string; expressId: number };
  /**
   * The geometry the target lies on. For edge-like kinds (edge, extension,
   * parallel) the solver slides the target along this guide when a lock is
   * active, instead of projecting `local` onto the lock.
   */
  guide?: Guide;
  /** Extra display-only guides explaining an inferred target (e.g. both lines of an intersection). */
  trace?: readonly Guide[];
}

export interface SnapQuery {
  /** Raw cursor on the workplane. */
  cursor: Vec2;
  /** Screen-to-world scale at the cursor; converts the profile's pixel radii. */
  metresPerPixel: number;
  /** Previous committed point of the gesture (length/angle/axis/ortho are relative to it). */
  anchor: Vec2 | null;
  /** Points committed so far in the current gesture (polyline), oldest first. */
  chain: readonly Vec2[];
  /** shift = ortho / angle-step lock; alt = suspend snapping (locks still apply). */
  modifiers: { shift: boolean; alt: boolean };
  /** Typed locks. Each needs an anchor; without one they are ignored. */
  locks: { length?: number; angleDeg?: number; axis?: 'u' | 'v' };
}

/**
 * A candidate producer. `collect` appends into `out` (no allocation of an
 * intermediate array per source). A source SHOULD return candidates within
 * `radius` of `q.cursor` but MAY over-collect: the solver enforces the radius
 * after projecting onto the active lock, and far edges still feed inference
 * (extension / intersection tracking). Under a lock the solver passes the
 * cursor already projected onto the lock, because that is where the result
 * lands and what the radius is measured from.
 */
export interface SnapSource {
  id: string;
  collect(q: SnapQuery, radius: number, out: SnapCandidate[]): void;
}

export interface SnapProfile {
  /** Snap radius in screen pixels. */
  radiusPx: number;
  /** Priority tiers, best first. Within a tier the nearest target wins. Unlisted kinds never snap. */
  tiers: readonly (readonly SnapKind[])[];
  /**
   * Tiers used instead of `tiers` while a lock (ortho, typed length/angle/axis)
   * is active. Lets a profile rank purely by distance along the lock.
   */
  lockedTiers?: readonly (readonly SnapKind[])[];
  /** Source ids this profile consults. */
  sources: readonly string[];
  /** Shift quantises the direction from the anchor to multiples of this (default 90 = ortho). */
  angleStepDeg?: number;
  /** A held winner survives until it is this many pixels beyond the radius or beaten by this margin. */
  hysteresisPx?: number;
}

export interface SnapResult {
  /** The solved point, on the active lock. */
  local: Vec2;
  /** Filled by callers that own a workplane; the solver never sets it. */
  render?: Vec3;
  /** The target snapped to, as collected (its `local` is the target, not the solved point). */
  winner: SnapCandidate | null;
  /** Lock guide first, then the winner's guide and trace. */
  guides: Guide[];
  /** True when a lock constrained the result. */
  locked: boolean;
}
