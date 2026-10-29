/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The record a split/merge lane hands back: a candidate with a usable box, and
 * the one place a `SplitMergeClaim` is assembled (deterministic piece order,
 * volumes, the excluded interloper, the cross-class flag). Split out of
 * `split-merge-lanes.ts` for size; both lanes build their claims here.
 */

import { sameIfcClass } from './class-families.js';
import type { EntityAabb, EntityFingerprint, SplitMergeClaim, SplitMergeKind } from './types.js';

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

export function claimOf<TRef>(
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
  // A whole and its pieces from different classes of one family: the claim is
  // the same, but a reviewer should see that the class changed on the way.
  if (pieces.some((piece) => !sameIfcClass(piece.fingerprint.ifcType, whole.fingerprint.ifcType))) {
    claim.crossClass = true;
  }
  return claim;
}
