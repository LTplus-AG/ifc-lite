/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The split/merge detector (issue #1891): a fourth, purely ADDITIVE stage that
 * runs after content matching, on whatever is still `added`/`deleted`.
 *
 * Running on the residue is not a performance choice. Renames, moves and
 * reshapes have to be retired first, or a re-GUIDed wall plus one genuinely-new
 * fixture sitting inside its box fakes a volume-conserving "split" out of two
 * things that were never related — the wall would be its own piece.
 *
 * This module owns the driver: bucketing by `ifcType`, running both directions
 * through both lanes, and resolving the conflicts between the claims that come
 * back. The lanes are in `split-merge-lanes.ts`, the volume rules in
 * `split-merge-evidence.ts`, the box arithmetic in `split-merge-geometry.ts`.
 *
 * It never retires a `DiffEntry` and never touches `counts`. A split binds
 * `k + 1` entities on ONE evidence chain, so a single wrong claim would delete
 * `k + 1` real changes; the claim is a claim, and the add/deletes stay exactly
 * where they were for a UI to group under it.
 */

import {
  displacedClaims,
  inPlaceClaims,
  resolveSplitMergeSettings,
  type SplitCandidate,
  type SplitMergeSettings,
} from './split-merge-lanes.js';
import { usableAabbOf } from './split-merge-geometry.js';
import type {
  DiffEntry,
  DiffOptions,
  EntityFingerprint,
  SplitMergeClaim,
  SplitMergeConfidence,
  SplitMergeKind,
} from './types.js';

/** Strongest evidence first. `verified` measured the geometry; `displaced`
 *  measured it too but lost position, the single strongest signal; `extent`
 *  never measured anything. */
const CONFIDENCE_RANK: Record<SplitMergeConfidence, number> = {
  verified: 0,
  displaced: 1,
  extent: 2,
};

/**
 * Find split and merge claims among the residue.
 *
 * `useGeometry` is the answer `diff.ts` already resolved and shares with both
 * other passes (`resolveUseGeometry`): false under `scope: 'data'`, and false
 * when the two revisions disagree about whether they carry geometry at all.
 * This stage INHERITS that abstention rather than re-deriving one, and unlike
 * the content pass it has no non-geometric fallback to degrade to — there is no
 * data-only evidence that one element became three.
 *
 * Abstaining returns `undefined`, NOT an empty array, and the distinction is
 * the published contract on {@link ModelDiff.splitMerges}: presence records
 * that the stage ran, emptiness records that it ran and found nothing. Shipping
 * `[]` under an abstention would report an executed detector to a caller using
 * presence to decide whether the answer means anything — the same
 * documented-as-absent / shipped-as-empty defect a comment promising a
 * guarantee the code does not provide would be. ONE place decides, here, so
 * `diff.ts` cannot disagree with it.
 *
 * Pure: never mutates its inputs.
 */
export function detectSplitMerge<TRef>(
  entries: readonly DiffEntry<TRef>[],
  useGeometry: boolean,
  options: DiffOptions,
): SplitMergeClaim<TRef>[] | undefined {
  if (!useGeometry) return undefined;
  const settings = resolveSplitMergeSettings(options);

  const added = new Map<string, SplitCandidate<TRef>[]>();
  const deleted = new Map<string, SplitCandidate<TRef>[]>();
  for (const entry of entries) {
    const fingerprint =
      entry.state === 'added' ? entry.head : entry.state === 'deleted' ? entry.base : undefined;
    if (!fingerprint) continue;
    // No box, no candidacy: every lane's first question is where the geometry
    // is, and there is no volume-only argument that one element became three.
    const aabb = usableAabbOf(fingerprint.aabb);
    if (!aabb) continue;
    const side = entry.state === 'added' ? added : deleted;
    const bucket = side.get(fingerprint.ifcType);
    if (bucket) bucket.push({ fingerprint, aabb });
    else side.set(fingerprint.ifcType, [{ fingerprint, aabb }]);
  }

  const candidates: SplitMergeClaim<TRef>[] = [];
  // Per `ifcType`, in BOTH directions. A split's whole is the deleted entity, a
  // merge's is the added one; everything downstream reads `whole` and `pieces`
  // and never has to know which way round it was found. Cross-class splits are
  // invisible by construction and named as a limitation rather than papered
  // over: an `IfcWall` becoming three `IfcWallStandardCase`s is not seen.
  for (const [ifcType, wholes] of deleted) {
    collect(candidates, wholes, added.get(ifcType), 'split', settings);
  }
  for (const [ifcType, wholes] of added) {
    collect(candidates, wholes, deleted.get(ifcType), 'merge', settings);
  }

  return resolveClaimConflicts(candidates);
}

function collect<TRef>(
  into: SplitMergeClaim<TRef>[],
  wholes: readonly SplitCandidate<TRef>[],
  pieces: readonly SplitCandidate<TRef>[] | undefined,
  kind: SplitMergeKind,
  settings: SplitMergeSettings,
): void {
  if (!pieces || pieces.length === 0) return;
  const inPlace = inPlaceClaims(wholes, pieces, kind, settings);
  into.push(...inPlace);

  // Lane 2 sees only what lane 1 did not take. Position is stronger evidence
  // than a signature, so a piece that is already explained where it stands is
  // not offered up as one that moved.
  const taken = new Set<EntityFingerprint<TRef>>();
  for (const claim of inPlace) for (const piece of claim.pieces) taken.add(piece);
  const remaining = pieces.filter((piece) => !taken.has(piece.fingerprint));
  if (remaining.length === 0) return;
  into.push(...displacedClaims(wholes, remaining, kind, settings));
}

/**
 * The evidence rank of a claim, WITHOUT the lexicographic tiebreak: confidence,
 * then how much of the residue it explains, then how well the volumes agreed.
 *
 * Two claims equal on all three are indistinguishable to the engine, which is
 * what the conflict rule below acts on.
 */
function evidenceRank<TRef>(claim: SplitMergeClaim<TRef>): [number, number, number] {
  return [
    CONFIDENCE_RANK[claim.confidence],
    -claim.pieces.length,
    claim.volumeResidual === undefined ? 0 : Math.abs(claim.volumeResidual),
  ];
}

function compareRank(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** Stable, machine-independent identity of a claim for the final tiebreak.
 *  Code-unit comparison only — `localeCompare` made an ordering depend on the
 *  host's ICU data in #1987. The pieces are already in a deterministic order
 *  when the claim is built.
 *
 *  NUL as the separator, written as an escape rather than as a literal byte:
 *  a GlobalId cannot contain one, so no two different claims can join to the
 *  same string — and a raw NUL in a source file makes git treat it as binary. */
function tiebreakKey<TRef>(claim: SplitMergeClaim<TRef>): string {
  return [claim.kind, claim.whole.key, ...claim.pieces.map((piece) => piece.key)].join('\u0000');
}

/** Every entity a claim binds. Object identity, not keys: a model that repeats
 *  a GlobalId still has two distinct entities, and conflating them here would
 *  make one claim block the other for no reason. */
function participants<TRef>(claim: SplitMergeClaim<TRef>): EntityFingerprint<TRef>[] {
  return [claim.whole, ...claim.pieces];
}

/** One candidate claim with the two keys the conflict pass orders it by. */
interface RankedClaim<TRef> {
  claim: SplitMergeClaim<TRef>;
  rank: [number, number, number];
  tiebreak: string;
}

/**
 * ONE global pass over every candidate claim from both directions and both
 * lanes.
 *
 * An added element can legitimately be both a split-piece of one deleted whole
 * and the merge-whole over several others, so the conflicts have to be settled
 * against all the candidates at once rather than per direction.
 *
 * Greedy, over a deterministic order: accept a claim when every entity it binds
 * is still unclaimed. The one refinement — a conflict decided ONLY by the final
 * lexicographic tiebreak drops BOTH claims. The tiebreak exists to make the
 * ordering reproducible, not to adjudicate: two claims the engine cannot tell
 * apart are an abstention, and picking the alphabetically earlier one would
 * dress a coin flip up as an answer (the #1923 lesson).
 *
 * A strictly weaker claim over some of those same entities is still allowed
 * afterwards. It is not the tie — it is a different proposition resting on its
 * own, lesser evidence, and refusing it would be punishing it for a dispute it
 * was not part of.
 *
 * "Drops both" does not generalise pairwise, which is why the tie is REMEMBERED
 * rather than merely undone. Retiring the incumbent frees every entity it held,
 * and a third equal-rank contender for the same material would then find the
 * gap empty and walk straight into it — the alphabet deciding after all, just
 * two steps later, and only for odd numbers of contenders. So the participants
 * of both sides of a tie are recorded as contested AT THAT RANK, and any later
 * claim of exactly that rank touching one of them is refused. Recording the
 * rank rather than a bare flag is what keeps the weaker-claim rule above true.
 */
export function resolveClaimConflicts<TRef>(
  candidates: readonly SplitMergeClaim<TRef>[],
): SplitMergeClaim<TRef>[] {
  const ordered: RankedClaim<TRef>[] = candidates
    .map((claim) => ({ claim, rank: evidenceRank(claim), tiebreak: tiebreakKey(claim) }))
    .sort((a, b) => {
      const byRank = compareRank(a.rank, b.rank);
      if (byRank !== 0) return byRank;
      if (a.tiebreak !== b.tiebreak) return a.tiebreak < b.tiebreak ? -1 : 1;
      return 0;
    });

  const claimedBy = new Map<EntityFingerprint<TRef>, RankedClaim<TRef>>();
  const accepted = new Set<RankedClaim<TRef>>();
  /** Entity → the rank at which an alphabet-only tie withdrew it from
   *  adjudication. The whole participant set of both sides is recorded, because
   *  that set IS the gap retiring the incumbent opened up. */
  const contestedAt = new Map<EntityFingerprint<TRef>, readonly number[]>();

  const contest = (entry: RankedClaim<TRef>): void => {
    for (const entity of participants(entry.claim)) contestedAt.set(entity, entry.rank);
  };

  for (const candidate of ordered) {
    // Is this a third (or fourth) equal contender for material an earlier tie
    // already declared undecidable? Ranks are ascending, so a recorded rank is
    // never stronger than this candidate's: equal means the tie, weaker means a
    // different, lesser proposition that is free to stand.
    let refusedByTie = false;
    for (const entity of participants(candidate.claim)) {
      const at = contestedAt.get(entity);
      if (at !== undefined && compareRank(at, candidate.rank) === 0) {
        refusedByTie = true;
        break;
      }
    }
    if (refusedByTie) continue;

    const blockers = new Set<RankedClaim<TRef>>();
    for (const entity of participants(candidate.claim)) {
      const holder = claimedBy.get(entity);
      if (holder && accepted.has(holder)) blockers.add(holder);
    }

    if (blockers.size === 0) {
      accepted.add(candidate);
      for (const entity of participants(candidate.claim)) claimedBy.set(entity, candidate);
      continue;
    }

    // Indistinguishable evidence: the only thing that put the incumbent first
    // was the alphabet. Retire it too rather than let the alphabet decide, and
    // remember the dispute so the next equal contender cannot inherit it.
    for (const blocker of blockers) {
      if (compareRank(blocker.rank, candidate.rank) !== 0) continue;
      accepted.delete(blocker);
      for (const entity of participants(blocker.claim)) claimedBy.delete(entity);
      contest(blocker);
      contest(candidate);
    }
  }

  return ordered.filter((entry) => accepted.has(entry)).map((entry) => entry.claim);
}
