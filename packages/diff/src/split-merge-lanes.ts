/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The two candidate-generation lanes of the split/merge detector (issue #1891).
 *
 * The repo owner's decision that an element which splits AND moves must still
 * be reported removes containment as a hard filter — and containment was the
 * only thing keeping candidate generation off `O(wholes × pieces)`. So there
 * are two lanes rather than one relaxed test, each with its own way of staying
 * cheap and its own standard of proof:
 *
 * - **Lane 1, in-place.** A uniform grid over the residue boxes, per `ifcType`.
 *   For each whole, the pieces whose boxes lie inside its padded box. Position
 *   is doing the binding, so volume is free to be missing (the extent tier).
 * - **Lane 2, displaced.** Cluster the still-unclaimed pieces into connected
 *   components by proximity, then match a CLUSTER to a whole by signature
 *   rather than by position: volume sum plus sorted union-box extents, unique
 *   in both directions. The insight it rests on: what binds the pieces to each
 *   OTHER survives the move even when what binds them to the parent does not.
 *
 * Both lanes are direction-agnostic. `split` and `merge` are the same algorithm
 * with the two sides swapped, so the caller hands in whichever side holds the
 * single entity as `wholes`, and both directions always run.
 */

import { positiveOr } from './geometry-compare.js';
import {
  boxUnion,
  boxWithin,
  buildBoxGrid,
  clusterByProximity,
  containmentPadding,
  extentCoverage,
  sortedExtents,
} from './split-merge-geometry.js';
import { findSingleInterloper, judgeVolumes, usableVolume } from './split-merge-evidence.js';
import type { EntityAabb, EntityFingerprint, SplitMergeClaim, SplitMergeKind } from './types.js';

/** Defaults for {@link SplitMergeSettings}; see `DiffOptions` for the rationale. */
export const DEFAULT_SPLIT_VOLUME_TOLERANCE = 0.03;
export const DEFAULT_SPLIT_PADDING_MIN = 0.05;
export const DEFAULT_SPLIT_PADDING_RATIO = 0.01;
export const DEFAULT_MAX_SPLIT_PIECES = 256;

/** Fewer than this on the piece side is not a split — a 1:1 relation is what
 *  the content pass already adjudicated as moved / reshaped / ambiguous. */
const MIN_PIECES = 2;

/** Resolved knobs for one detector run. */
export interface SplitMergeSettings {
  volumeTolerance: number;
  paddingMin: number;
  paddingRatio: number;
  maxPieces: number;
}

/**
 * Resolve the piece CAP, which needs more than {@link positiveOr} gives the
 * three rates beside it.
 *
 * `positiveOr` accepts any finite `value >= 0`, so `0`, `1` and `2.5` all pass
 * it — and `0` or `1` then rejects every candidate the detector could ever
 * build, because a candidate has at least {@link MIN_PIECES} pieces by
 * definition. The whole stage would report nothing, with no error anywhere:
 * exactly the silent-vanish `positiveOr`'s own comment says it exists to
 * prevent, arriving through a different door.
 *
 * An unusable cap falls back to the DOCUMENTED DEFAULT rather than being
 * clamped up to `MIN_PIECES` or rejected with a throw:
 *
 * - `diffModels` has no error channel for its options and every other one
 *   coerces, so throwing would be a new failure mode in a package whose stated
 *   contract here is that an untyped caller cannot poison a run.
 * - Clamping `1` to `2` invents an intent the caller never expressed — there is
 *   no such thing as a split into fewer than two pieces, so `1` is not a
 *   tighter cap, it is an unachievable one — and still overrides them silently,
 *   while producing a run that behaves like neither `1` nor the default.
 * - The fallback's failure direction is the safe one FOR THIS KNOB
 *   specifically. `maxSplitPieces` is a performance bail, never a semantic
 *   rule, so resolving an unusable value to `256` can only cost time on a
 *   pathological model; it can never produce a wrong claim. Detecting nothing
 *   produces a wrong ANSWER. More permissive is strictly safer here, and that
 *   argument does not transfer to the tolerances, which is why this is not a
 *   shared helper.
 *
 * A fractional value at or above the minimum is FLOORED rather than refused: a
 * cap of 2.5 pieces is a cap of 2 pieces, because counts are integers. Nothing
 * is invented and nothing is lost.
 */
function pieceCapOr(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const cap = Math.floor(value);
  return cap >= MIN_PIECES ? cap : fallback;
}

/** Coerced so an untyped caller cannot poison a run with a value that would
 *  make every comparison false and every claim silently vanish: the three rates
 *  through the same `positiveOr` the move/reshape tolerances use, the piece cap
 *  through {@link pieceCapOr}, which additionally has to be a usable integer
 *  count (see there — the integer floor is deliberately NOT imposed on the
 *  rates, which are fractions and would floor to zero). */
export function resolveSplitMergeSettings(options: {
  splitVolumeTolerance?: number;
  splitPaddingMin?: number;
  splitPaddingRatio?: number;
  maxSplitPieces?: number;
}): SplitMergeSettings {
  return {
    volumeTolerance: positiveOr(options.splitVolumeTolerance, DEFAULT_SPLIT_VOLUME_TOLERANCE),
    paddingMin: positiveOr(options.splitPaddingMin, DEFAULT_SPLIT_PADDING_MIN),
    paddingRatio: positiveOr(options.splitPaddingRatio, DEFAULT_SPLIT_PADDING_RATIO),
    maxPieces: pieceCapOr(options.maxSplitPieces, DEFAULT_MAX_SPLIT_PIECES),
  };
}

/** One residue entity that has a box the engine can use. */
export interface SplitCandidate<TRef> {
  fingerprint: EntityFingerprint<TRef>;
  aabb: EntityAabb;
}

/** Deterministic piece order inside a claim: by key, then by data hash for the
 *  pathological case of a model repeating a GlobalId. Code-unit comparison, not
 *  `localeCompare` — see #1987, where locale collation made an ordering depend
 *  on the machine's ICU data. */
function sortPieces<TRef>(pieces: SplitCandidate<TRef>[]): SplitCandidate<TRef>[] {
  return [...pieces].sort((a, b) => {
    const ak = a.fingerprint.key;
    const bk = b.fingerprint.key;
    if (ak !== bk) return ak < bk ? -1 : 1;
    const ad = a.fingerprint.dataHash;
    const bd = b.fingerprint.dataHash;
    if (ad !== bd) return ad < bd ? -1 : 1;
    return 0;
  });
}

function claimOf<TRef>(
  kind: SplitMergeKind,
  confidence: SplitMergeClaim<TRef>['confidence'],
  whole: SplitCandidate<TRef>,
  pieces: SplitCandidate<TRef>[],
  volumes?: { wholeVolume: number; piecesVolume: number; volumeResidual: number },
  excluded?: SplitCandidate<TRef>,
): SplitMergeClaim<TRef> {
  const claim: SplitMergeClaim<TRef> = {
    kind,
    confidence,
    whole: whole.fingerprint,
    pieces: sortPieces(pieces).map((piece) => piece.fingerprint),
  };
  if (volumes) {
    claim.wholeVolume = volumes.wholeVolume;
    claim.piecesVolume = volumes.piecesVolume;
    claim.volumeResidual = volumes.volumeResidual;
  }
  if (excluded) claim.excluded = excluded.fingerprint;
  return claim;
}

/**
 * LANE 1 — pieces that stayed inside the whole's own extent.
 *
 * Precedence, and it is the load-bearing rule of the whole detector: a FAILED
 * volume test is a REFUTATION, not a trigger for the fallback. A candidate
 * whose volumes are all known and miss the band gets no claim at all, even
 * though its boxes would have covered the extent perfectly. The extent tier
 * exists for the ABSENCE of evidence, never as a second chance after evidence
 * came back negative.
 */
export function inPlaceClaims<TRef>(
  wholes: readonly SplitCandidate<TRef>[],
  pieces: readonly SplitCandidate<TRef>[],
  kind: SplitMergeKind,
  settings: SplitMergeSettings,
): SplitMergeClaim<TRef>[] {
  if (wholes.length === 0 || pieces.length < MIN_PIECES) return [];
  const grid = buildBoxGrid(pieces.map((piece) => piece.aabb));
  const claims: SplitMergeClaim<TRef>[] = [];

  for (const whole of wholes) {
    const pad = containmentPadding(whole.aabb, settings.paddingMin, settings.paddingRatio);
    const contained: SplitCandidate<TRef>[] = [];
    for (const index of grid.query(whole.aabb, pad)) {
      const piece = pieces[index];
      if (boxWithin(piece.aabb, whole.aabb, pad)) contained.push(piece);
    }
    if (contained.length < MIN_PIECES) continue;
    // Perf bail only (`maxSplitPieces`): dropped whole rather than truncated,
    // because the first 256 of 400 panels is a claim nobody made.
    if (contained.length > settings.maxPieces) continue;

    const claim = judgeContainmentSet(kind, whole, contained, pad, settings);
    if (claim) claims.push(claim);
  }
  return claims;
}

/** The evidence chain for one whole and the full set of pieces inside it. */
function judgeContainmentSet<TRef>(
  kind: SplitMergeKind,
  whole: SplitCandidate<TRef>,
  contained: SplitCandidate<TRef>[],
  pad: number,
  settings: SplitMergeSettings,
): SplitMergeClaim<TRef> | undefined {
  const verdict = judgeVolumes(
    whole.fingerprint.volume,
    contained.map((piece) => piece.fingerprint.volume),
    settings.volumeTolerance,
  );

  if (verdict.kind === 'confirmed') {
    return claimOf(kind, 'verified', whole, contained, {
      wholeVolume: verdict.wholeVolume!,
      piecesVolume: verdict.piecesVolume!,
      volumeResidual: verdict.residual!,
    });
  }

  if (verdict.kind === 'refuted') {
    // The one bounded exception: a single unrelated same-class element inside
    // the parent's box, identified because its own volume is exactly the
    // overshoot. Only reachable on a COMPLETE set — with an unknown in the
    // group, "the overshoot" is not a number anyone knows.
    if (!verdict.complete) return undefined;
    const volumes = contained.map((piece) => usableVolume(piece.fingerprint.volume)!);
    const index = findSingleInterloper(
      verdict.wholeVolume!,
      volumes,
      settings.volumeTolerance,
    );
    if (index === undefined) return undefined;
    const kept = contained.filter((_, i) => i !== index);
    const keptVerdict = judgeVolumes(
      whole.fingerprint.volume,
      kept.map((piece) => piece.fingerprint.volume),
      settings.volumeTolerance,
    );
    if (keptVerdict.kind !== 'confirmed') return undefined;
    return claimOf(
      kind,
      'verified',
      whole,
      kept,
      {
        wholeVolume: keptVerdict.wholeVolume!,
        piecesVolume: keptVerdict.piecesVolume!,
        volumeResidual: keptVerdict.residual!,
      },
      contained[index],
    );
  }

  // `unknown`: a volume was missing somewhere and nothing known contradicted
  // the candidate. Only here may the boxes speak.
  if (!extentCoverage(whole.aabb, contained.map((piece) => piece.aabb), pad)) return undefined;
  return claimOf(kind, 'extent', whole, contained);
}

/** A cluster of pieces that moved together, with the signature it is matched by. */
interface Cluster<TRef> {
  members: SplitCandidate<TRef>[];
  volume: number;
  box: EntityAabb;
  extents: [number, number, number];
}

/** Do two sorted extent triples agree? Relative to the larger side, with the
 *  padding floor carrying the short axes (a 200 mm wall thickness must not be
 *  held to 3% of 200 mm when a joint alone is 10 mm). */
function extentsCongruent(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  settings: SplitMergeSettings,
): boolean {
  for (let axis = 0; axis < 3; axis++) {
    const slack = Math.max(settings.paddingMin, settings.volumeTolerance * Math.max(a[axis], b[axis]));
    if (Math.abs(a[axis] - b[axis]) > slack) return false;
  }
  return true;
}

/**
 * LANE 2 — pieces that left the whole's old extent.
 *
 * Complete trusted volume is REQUIRED here, and that is an interpretation of
 * the owner's decision rather than the decision itself: decision 3 forbids a
 * POLICY refusal of a detected moved split, and does not mandate a claim where
 * the evidence cannot exist. Without volume, a moved cluster matched on class
 * and congruent extents alone false-positives badly in a repetitive building —
 * an identical slab field deleted on floor 3 and added on floor 5 would claim
 * itself, in both directions.
 */
export function displacedClaims<TRef>(
  wholes: readonly SplitCandidate<TRef>[],
  pieces: readonly SplitCandidate<TRef>[],
  kind: SplitMergeKind,
  settings: SplitMergeSettings,
): SplitMergeClaim<TRef>[] {
  if (wholes.length === 0 || pieces.length < MIN_PIECES) return [];

  const paddings = pieces.map((piece) =>
    containmentPadding(piece.aabb, settings.paddingMin, settings.paddingRatio),
  );
  const clusters: Cluster<TRef>[] = [];
  for (const component of clusterByProximity(pieces.map((piece) => piece.aabb), paddings)) {
    if (component.length < MIN_PIECES || component.length > settings.maxPieces) continue;
    const members = component.map((index) => pieces[index]);
    let volume = 0;
    let complete = true;
    for (const member of members) {
      const own = usableVolume(member.fingerprint.volume);
      if (own === undefined) {
        complete = false;
        break;
      }
      volume += own;
    }
    if (!complete) continue;
    const box = boxUnion(members.map((member) => member.aabb));
    clusters.push({ members, volume, box, extents: sortedExtents(box) });
  }
  if (clusters.length === 0) return [];

  // Wholes sorted by volume so each cluster reads its ±tolerance window by
  // binary search rather than scanning every whole of the class.
  const sorted = wholes
    .map((whole) => ({ whole, volume: usableVolume(whole.fingerprint.volume) }))
    .filter((entry): entry is { whole: SplitCandidate<TRef>; volume: number } => entry.volume !== undefined)
    .sort((a, b) => a.volume - b.volume);
  if (sorted.length === 0) return [];
  const volumes = sorted.map((entry) => entry.volume);

  const matchesPerCluster: number[][] = [];
  const clustersPerWhole = new Int32Array(sorted.length);
  for (const cluster of clusters) {
    const matches: number[] = [];
    // |Vc - Vw| <= tol*Vw  ⟺  Vw ∈ [Vc/(1+tol), Vc/(1-tol)]. Solved on Vw,
    // because the tolerance is relative to the WHOLE (see judgeVolumes).
    const lo = cluster.volume / (1 + settings.volumeTolerance);
    const hi =
      settings.volumeTolerance < 1
        ? cluster.volume / (1 - settings.volumeTolerance)
        : Number.POSITIVE_INFINITY;
    for (let i = lowerBound(volumes, lo); i < sorted.length && volumes[i] <= hi; i++) {
      const whole = sorted[i].whole;
      if (!extentsCongruent(cluster.extents, sortedExtents(whole.aabb), settings)) continue;
      // Not displaced at all: lane 1 already adjudicated this geometry and did
      // not claim it. Letting lane 2 take a sub-cluster of a refuted
      // containment set would be the subset search the design refuses, arriving
      // by the back door.
      const pad = containmentPadding(whole.aabb, settings.paddingMin, settings.paddingRatio);
      if (boxWithin(cluster.box, whole.aabb, pad)) continue;
      matches.push(i);
      clustersPerWhole[i] += 1;
    }
    matchesPerCluster.push(matches);
  }

  const claims: SplitMergeClaim<TRef>[] = [];
  for (let c = 0; c < clusters.length; c++) {
    const matches = matchesPerCluster[c];
    // Unique in BOTH directions or nothing: `mutual-nearest.ts`'s ethos, moved
    // from distance-space into evidence-space.
    if (matches.length !== 1) continue;
    const wholeIndex = matches[0];
    if (clustersPerWhole[wholeIndex] !== 1) continue;
    const cluster = clusters[c];
    const entry = sorted[wholeIndex];
    claims.push(
      claimOf(kind, 'displaced', entry.whole, cluster.members, {
        wholeVolume: entry.volume,
        piecesVolume: cluster.volume,
        volumeResidual: (cluster.volume - entry.volume) / entry.volume,
      }),
    );
  }
  return claims;
}

/** First index of `sorted` whose value is >= `target` (ascending array). */
function lowerBound(sorted: readonly number[], target: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
