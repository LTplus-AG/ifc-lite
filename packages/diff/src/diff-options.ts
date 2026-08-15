/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every knob `diffModels` takes — what counts as a difference, which classes to
 * leave out, and the two opt-in matching passes with their tolerances.
 *
 * Split out of `types.ts` for size, like `content-match-types.ts` and
 * `split-merge-types.ts`, and re-exported from there: `./types.js` stays the
 * single import site for the whole contract, so no consumer import changes.
 * These are the OPTIONS; the records they produce live in the two files above
 * and the result shape stays in `types.ts`.
 */

import type { DiffScope } from './types.js';

export interface DiffOptions {
  /** What differences count as a modification. Default `'both'`. */
  scope?: DiffScope;
  /**
   * IFC type names to leave out of the comparison entirely - a "blacklist" of
   * classes the user does not want considered as changes (e.g.
   * `IfcOpeningElement`, which is only the connective void between a wall and a
   * removed window, not a meaningful change in its own right - issue #1470).
   *
   * An entity is dropped from the comparison if its {@link EntityFingerprint.ifcType}
   * matches in EITHER revision, so it never appears in {@link ModelDiff.entries},
   * {@link ModelDiff.byKey}, or {@link ModelDiff.counts} - as if it were in neither
   * model. Using the union of both sides means a cross-version re-class (e.g.
   * `IfcWall` -> `IfcWallStandardCase` with `IfcWall` excluded) can't leak the
   * entity back as a phantom add/delete. Matching is case-insensitive and ignores
   * surrounding whitespace so a hand-typed `ifcopeningelement` still matches.
   * Empty / whitespace-only names are ignored. Default: nothing excluded.
   */
  excludeTypes?: Iterable<string>;
  /**
   * Opt-in second matching pass (issue #1891): GlobalIds are unreliable
   * across a from-scratch re-export — every element gets a new GlobalId, so a
   * pure key diff reports the whole model as deleted-and-added even when
   * nothing substantive changed.
   *
   * When `true`, after the normal key-based pass, entities that came out
   * `added` or `deleted` are bucketed by ({@link EntityFingerprint.ifcType},
   * {@link EntityFingerprint.dataHash}) and re-examined. Within one bucket the
   * pass refines hierarchically — a real model is mostly *repeated*
   * components, so a bucket routinely holds many same-content entities that
   * differ only in where they sit:
   *
   * - **by world geometry hash.** Entities carrying a
   *   {@link EntityFingerprint.geometryHash} are sub-bucketed by it. A
   *   sub-bucket with one entity per side, or with the same count `N > 1` on
   *   both sides, is an unambiguous content match: the `added`/`deleted`
   *   entries are removed from {@link ModelDiff.entries} / `byKey` / `counts`
   *   (so they no longer read as a spurious add+delete) and reported instead
   *   as a single `renamed` {@link ContentMatch} in
   *   {@link ModelDiff.contentMatches}. For `N > 1`, every bijection is
   *   observationally identical in every field the engine can see, so the
   *   match carries all `N` entities per side rather than a guessed pairing.
   *   Geometry is not part of the *outer* bucket key: an entity that genuinely
   *   moved must still meet its counterpart.
   * - **1:1 leftover.** One base and one head left over in a bucket pair as
   *   `renamed` (geometry agrees, or geometry is out of scope), `moved`, or
   *   `reshaped` — see {@link ContentMatchKind} and {@link moveTolerance} /
   *   {@link reshapeTolerance} for how an {@link EntityFingerprint.aabb}
   *   separates the last two.
   * - **N:M leftover.** With an `aabb` on every candidate, leftovers are
   *   paired by *iterated mutual nearest neighbour* under
   *   {@link maxMoveDistance}: a base and a head pair only when each is the
   *   other's unique nearest, which abstains by construction on a symmetric
   *   layout rather than guessing. Whatever is still unpaired stays a
   *   reported group (below).
   *
   * Under {@link DiffScope} `'data'` geometry is out of the comparison
   * entirely, so no geometry sub-bucketing happens and every 1:1 match is
   * reported as `renamed`. The same applies under the capability abstention
   * described on {@link DiffScope}, which this pass shares with the key-based
   * one: when one revision carries geometry hashes and the other carries none
   * at all, geometry classifies nothing and every 1:1 match is `renamed` rather
   * than a model-wide sweep of `moved`.
   *
   *   Because this is the pass's only destructive path and `dataHash` is a
   *   64-bit FNV-1a value rather than a cryptographic digest, a pair is
   *   retired only if it also agrees on `ifcType` and — when both sides
   *   carry them — on every
   *   {@link EntityFingerprint.components} sub-hash. Neither check can reject
   *   a genuine match, and neither makes the pass collision-proof; see the
   *   "Hash collisions" section of `docs/guide/model-diff.md`.
   * - a bucket with more than one entity on either side is genuinely
   *   ambiguous: one base entity could have become several head entities
   *   ("duplicated"), several base entities could have collapsed into one head
   *   entity ("deduplicated"), or, with more than one on both sides, there is
   *   no principled way to tell which of the above happened, let alone which
   *   specific base entity corresponds to which head entity ("ambiguous"). The
   *   engine does not guess: the original `added`/`deleted` entries are left
   *   untouched in `entries`, and the whole bucket is additionally reported as
   *   a {@link ContentMatch} so the caller can resolve it (e.g. surface the
   *   group in a UI) rather than the engine silently picking one (see #1923,
   *   a shipped `?? candidates[0]` bug of exactly that shape).
   *
   * Splits and merges — a *partial* geometric overlap between one entity and
   * several others — are a separate, purely additive stage on this pass's
   * residue: see {@link detectSplitMerge}. They are not {@link ContentMatch}es
   * and never retire anything, because one claim binding `k + 1` entities on a
   * single evidence chain must not be able to delete `k + 1` real changes.
   *
   * `DiffState`/`DiffEntry` are unchanged by this option — a content match is
   * reported only via {@link ModelDiff.contentMatches}, never by inventing a
   * new `DiffEntry.state`, so existing exhaustive switches over `DiffState`
   * stay exhaustive. Default `false` — existing callers get byte-identical
   * results.
   */
  matchUnpairedByContent?: boolean;
  /**
   * Accepted identity claims, **head key → base key**, applied as key
   * normalization *before* the key-based pass indexes anything (issue #1891).
   *
   * This is the consuming half of {@link identityMapFromContentMatches}: a
   * previous comparison found that a re-GUIDed element is the same element, a
   * human accepted that, and the claim is replayed here so the pair is matched
   * by key rather than re-derived by content every single run. Because the
   * rename happens before indexing, an aliased pair is classified as
   * `modified`/`unchanged` by the ordinary key pass and never reaches
   * {@link matchUnpairedByContent} at all — it is not a candidate, so it cannot
   * appear in {@link ModelDiff.contentMatches}.
   *
   * The resulting {@link DiffEntry.key} is the **base** key; the head entity's
   * own key stays untouched on `entry.head.key`, so nothing is falsified — the
   * alias changes what the diff calls the pair, not what either file says.
   *
   * An alias is *ignored* (the head entity keeps its own key, exactly as if no
   * map had been supplied) when it points at a key no base entity holds, when
   * another head entity already holds the target key, or when two head entities
   * claim one base key. That last case is a collision, and on a collision the
   * alias loses and every colliding entity stays unaliased: a base entity is one
   * entity, so a map claiming otherwise is wrong, and the map is the only thing
   * that could have adjudicated. Refusing leaves the entities visible as
   * add/delete — what the caller would have seen without the map — instead of
   * silently dropping one. {@link ModelDiff.appliedKeyAliases} echoes back what
   * actually took effect.
   *
   * Composes with {@link excludeTypes} and every {@link scope}: aliasing only
   * decides *which entities are the same entity*, and both of those decide what
   * counts as a difference between two entities already known to be the same.
   * An alias onto an excluded base key drops the pair, which is what
   * `excludeTypes` means once the two are one entity.
   *
   * Default: no aliases — byte-identical results for existing callers.
   */
  keyAliases?: ReadonlyMap<string, string>;
  /**
   * Bounding-box-centre displacement (in the caller's units) below which a
   * content-matched pair counts as *not* moved. Default `2e-3`.
   *
   * Lifted deliberately from `MOVE_EPS` in the viewer's
   * `apps/viewer/src/lib/compare/describeChange.ts`, which encodes issue
   * #1197: a re-cut/re-tessellated wall that never moved reported a phantom
   * "moved 1.09 m". Below this, {@link ContentMatch.distance} is reported as
   * `0`, exactly as `describeChange` clamps it. Only used when both sides
   * carry an {@link EntityFingerprint.aabb}.
   */
  moveTolerance?: number;
  /**
   * Per-axis bounding-box *size* change (caller's units) above which a
   * content-matched pair counts as `reshaped` rather than `moved`. Default
   * `1e-3` — the same `RESHAPE_EPS` the viewer's `describeChange.ts` uses, so
   * the engine and the UI draw the move/reshape line in the same place. Only
   * used when both sides carry an {@link EntityFingerprint.aabb}.
   */
  reshapeTolerance?: number;
  /**
   * Maximum bounding-box-centre displacement (caller's units, so metres for a
   * metre-scale model) at which the mutual-nearest-neighbour pass will pair
   * two same-content entities. Default `10`: a building-scale relocation
   * pairs, a cross-site teleport stays `ambiguous` rather than being asserted
   * to be the same element. Only used when both sides carry an
   * {@link EntityFingerprint.aabb}.
   */
  maxMoveDistance?: number;
  /**
   * Opt-in fourth stage (issue #1891): look for **splits and merges** among the
   * entities still `added`/`deleted` after {@link matchUnpairedByContent} has
   * run — one element that became several, or several that became one.
   *
   * Effective only together with `matchUnpairedByContent`, and only when the
   * run has geometry to reason with (the {@link DiffScope} `'data'` and
   * mixed-capability abstentions apply unchanged — there is no non-geometric
   * evidence channel for this). Off, and in either abstention,
   * {@link ModelDiff.splitMerges} is `undefined` and nothing else changes.
   *
   * Running on the RESIDUE is load-bearing rather than incidental. Renames,
   * moves and reshapes must be retired first, or a re-GUIDed wall plus one
   * small genuinely-added fixture inside its box fakes a volume-conserving
   * "split" out of two things that were never related.
   *
   * **Purely additive.** A claim never retires a {@link DiffEntry} and never
   * touches {@link ModelDiff.counts}; see {@link SplitMergeClaim} for why, and
   * {@link SplitMergeConfidence} for what each claim rests on. Default `false`
   * — existing callers get byte-identical results.
   *
   * What it cannot see, stated once so it is not discovered in the field: a
   * split ACROSS classes (candidates are generated per `ifcType`); a container
   * polluted by two or more unrelated same-class elements; a moved split under
   * a rotation that is not a multiple of 90°; and a real split that changed
   * more than {@link splitVolumeTolerance} of material while carrying full
   * volume data, which is refused rather than reported. The `extent` profile
   * additionally fires on a redesign in place and on a perimeter of pieces
   * enclosing an unfilled middle, and `displaced` cannot separate two congruent
   * clusters in a repetitive building. `docs/guide/model-diff.md` expands each.
   */
  detectSplitMerge?: boolean;
  /**
   * Relative volume agreement required between the whole and the sum of the
   * pieces, as a fraction. Default `0.03` (3%).
   *
   * Chosen from site experience, not from float error: a real construction
   * split loses material to joints, couplings and grout, and 1% refused splits
   * that had plainly happened. It is a GATE, not a score — a candidate whose
   * volumes are all known and miss this band is refused outright rather than
   * demoted, because a failed volume test is a refutation and not a reason to
   * go looking for weaker evidence.
   *
   * The direct cost of that: a genuine split that changed more than 3% of its
   * material, on elements that all carry volumes, is not reported.
   */
  splitVolumeTolerance?: number;
  /**
   * Absolute floor (caller's units) of the slack allowed when asking whether a
   * piece lies inside the container's box, and when asking whether the pieces'
   * projections cover it. Default `0.05` (50 mm for a metre-scale model).
   *
   * Paired with {@link splitPaddingRatio}: the padding actually used is
   * `max(splitPaddingMin, splitPaddingRatio * containerBoxDiagonal)`. The floor
   * is what carries a small element, where 1% of a short diagonal is less than
   * a joint.
   *
   * The padding is always the CONTAINER's — the base element of a split, the
   * head element of a merge. For a merge the container is the added element,
   * and padding by each tiny deleted piece's own diagonal instead would make
   * the test mean something different for every piece.
   */
  splitPaddingMin?: number;
  /**
   * Fraction of the container's box diagonal used as containment slack, floored
   * by {@link splitPaddingMin}. Default `0.01` (1%).
   */
  splitPaddingRatio?: number;
  /**
   * Largest number of pieces one claim may bind. Default `256`.
   *
   * A PERFORMANCE bail, never a semantic rule: a precast slab field really is
   * dozens of panels, and there is no piece count at which a split stops being
   * a split. Above the cap the candidate is dropped rather than truncated —
   * reporting the first 256 of 400 panels would be a claim nobody made.
   *
   * Must resolve to a whole number of at least **2**; anything else falls back
   * to the default. A cap of `0` or `1` is not a tighter cap but an
   * unachievable one — a split into fewer than two pieces is not a split — and
   * honouring it literally would make the whole stage report nothing with no
   * error anywhere. A fractional value at or above 2 is floored, since a cap of
   * 2.5 pieces is a cap of 2 pieces.
   *
   * The fallback is deliberately the permissive direction, and only because of
   * what this knob IS: a cap that resolves higher than asked can cost time on a
   * pathological model but can never produce a wrong claim, while one that
   * resolves to nothing produces a wrong answer. Unlike the three rates above,
   * where a bad value is simply replaced.
   */
  maxSplitPieces?: number;
}
