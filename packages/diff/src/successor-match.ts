/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The successor stage (issue #4955): claims that one deleted entity was
 * REPLACED IN PLACE by one added entity, when neither the data hash nor the
 * geometry hash agrees.
 *
 * Content matching needs one of the two hashes to agree; split/merge needs
 * volumes to conserve. A wall whose buildup was changed (thicker, different
 * layer set, re-measured quantities, often re-named) and a chair swapped for a
 * different family agree on nothing a hash can see. What they do share is
 * WHERE they are, and this stage argues from that alone — which is why it is
 * the weakest stage in the engine and why it never decides anything:
 *
 * - it runs LAST, on what content matching and split/merge left unbound, so
 *   the nearest piece of a split is never offered as the whole's successor;
 * - it retires nothing and touches no count (`ModelDiff.successors` is
 *   additive, like `splitMerges`);
 * - it mints no identity entry unattended: {@link identityMapFromSuccessors}
 *   takes only what a caller explicitly accepted.
 *
 * Two profiles, evaluated in order, each requiring a pairing that is UNIQUE IN
 * BOTH DIRECTIONS with a margin. A tie, or a runner-up inside the margin, is an
 * abstention: two candidates that both explain a position carry no information
 * about which one it became (`mutual-nearest.ts`, #1923).
 *
 * **`footprint`** — bounding-box intersection over union. A thickening that
 * nests the old box in the new one scores `V_old / V_new`, so a 200 → 250 mm
 * wall is 0.8 whichever face moved, a 200 → 350 mm wall is 0.57 and misses,
 * and a 100 mm axis shift at 200 mm is 0.33 and misses. An axis-shifted redraw
 * is exactly the case this profile misses and `position` must carry.
 *
 * **`position`** — same class family, same spatial container (a NAME path both
 * adapters resolve, equal and non-empty on both sides — absent on either side
 * is not evidence and the pair is skipped), centre distance within
 * `max(successorDistance, 0.5 × base box diagonal)`, mutual nearest with the
 * runner-up at least twice as far. `footprint` ignores the container on
 * purpose: a storey rename changes the path of every element in it, and a
 * heavy box overlap is stronger evidence than a matching name.
 */

import { classFamilyResolver, sameIfcClass } from './class-families.js';
import {
  aabbCentre,
  centreDistance,
  isUsableAabb,
  positiveOr,
  type GeometryTolerances,
} from './geometry-compare.js';
import { mutualNearestPairs } from './mutual-nearest.js';
import type {
  DiffEntry,
  DiffOptions,
  EntityAabb,
  EntityFingerprint,
  SuccessorClaim,
  SuccessorConfidence,
} from './types.js';

/** Box intersection-over-union at or above which `footprint` may fire. */
export const DEFAULT_SUCCESSOR_OVERLAP = 0.6;

/**
 * Absolute floor (caller's units) of the centre displacement `position`
 * accepts; the effective cap is `max(this, 0.5 × base box diagonal)`.
 */
export const DEFAULT_SUCCESSOR_DISTANCE = 0.5;

/** The runner-up must be at least this many times further than the nearest. */
const POSITION_MARGIN_RATIO = 2;

/**
 * Largest bucket (per side, per family) the stage will look at. Both profiles
 * are O(n·m) per bucket, and a residue this large is a mass of new elements
 * where a positional argument about replacement is guesswork anyway.
 */
export const MAX_SUCCESSOR_GROUP = 1024;

interface SuccessorCandidate<TRef> {
  fingerprint: EntityFingerprint<TRef>;
  aabb: EntityAabb;
}

export interface SuccessorSettings {
  overlap: number;
  distance: number;
}

export function resolveSuccessorSettings(options: DiffOptions): SuccessorSettings {
  const overlap = positiveOr(options.successorOverlap, DEFAULT_SUCCESSOR_OVERLAP);
  return {
    // An overlap threshold above 1 can never fire and one at 0 fires on any
    // touching box; both are replaced, not honoured.
    overlap: overlap > 0 && overlap <= 1 ? overlap : DEFAULT_SUCCESSOR_OVERLAP,
    distance: positiveOr(options.successorDistance, DEFAULT_SUCCESSOR_DISTANCE),
  };
}

function boxVolume(box: EntityAabb): number {
  return (
    Math.max(0, box.max[0] - box.min[0]) *
    Math.max(0, box.max[1] - box.min[1]) *
    Math.max(0, box.max[2] - box.min[2])
  );
}

/** Intersection over union of two boxes, `0..1`; `0` for a degenerate pair. */
export function boxIoU(a: EntityAabb, b: EntityAabb): number {
  let intersection = 1;
  for (let axis = 0; axis < 3; axis++) {
    const lo = Math.max(a.min[axis], b.min[axis]);
    const hi = Math.min(a.max[axis], b.max[axis]);
    if (hi <= lo) return 0;
    intersection *= hi - lo;
  }
  const union = boxVolume(a) + boxVolume(b) - intersection;
  return union > 0 ? intersection / union : 0;
}

function boxDiagonal(box: EntityAabb): number {
  const dx = box.max[0] - box.min[0];
  const dy = box.max[1] - box.min[1];
  const dz = box.max[2] - box.min[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function agreeingComponentKeys(
  base: Record<string, string>,
  head: Record<string, string>,
): string[] {
  const agreeing: string[] = [];
  for (const key of Object.keys(base)) {
    if (head[key] === base[key]) agreeing.push(key);
  }
  return agreeing.sort();
}

function claimOf<TRef>(
  confidence: SuccessorConfidence,
  base: SuccessorCandidate<TRef>,
  head: SuccessorCandidate<TRef>,
  overlap: number,
  tolerances: GeometryTolerances,
): SuccessorClaim<TRef> {
  const raw = centreDistance(aabbCentre(base.aabb), aabbCentre(head.aabb));
  const claim: SuccessorClaim<TRef> = {
    confidence,
    base: base.fingerprint,
    head: head.fingerprint,
    overlap,
    distance: raw > tolerances.moveTolerance ? raw : 0,
  };
  if (base.fingerprint.components && head.fingerprint.components) {
    claim.agreeingComponents = agreeingComponentKeys(
      base.fingerprint.components,
      head.fingerprint.components,
    );
  }
  if (!sameIfcClass(base.fingerprint.ifcType, head.fingerprint.ifcType)) claim.crossClass = true;
  return claim;
}

/**
 * The `footprint` profile over one family bucket: mutual-best IoU at or above
 * the threshold, with every other candidate on either side below half of it.
 */
function footprintClaims<TRef>(
  bases: readonly SuccessorCandidate<TRef>[],
  heads: readonly SuccessorCandidate<TRef>[],
  settings: SuccessorSettings,
  tolerances: GeometryTolerances,
): { claims: SuccessorClaim<TRef>[]; pairedBase: Set<number>; pairedHead: Set<number> } {
  const claims: SuccessorClaim<TRef>[] = [];
  const pairedBase = new Set<number>();
  const pairedHead = new Set<number>();
  const runnerUpCeiling = settings.overlap / 2;

  // best/second per base, best/second per head, in one pass over the matrix.
  const bestHeadOf = new Int32Array(bases.length).fill(-1);
  const bestHeadIoU = new Float64Array(bases.length);
  const secondHeadIoU = new Float64Array(bases.length);
  const bestBaseOf = new Int32Array(heads.length).fill(-1);
  const bestBaseIoU = new Float64Array(heads.length);
  const secondBaseIoU = new Float64Array(heads.length);

  for (let b = 0; b < bases.length; b++) {
    for (let h = 0; h < heads.length; h++) {
      const iou = boxIoU(bases[b].aabb, heads[h].aabb);
      if (iou > bestHeadIoU[b]) {
        secondHeadIoU[b] = bestHeadIoU[b];
        bestHeadIoU[b] = iou;
        bestHeadOf[b] = h;
      } else if (iou > secondHeadIoU[b]) {
        secondHeadIoU[b] = iou;
      }
      if (iou > bestBaseIoU[h]) {
        secondBaseIoU[h] = bestBaseIoU[h];
        bestBaseIoU[h] = iou;
        bestBaseOf[h] = b;
      } else if (iou > secondBaseIoU[h]) {
        secondBaseIoU[h] = iou;
      }
    }
  }

  for (let b = 0; b < bases.length; b++) {
    const h = bestHeadOf[b];
    if (h < 0 || bestBaseOf[h] !== b) continue;
    const iou = bestHeadIoU[b];
    if (iou < settings.overlap) continue;
    // Uniqueness with a margin, on BOTH sides: a second head almost as
    // overlapping (two new layers each half-filling the old wall) or a second
    // base (an old wall and its old cladding under one new wall) is an
    // abstention, not a preference.
    if (secondHeadIoU[b] >= runnerUpCeiling || secondBaseIoU[h] >= runnerUpCeiling) continue;
    pairedBase.add(b);
    pairedHead.add(h);
    claims.push(claimOf('footprint', bases[b], heads[h], iou, tolerances));
  }
  return { claims, pairedBase, pairedHead };
}

/**
 * The `position` profile over one (family, container) group: iterated mutual
 * nearest neighbour with a ×2 margin, each pair capped by the BASE box's
 * diagonal (floored by `successorDistance`).
 */
function positionClaims<TRef>(
  bases: readonly SuccessorCandidate<TRef>[],
  heads: readonly SuccessorCandidate<TRef>[],
  settings: SuccessorSettings,
  tolerances: GeometryTolerances,
): SuccessorClaim<TRef>[] {
  const baseCentres = bases.map((candidate) => aabbCentre(candidate.aabb));
  const headCentres = heads.map((candidate) => aabbCentre(candidate.aabb));
  const withinReach = (b: number, h: number): boolean => {
    const cap = Math.max(settings.distance, 0.5 * boxDiagonal(bases[b].aabb));
    return centreDistance(baseCentres[b], headCentres[h]) <= cap;
  };
  const claims: SuccessorClaim<TRef>[] = [];
  for (const pair of mutualNearestPairs(
    baseCentres,
    headCentres,
    Infinity,
    withinReach,
    POSITION_MARGIN_RATIO,
  )) {
    const base = bases[pair.base];
    const head = heads[pair.head];
    claims.push(claimOf('position', base, head, boxIoU(base.aabb, head.aabb), tolerances));
  }
  return claims;
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Find successor claims among the entities still `added`/`deleted` after
 * content matching, excluding every entity a split/merge claim binds.
 *
 * `useGeometry` is the answer `diff.ts` resolved once for every stage; there
 * is no non-geometric argument that one element replaced another, so the
 * stage inherits the abstention and returns `undefined` (absent, not empty —
 * the same contract as `ModelDiff.splitMerges`).
 *
 * Pure: never mutates its inputs.
 */
export function detectSuccessors<TRef>(
  entries: readonly DiffEntry<TRef>[],
  useGeometry: boolean,
  bound: ReadonlySet<EntityFingerprint<TRef>>,
  options: DiffOptions,
  tolerances: GeometryTolerances,
): SuccessorClaim<TRef>[] | undefined {
  if (!useGeometry) return undefined;
  const settings = resolveSuccessorSettings(options);
  const familyOf = classFamilyResolver(options.classFamilies);

  const added = new Map<string, SuccessorCandidate<TRef>[]>();
  const deleted = new Map<string, SuccessorCandidate<TRef>[]>();
  for (const entry of entries) {
    const fingerprint =
      entry.state === 'added' ? entry.head : entry.state === 'deleted' ? entry.base : undefined;
    if (!fingerprint || bound.has(fingerprint)) continue;
    if (!isUsableAabb(fingerprint.aabb)) continue;
    const side = entry.state === 'added' ? added : deleted;
    const family = familyOf(fingerprint.ifcType);
    const bucket = side.get(family);
    const candidate = { fingerprint, aabb: fingerprint.aabb };
    if (bucket) bucket.push(candidate);
    else side.set(family, [candidate]);
  }

  const claims: SuccessorClaim<TRef>[] = [];
  for (const [family, bases] of deleted) {
    const heads = added.get(family);
    if (!heads || heads.length === 0) continue;
    if (bases.length > MAX_SUCCESSOR_GROUP || heads.length > MAX_SUCCESSOR_GROUP) continue;

    const footprint = footprintClaims(bases, heads, settings, tolerances);
    claims.push(...footprint.claims);

    // `position` sees only what `footprint` did not take, grouped by
    // container. A candidate without a container name is out of this profile
    // entirely: absence is not evidence.
    const byContainer = new Map<string, { bases: SuccessorCandidate<TRef>[]; heads: SuccessorCandidate<TRef>[] }>();
    const groupFor = (container: string) => {
      const existing = byContainer.get(container);
      if (existing) return existing;
      const created = { bases: [] as SuccessorCandidate<TRef>[], heads: [] as SuccessorCandidate<TRef>[] };
      byContainer.set(container, created);
      return created;
    };
    bases.forEach((candidate, index) => {
      const container = candidate.fingerprint.container;
      if (footprint.pairedBase.has(index) || !container) return;
      groupFor(container).bases.push(candidate);
    });
    heads.forEach((candidate, index) => {
      const container = candidate.fingerprint.container;
      if (footprint.pairedHead.has(index) || !container) return;
      groupFor(container).heads.push(candidate);
    });
    for (const group of byContainer.values()) {
      if (group.bases.length === 0 || group.heads.length === 0) continue;
      claims.push(...positionClaims(group.bases, group.heads, settings, tolerances));
    }
  }

  // Deterministic order, independent of Map iteration and input order.
  claims.sort(
    (a, b) => compareKeys(a.base.key, b.base.key) || compareKeys(a.head.key, b.head.key),
  );
  return claims;
}
