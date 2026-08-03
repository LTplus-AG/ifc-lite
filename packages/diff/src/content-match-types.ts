/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the content-keyed matching pass REPORTS: the kinds it can conclude and
 * the record it hands back (issue #1891).
 *
 * Split out of `types.ts` for size, not for layering: these are part of the
 * same public contract and are re-exported from there, so a consumer still has
 * one place to import from.
 */

import type { EntityFingerprint } from './types.js';

/**
 * How a {@link ContentMatch} relates its `base` and `head` members (issue
 * #1891, `DiffOptions.matchUnpairedByContent`):
 *
 * - `renamed`      — the base and head members share a data hash AND a world
 *   geometry hash: same content, same place, different key (re-GUID/rename).
 *   Usually one entity per side; a group of `N` per side is reported as one
 *   `renamed` match when both sides agree on both hashes `N` times over,
 *   because every bijection between them is then indistinguishable.
 * - `moved`        — one base and one head entity share a data hash but not a
 *   geometry hash, and their bounding boxes are the same size in every axis
 *   while their centres are further apart than `DiffOptions.moveTolerance`.
 *   Without an {@link EntityFingerprint.aabb} on both sides this is also what
 *   a bare geometry-hash difference reports, since nothing can tell a move
 *   from a reshape.
 * - `reshaped`     — one base and one head entity share a data hash but not a
 *   geometry hash, and their bounding boxes differ in size beyond
 *   `DiffOptions.reshapeTolerance` — or agree entirely, which is what a
 *   re-tessellation looks like. A bounding box genuinely cannot separate a
 *   re-tessellation from a reshape confined to the interior, and this kind
 *   does not pretend otherwise.
 * - `duplicated`   — one base entity's content matches several head entities
 *   (it looks like it was copied).
 * - `deduplicated` — several base entities' content matches one head entity
 *   (they look like they were merged into one).
 * - `ambiguous`    — several candidates remain on both sides with no
 *   principled pairing: the engine could not tell duplication from
 *   deduplication, or positions were symmetric enough that no base was any
 *   head's unique nearest neighbour, or the only candidates were further apart
 *   than `DiffOptions.maxMoveDistance`.
 */
export type ContentMatchKind =
  | 'renamed'
  | 'moved'
  | 'reshaped'
  | 'duplicated'
  | 'deduplicated'
  | 'ambiguous';

/**
 * A content-hash-based match (or ambiguous match group) among entities the
 * key-based pass classified as `added`/`deleted` (issue #1891).
 *
 * `renamed`, `moved`, and `reshaped` are *retiring* kinds: the corresponding
 * `added`/`deleted` {@link DiffEntry} pairs are removed from
 * {@link ModelDiff.entries} in favour of this record. `moved` and `reshaped`
 * always hold exactly one entity per side; `renamed` holds one per side except
 * for the same-data-and-geometry group described in {@link ContentMatchKind},
 * where it holds `N` per side.
 *
 * For `duplicated`, `deduplicated`, and `ambiguous`, `base`/`head` hold every
 * unresolved candidate, and those entities' `added`/`deleted` entries are left
 * in {@link ModelDiff.entries} untouched — the engine reports the grouping
 * instead of guessing a 1:1 pairing (see #1923).
 */
export interface ContentMatch<TRef = unknown> {
  kind: ContentMatchKind;
  /** The shared {@link EntityFingerprint.dataHash} that grouped these entities. */
  dataHash: string;
  /** Base-revision entities in this match/group. */
  base: EntityFingerprint<TRef>[];
  /** Head-revision entities in this match/group. */
  head: EntityFingerprint<TRef>[];
  /**
   * Bounding-box-centre displacement base→head, in the caller's units.
   *
   * Present only on `moved`/`reshaped` matches whose two entities both carried
   * an {@link EntityFingerprint.aabb}. Reported as `0` below
   * {@link DiffOptions.moveTolerance}, mirroring the viewer's
   * `describeChange.ts` clamp (issue #1197): sub-tolerance jitter is
   * tessellation noise, not a move.
   */
  distance?: number;
}
