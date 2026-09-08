/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The refinement tiers inside one content bucket (issue #1891 follow-up), and
 * the guards every destructive path shares.
 *
 * `content-match.ts` owns the bucketing and the driver loop; this module owns
 * what happens *within* a single (`ifcType`, `dataHash`) bucket: sub-bucketing
 * by world geometry hash, classifying a pair, and pairing a leftover group by
 * position.
 */

import {
  classifyGeometryChange,
  geometryEqual,
  isUsableAabb,
  aabbCentre,
  type GeometryTolerances,
  type Vec3,
} from './geometry-compare.js';
import { mutualNearestPairs } from './mutual-nearest.js';
import type { ContentMatchKind, DiffEntry, EntityFingerprint } from './types.js';

/**
 * Largest leftover group the position-based pass will look at, per side.
 *
 * Mutual nearest neighbour is O(n·m) per round, and a bucket this large is a
 * mass of identical components where positional pairing is guesswork anyway.
 * Above it the group is reported as ambiguous, which is both cheaper and more
 * honest.
 */
export const MAX_POSITION_MATCH_GROUP = 128;

/** One `added`/`deleted` entry paired with the fingerprint its state implies. */
export interface Candidate<TRef> {
  entry: DiffEntry<TRef>;
  fingerprint: EntityFingerprint<TRef>;
}

/** Order-independent canonical form of a component sub-hash map. */
function componentSignature(components: Record<string, string>): string {
  let signature = '';
  for (const key of Object.keys(components).sort()) {
    signature += `${key}\u0000${components[key]}\u0001`;
  }
  return signature;
}

/**
 * Whether every supplied entity's component sub-hashes agree.
 *
 * Like the `ifcType` half of the bucket key in `content-match.ts`, this cannot reject a
 * real match — {@link EntityFingerprint.components} hashes slices of the same
 * content `dataHash` hashes whole — so a disagreement proves a collision.
 *
 * It does *not* make the pass collision-proof, and the asymmetry is worth
 * knowing: FNV-1a's per-character update is a bijection on its state at any
 * width, so two entities differing only inside `attr:core` (a different
 * `Name`, all else equal) hash their whole payloads as `prefix + name +
 * identical suffix` — a `dataHash` collision there *implies* an `attr:core`
 * collision, and this check abstains. It bites when the differing content
 * lands in a pset/qset slice, whose sub-hash is computed over an unrelated
 * string. Widening `stableHash` to 64 bits (issue #1962) made the premise far
 * less likely without removing the implication.
 *
 * Entities without components contribute nothing: components are opt-in, and a
 * caller may supply them for one revision only, so their absence is not
 * evidence either way (this mirrors the `changedComponents` guard in the
 * key-based pass, which also abstains).
 */
export function componentsAgree<TRef>(entities: readonly EntityFingerprint<TRef>[]): boolean {
  let signature: string | undefined;
  for (const entity of entities) {
    if (!entity.components) continue;
    const current = componentSignature(entity.components);
    if (signature === undefined) signature = current;
    else if (current !== signature) return false;
  }
  return true;
}

export function fingerprintsOf<TRef>(
  ...groups: readonly (readonly Candidate<TRef>[])[]
): EntityFingerprint<TRef>[] {
  const all: EntityFingerprint<TRef>[] = [];
  for (const group of groups) for (const candidate of group) all.push(candidate.fingerprint);
  return all;
}

/** Kind for a group that retires nothing. Total over the counts that reach it:
 *  a leftover 1:1 only occurs after the position pass refused to pair it, and
 *  "we could not tell" is exactly `ambiguous`. */
export function groupKind(baseCount: number, headCount: number): ContentMatchKind {
  if (baseCount === 1 && headCount === 1) return 'ambiguous';
  if (baseCount === 1) return 'duplicated';
  if (headCount === 1) return 'deduplicated';
  return 'ambiguous';
}

/**
 * Classify a pair the pass has decided is the same element.
 *
 * Equal (or out-of-scope) geometry means only the key changed: `renamed`.
 * Otherwise the bounding boxes, when present, separate a move from a reshape.
 */
export function classifyPair<TRef>(
  base: EntityFingerprint<TRef>,
  head: EntityFingerprint<TRef>,
  useGeometry: boolean,
  tolerances: GeometryTolerances,
): { kind: ContentMatchKind; distance?: number } {
  if (!useGeometry || geometryEqual(base.geometryHash, head.geometryHash)) {
    return { kind: 'renamed' };
  }
  return classifyGeometryChange(base.aabb, head.aabb, tolerances);
}

/** TIER 1 result: what the geometry-hash sub-buckets resolved, and what is left. */
export interface GeometryRefinement<TRef> {
  /** Sub-buckets that agreed on both sides, N per side. Retiring. */
  resolved: { bases: Candidate<TRef>[]; heads: Candidate<TRef>[] }[];
  residueBase: Candidate<TRef>[];
  residueHead: Candidate<TRef>[];
}

/**
 * TIER 1 — sub-bucket a (`ifcType`, `dataHash`) bucket by world geometry hash.
 *
 * This is what makes the pass work on a real model: buildings are mostly
 * repeated components, so three data-identical doors at three different places
 * used to land in one bucket, report a single `ambiguous` group, and pair
 * nothing at all. Sub-bucketing pairs each door with the door that is still in
 * its place.
 *
 * Entities whose `geometryHash` is `undefined` are excluded: `undefined`
 * matching `undefined` is vacuous agreement, not evidence, so they go to the
 * residue where the later tiers can weigh what is actually known about them.
 *
 * A sub-bucket with `N` entities on both sides retires as one group. Both the
 * data hash and the world-space geometry hash agree `N` times over, so every
 * bijection between the two sides is identical in every field the engine can
 * see; there is nothing left to guess, and no specific pairing is fabricated
 * (the match carries all `N` per side). A sub-bucket with different counts
 * retires nothing and falls to the residue, where it can still be reported as
 * duplicated/deduplicated/ambiguous, or paired positionally against entities
 * from the *other* sub-buckets — which is the point of not resolving it here.
 */
export function refineByGeometryHash<TRef>(
  bases: readonly Candidate<TRef>[],
  heads: readonly Candidate<TRef>[],
): GeometryRefinement<TRef> {
  const subBuckets = new Map<string, { bases: Candidate<TRef>[]; heads: Candidate<TRef>[] }>();
  const residueBase: Candidate<TRef>[] = [];
  const residueHead: Candidate<TRef>[] = [];

  const bucketFor = (hash: string) => {
    const existing = subBuckets.get(hash);
    if (existing) return existing;
    const created = { bases: [] as Candidate<TRef>[], heads: [] as Candidate<TRef>[] };
    subBuckets.set(hash, created);
    return created;
  };

  for (const candidate of bases) {
    const hash = candidate.fingerprint.geometryHash;
    if (hash === undefined) residueBase.push(candidate);
    else bucketFor(String(hash)).bases.push(candidate);
  }
  for (const candidate of heads) {
    const hash = candidate.fingerprint.geometryHash;
    if (hash === undefined) residueHead.push(candidate);
    else bucketFor(String(hash)).heads.push(candidate);
  }

  const resolved: GeometryRefinement<TRef>['resolved'] = [];
  for (const group of subBuckets.values()) {
    const pairable =
      group.bases.length > 0 &&
      group.bases.length === group.heads.length &&
      // The guard stays on every destructive path, tier 1 included: it cannot
      // reject a genuine match and it is cheap.
      componentsAgree(fingerprintsOf(group.bases, group.heads));
    if (pairable) {
      resolved.push(group);
      continue;
    }
    residueBase.push(...group.bases);
    residueHead.push(...group.heads);
  }

  return { resolved, residueBase, residueHead };
}

/** Centres for a group, or `null` when any member lacks a usable box. */
function centresOf<TRef>(group: readonly Candidate<TRef>[]): Vec3[] | null {
  const centres: Vec3[] = [];
  for (const candidate of group) {
    const aabb = candidate.fingerprint.aabb;
    if (!isUsableAabb(aabb)) return null;
    centres.push(aabbCentre(aabb));
  }
  return centres;
}

/**
 * TIER 3 — pair an N:M leftover group by position.
 *
 * Returns the accepted pairs and whatever stayed unpaired. Degrades to "no
 * pairs, everything left over" — today's `ambiguous` — when geometry is out of
 * scope, when any candidate lacks a bounding box, or when the group is larger
 * than {@link MAX_POSITION_MATCH_GROUP}.
 */
export function pairByPosition<TRef>(
  bases: readonly Candidate<TRef>[],
  heads: readonly Candidate<TRef>[],
  useGeometry: boolean,
  tolerances: GeometryTolerances,
): { pairs: [Candidate<TRef>, Candidate<TRef>][]; leftoverBase: Candidate<TRef>[]; leftoverHead: Candidate<TRef>[] } {
  const nothing = { pairs: [], leftoverBase: [...bases], leftoverHead: [...heads] };
  if (!useGeometry) return nothing;
  if (bases.length > MAX_POSITION_MATCH_GROUP || heads.length > MAX_POSITION_MATCH_GROUP) {
    return nothing;
  }
  const baseCentres = centresOf(bases);
  const headCentres = centresOf(heads);
  if (!baseCentres || !headCentres) return nothing;

  const pairs: [Candidate<TRef>, Candidate<TRef>][] = [];
  const pairedBase = new Set<number>();
  const pairedHead = new Set<number>();
  // Same guard as every other destructive path, handed to the pairing itself
  // rather than applied to its output: the fixpoint computes each round as if
  // every pair it already accepted were gone, so a pair discarded afterwards
  // would leave the following rounds pairing against a pool that never
  // existed. As a veto, a rejected pair keeps both candidates available for
  // the rounds that follow.
  const accept = (baseIndex: number, headIndex: number): boolean =>
    componentsAgree([bases[baseIndex].fingerprint, heads[headIndex].fingerprint]);
  for (const pair of mutualNearestPairs(
    baseCentres,
    headCentres,
    tolerances.maxMoveDistance,
    accept,
  )) {
    pairedBase.add(pair.base);
    pairedHead.add(pair.head);
    pairs.push([bases[pair.base], heads[pair.head]]);
  }

  return {
    pairs,
    leftoverBase: bases.filter((_, index) => !pairedBase.has(index)),
    leftoverHead: heads.filter((_, index) => !pairedHead.has(index)),
  };
}

