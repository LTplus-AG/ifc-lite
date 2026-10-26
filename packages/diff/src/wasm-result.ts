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
export function restoreDiffReferences<TRef>(raw: IndexedDiff, base: readonly EntityFingerprint<TRef>[], head: readonly EntityFingerprint<TRef>[]): ModelDiff<TRef> {
  const entries: DiffEntry<TRef>[] = raw.entries.map(entry => ({
    key: entry.key, state: entry.state, changeKinds: entry.changeKinds,
    ...(entry.base === undefined ? {} : { base: base[entry.base] }),
    ...(entry.head === undefined ? {} : { head: head[entry.head] }),
    ...(entry.changedComponents === undefined ? {} : { changedComponents: entry.changedComponents }),
  }));
  return {
    scope: raw.scope,
    excludedTypes: raw.excludedTypes,
    entries,
    byKey: new Map(entries.map(entry => [entry.key, entry])),
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
