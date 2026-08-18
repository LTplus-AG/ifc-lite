/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Edge-to-edge and face-to-face angles (#2735, the two slices after
 * `three-point-angle.ts`).
 *
 * Pure display maths over stored picks, the `inclination.ts` precedent: nothing
 * but the picks is persisted, so a correction here retroactively fixes every
 * measurement already on screen.
 *
 * # Why edges are FOUR picks, not two
 *
 * @BIMvoice established on #2199 that `SnapTarget.metadata.vertices` yields
 * TESSELLATION SEGMENTS, not topological edges: one straight 2.000 m slab edge
 * on `IfcSlab #52` reported as four collinear pieces (0.2000 / 1.8000 / 1.6000
 * / 0.2000), with no cursor position anywhere yielding 2.000. So two picks
 * cannot identify two edges - two clicks on what the user sees as a single
 * edge can land on different segments, and the direction you get back is the
 * direction of a tessellation artefact.
 *
 * #2735 offers the way out explicitly: "state how it recovers a topological
 * edge from tessellation, OR scope itself to explicitly-picked point pairs".
 * This takes the second. Each edge is two picks the user places, so the
 * direction measured is the one they chose rather than one tessellation
 * happened to produce. #2655 (model edges reconstructed in the snap cache) is
 * groundwork for a two-pick version later, not a reason to ship a wrong one
 * now.
 *
 * # Why both answers fold to [0, 90]
 *
 * A line has no direction: picking A then B, or B then A, describes the same
 * edge, and a reading that changed with click order would be a bug the user
 * could reproduce at will. Likewise a plane has no side - the normal's sign is
 * an artefact of winding, which is unreliable on double-sided IFC meshes.
 *
 * So both modes report the UNSIGNED angle between two undirected things, in
 * [0, 90]. That is a complete answer to "what is the angle between these two
 * lines/planes" and it is reproducible.
 *
 * What is deliberately NOT offered is the INTERIOR dihedral (the 120 degrees of
 * an obtuse corner rather than the 60 between its planes). Recovering it needs
 * the shared edge and a consistent inside, and two independent face picks
 * supply neither: the same two normals describe a 60 degree roof ridge and a
 * 120 degree wall junction. Reporting one of them would be picking an answer
 * and hoping. Per #2735, "no format is offered for a measurement it does not
 * describe".
 *
 * The missing ingredient is specifically the SHARED EDGE, not the information
 * in general: face picks already carry the hit point as well as the normal, so
 * a later version that also captures which edge the two faces meet at has
 * enough to resolve the interior. It is deliberately not collected yet, rather
 * than unobtainable in principle.
 */

import { angleBetweenDeg, cross, norm, normalize, sub, type Point3 } from './angle-vec';

/**
 * Pick resolution: the snap layer's floor, `MIN_SNAP_TOLERANCE` in
 * `packages/renderer/src/snap-weld.ts` (1/65536 m = 15.3 um). Mirrored rather
 * than imported, exactly as `three-point-angle.ts` does, so this module stays
 * free of renderer types; the sibling test pins the two together.
 */
const PICK_RESOLUTION_M = 1 / 65536;

/**
 * An edge shorter than one pick resolution has a direction made entirely of
 * cursor noise. Tied to the snap floor rather than an arbitrary epsilon: a
 * threshold below the floor classifies nothing, because no reachable input can
 * land in the band.
 */
const DEGENERATE_LENGTH_M = PICK_RESOLUTION_M;

/**
 * Parallelism is judged by the SINE of the angle between the two directions,
 * which is `|a x b|` for unit vectors, not by a degree threshold on the result.
 *
 * Near 0 and 180 degrees the cross product is the quantity that actually loses
 * precision, so testing it directly is testing the thing that degrades. This
 * is the same reasoning `three-point-angle.ts` gives for judging collinearity
 * as a perpendicular distance rather than as an angle.
 *
 * 1e-6 is about 5.7e-5 degrees: far below anything a user can pick apart at the
 * one decimal these readouts render, and far above the f32 noise in a
 * normalised direction.
 */
const PARALLEL_SINE = 1e-6;

/** What an edge-pair or face-pair measurement resolved to. */
export type AnglePairOutcome =
  | { kind: 'degenerate'; reason: 'first' | 'second' | 'no-normal' }
  | { kind: 'parallel'; degrees: 0 }
  | { kind: 'angled'; degrees: number };

/**
 * Angle between two lines, each given as an ordered pair of picked points.
 *
 * Returns `degenerate` naming WHICH pair was unusable rather than a single
 * failure, because the two are different user errors: the first pair being
 * degenerate means the first edge was never really placed, and telling them
 * "the second one" would send them to the wrong click.
 */
export function edgePairAngle(
  a1: Point3,
  a2: Point3,
  b1: Point3,
  b2: Point3,
): AnglePairOutcome {
  const da = sub(a2, a1);
  const db = sub(b2, b1);
  if (norm(da) <= DEGENERATE_LENGTH_M) return { kind: 'degenerate', reason: 'first' };
  if (norm(db) <= DEGENERATE_LENGTH_M) return { kind: 'degenerate', reason: 'second' };
  return unsignedAngle(da, db);
}

/**
 * Angle between two planes, each given by a normal.
 *
 * The normals need not be unit length or consistently oriented; see the module
 * header on why the sign is discarded.
 */
export function facePairAngle(
  na: Point3 | undefined,
  nb: Point3 | undefined,
): AnglePairOutcome {
  // A stored face pick with no normal is an upstream bug, not a user error.
  // Substituting a zero vector here would classify it as `first`, which renders
  // as "First pick too short" - a message describing something a face pick
  // cannot even do, and one that makes a bug look like a measurement mistake.
  if (!na || !nb) return { kind: 'degenerate', reason: 'no-normal' };
  if (norm(na) <= 0 || !Number.isFinite(norm(na))) return { kind: 'degenerate', reason: 'first' };
  if (norm(nb) <= 0 || !Number.isFinite(norm(nb))) return { kind: 'degenerate', reason: 'second' };
  return unsignedAngle(na, nb);
}

/** Unsigned angle between two undirected directions, folded into [0, 90]. */
function unsignedAngle(a: Point3, b: Point3): AnglePairOutcome {
  const ua = normalize(a);
  const ub = normalize(b);
  if (!ua) return { kind: 'degenerate', reason: 'first' };
  if (!ub) return { kind: 'degenerate', reason: 'second' };

  // sin(theta) for unit vectors. Parallel and ANTI-parallel both give ~0 here,
  // which is what "undirected" means: they describe the same line or plane.
  if (norm(cross(ua, ub)) <= PARALLEL_SINE) return { kind: 'parallel', degrees: 0 };

  const raw = angleBetweenDeg(ua, ub);
  return { kind: 'angled', degrees: raw > 90 ? 180 - raw : raw };
}

/**
 * Readout for an edge- or face-pair angle.
 *
 * `parallel` is spelled out rather than rendered as "0.0 deg", because those
 * are different facts: 0.0 is a measured angle that rounded to zero, while
 * parallel is a classification the maths made. `three-point-angle.ts` draws the
 * same distinction for `zero` and `straight`.
 */
export function formatAnglePair(outcome: AnglePairOutcome): string {
  switch (outcome.kind) {
    case 'degenerate':
      if (outcome.reason === 'no-normal') return 'No surface at one pick';
      return outcome.reason === 'first' ? 'First pick too short' : 'Second pick too short';
    case 'parallel':
      return 'Parallel';
    case 'angled':
      return `${outcome.degrees.toFixed(1)}\u00B0`;
  }
}
