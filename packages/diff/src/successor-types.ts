/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the successor stage REPORTS (issue #4955): a claim that one deleted
 * entity was REPLACED IN PLACE by one added entity whose data and geometry
 * both changed — a wall whose buildup was changed, a chair whose family was
 * swapped.
 *
 * Split out of `types.ts` for size, like `split-merge-types.ts`, and
 * re-exported from there — one import site for the whole public contract.
 */

import type { EntityFingerprint } from './types.js';

/**
 * What a {@link SuccessorClaim} rests on. Two named profiles, not a score:
 *
 * - `footprint` — the two bounding boxes overlap heavily (intersection over
 *   union at or above `DiffOptions.successorOverlap`), and that overlap is
 *   unique in both directions: no other candidate on either side comes within
 *   half the threshold. A thickened wall, a re-specified door in its opening.
 * - `position` — the boxes did NOT overlap enough, but both entities sit in
 *   the same spatial container (`EntityFingerprint.container`, equal and
 *   non-empty on both sides), their boxes are of comparable size (no axis more
 *   than twice the other's), and each is the other's nearest candidate within
 *   `DiffOptions.successorDistance`, with the runner-up at least twice as far.
 *   A chair swapped for a different family and nudged; a wall redrawn on a
 *   shifted axis. Weaker than `footprint`: it argues from where things sit,
 *   not from what space they fill.
 */
export type SuccessorConfidence = 'footprint' | 'position';

/**
 * One claim that {@link base} was replaced by {@link head} (issue #4955,
 * {@link DiffOptions.detectSuccessors}).
 *
 * **A suggestion, never a decision.** Like a split/merge claim it retires
 * nothing and touches no count: both entities keep their `deleted`/`added`
 * entries. Unlike a content match, the engine never mints an identity-map
 * entry from one unattended — `identityMapFromSuccessors` takes only the claims
 * a caller explicitly ACCEPTED. `docs/architecture/layer-prs/04-identity.md`
 * §4.5: heuristic matching is a suggestion provider for a review UI, never
 * silent.
 */
export interface SuccessorClaim<TRef = unknown> {
  confidence: SuccessorConfidence;
  /** The deleted entity. */
  base: EntityFingerprint<TRef>;
  /** The added entity claimed to have replaced it. */
  head: EntityFingerprint<TRef>;
  /** Bounding-box intersection over union, `0..1`. */
  overlap: number;
  /**
   * Bounding-box-centre displacement base→head, in the caller's units, clamped
   * to `0` below `DiffOptions.moveTolerance` as every other reported distance is.
   */
  distance: number;
  /**
   * Component keys whose sub-hash AGREES between the two — present only when
   * both carry `components`. The evidence a reviewer reads: a wall that kept
   * its `pset:Pset_WallCommon` and `type-assignment` but changed
   * `qset:Qto_WallBaseQuantities` and `material` is a re-specified wall; one
   * that agrees on nothing may be a coincidence of position.
   */
  agreeingComponents?: string[];
  /** `true` when the two entities carry a different `ifcType` (same family). */
  crossClass?: boolean;
}
