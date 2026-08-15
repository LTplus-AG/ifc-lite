/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the split/merge detector REPORTS (issue #1891): the two directions, the
 * three evidence profiles, and the claim record itself.
 *
 * Split out of `types.ts` for size, like `content-match-types.ts`, and
 * re-exported from there — one import site for the whole public contract.
 *
 * The *algorithm* lives in `split-merge.ts` and its three helper modules; this
 * file is deliberately free of it, because these types are what a UI, a report
 * exporter and a reviewer read, and none of them should have to read a spatial
 * grid to find out what a claim asserts.
 */

import type { EntityFingerprint } from './types.js';

/**
 * Which way round a {@link SplitMergeClaim} runs (issue #1891).
 *
 * - `split` — one BASE entity looks like it became several head entities.
 * - `merge` — several base entities look like they became one HEAD entity.
 *
 * Exactly the same algorithm with the two sides swapped; both directions always
 * run, and `whole` always names the single entity whichever way it points.
 */
export type SplitMergeKind = 'split' | 'merge';

/**
 * What a {@link SplitMergeClaim} is actually resting on. Three named evidence
 * profiles rather than a numeric score, because the difference between them is
 * a difference in KIND of evidence, and averaging kinds into one number hides
 * which one was missing:
 *
 * - `verified` — the pieces sit inside the whole's own extent, every
 *   participant carried a {@link EntityFingerprint.volume}, and the volumes sum
 *   to the whole's within {@link DiffOptions.splitVolumeTolerance}. The only
 *   profile where the geometry was measured rather than bounded.
 * - `extent` — the pieces sit inside the whole's extent and their boxes cover
 *   it on all three axes, but a volume was MISSING somewhere (and never
 *   refuted). The weakest profile: an axis-aligned box cannot tell a genuine
 *   split from a redesign in place, nor a filled volume from a perimeter
 *   enclosing an empty middle.
 * - `displaced` — the pieces moved out of the whole's old extent, so
 *   containment says nothing. Accepted only on complete volumes within
 *   tolerance PLUS congruent sorted extents PLUS a pairing that is unique in
 *   both directions. Lower confidence than `verified` because position, the
 *   strongest single piece of evidence, is exactly what is absent.
 */
export type SplitMergeConfidence = 'verified' | 'extent' | 'displaced';

/**
 * One claim that a single entity and a group of entities on the other side are
 * the same material (issue #1891, {@link DiffOptions.detectSplitMerge}).
 *
 * **A claim, not a decision.** Unlike a retiring {@link ContentMatch}, this
 * never removes a {@link DiffEntry} and never touches {@link ModelDiff.counts}:
 * every participant is still reported as the `added`/`deleted` it is. A split
 * binds `k + 1` entities on ONE evidence chain, so retiring them would let a
 * single wrong claim delete `k + 1` real changes; a UI groups the underlying
 * add/deletes under the claim instead.
 *
 * For the same reason no claim here ever becomes an identity-map entry:
 * identity is not a relation that survives being split. `CLAIMABLE_KINDS` in
 * `identity-map.ts` reads {@link ContentMatch}es only, and these are not one.
 */
export interface SplitMergeClaim<TRef = unknown> {
  kind: SplitMergeKind;
  confidence: SplitMergeConfidence;
  /** The single entity: the BASE entity of a `split`, the HEAD entity of a `merge`. */
  whole: EntityFingerprint<TRef>;
  /** The `k >= 2` entities on the other side, in a deterministic order. */
  pieces: EntityFingerprint<TRef>[];
  /** {@link whole}'s volume. Present exactly on `verified` and `displaced`. */
  wholeVolume?: number;
  /** Sum of the pieces' volumes. Present exactly on `verified` and `displaced`. */
  piecesVolume?: number;
  /**
   * `(piecesVolume - wholeVolume) / wholeVolume`, signed — negative means the
   * pieces account for less material than the whole did. Within
   * {@link DiffOptions.splitVolumeTolerance} by construction wherever present.
   */
  volumeResidual?: number;
  /**
   * The one same-class element that sat inside the whole's box, was NOT part of
   * this claim, and whose own volume explained the whole overshoot on its own.
   *
   * Present only when the bounded one-interloper exception fired. It is
   * reported rather than silently dropped: the claim is "these pieces are the
   * whole, and that thing is something else", and the second half is a
   * statement about a real entity a reviewer may disagree with.
   */
  excluded?: EntityFingerprint<TRef>;
}
