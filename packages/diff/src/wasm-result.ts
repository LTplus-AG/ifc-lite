/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ContentMatch, DiffEntry, EntityFingerprint, ModelDiff, SplitMergeClaim, SuccessorClaim } from './types.js';

type IndexedEntry = Omit<DiffEntry, 'base' | 'head'> & { base?: number; head?: number };
type IndexedContent = Omit<ContentMatch, 'base' | 'head'> & { base: number[]; head: number[] };
type IndexedSplit = Omit<SplitMergeClaim, 'whole' | 'pieces' | 'excluded'> & { whole: number; pieces: number[]; excluded?: number };
type IndexedSuccessor = Omit<SuccessorClaim, 'base' | 'head'> & { base: number; head: number };
export type IndexedDiff = Omit<ModelDiff, 'entries' | 'byKey' | 'appliedKeyAliases' | 'contentMatches' | 'splitMerges' | 'successors'> & {
  entries: IndexedEntry[];
  appliedKeyAliases?: [string, string][];
  contentMatches?: IndexedContent[];
  splitMerges?: IndexedSplit[];
  successors?: IndexedSuccessor[];
};

/** Reuse the original entity objects, including opaque refs, in every result. */
export function restoreDiffReferences<TRef>(raw: IndexedDiff, base: readonly EntityFingerprint<TRef>[], head: readonly EntityFingerprint<TRef>[], keys?: readonly [readonly string[], readonly string[]]): ModelDiff<TRef> {
  // The decoded records are owned by this call. Restore in place so a second
  // object graph and an intermediate Map tuple array never become live (#8042).
  const entries = raw.entries as unknown as DiffEntry<TRef>[];
  const byKey = new Map<string, DiffEntry<TRef>>();
  for (const indexed of raw.entries) {
    const baseIndex = indexed.base, headIndex = indexed.head;
    const entry = indexed as unknown as DiffEntry<TRef>;
    entry.key = baseIndex === undefined
      ? (keys ? keys[1][headIndex!] : head[headIndex!].key)
      : (keys ? keys[0][baseIndex] : base[baseIndex].key);
    if (baseIndex !== undefined) entry.base = base[baseIndex];
    if (headIndex !== undefined) entry.head = head[headIndex];
    byKey.set(entry.key, entry);
  }
  return {
    scope: raw.scope,
    excludedTypes: raw.excludedTypes,
    entries,
    byKey,
    counts: raw.counts,
    ...(raw.contentMatches === undefined ? {} : {
      contentMatches: raw.contentMatches.map(match => ({
        kind: match.kind, tier: match.tier, dataHash: match.dataHash,
        ...(match.geometryHash === undefined ? {} : { geometryHash: match.geometryHash }),
        base: match.base.map(index => base[index]), head: match.head.map(index => head[index]),
        ...(match.changedComponents === undefined ? {} : { changedComponents: match.changedComponents }),
        ...(match.distance === undefined ? {} : { distance: match.distance }),
      })),
    }),
    ...(raw.appliedKeyAliases === undefined ? {} : { appliedKeyAliases: new Map(raw.appliedKeyAliases) }),
    ...(raw.splitMerges === undefined ? {} : {
      splitMerges: raw.splitMerges.map(claim => {
        const [wholeSide, pieceSide] = claim.kind === 'split' ? [base, head] : [head, base];
        return {
          kind: claim.kind, confidence: claim.confidence, whole: wholeSide[claim.whole],
          pieces: claim.pieces.map(index => pieceSide[index]),
          ...(claim.wholeVolume === undefined ? {} : { wholeVolume: claim.wholeVolume }),
          ...(claim.piecesVolume === undefined ? {} : { piecesVolume: claim.piecesVolume }),
          ...(claim.volumeResidual === undefined ? {} : { volumeResidual: claim.volumeResidual }),
          ...(claim.excluded === undefined ? {} : { excluded: pieceSide[claim.excluded] }),
          ...(claim.crossClass === undefined ? {} : { crossClass: claim.crossClass }),
        };
      }),
    }),
    ...(raw.successors === undefined ? {} : {
      successors: raw.successors.map(claim => ({
        confidence: claim.confidence, base: base[claim.base], head: head[claim.head],
        overlap: claim.overlap, distance: claim.distance,
        ...(claim.agreeingComponents === undefined ? {} : { agreeingComponents: claim.agreeingComponents }),
        ...(claim.crossClass === undefined ? {} : { crossClass: claim.crossClass }),
      })),
    }),
  };
}
