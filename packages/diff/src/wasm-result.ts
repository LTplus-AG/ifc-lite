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
  const entries: DiffEntry<TRef>[] = raw.entries.map(({ base: b, head: h, ...entry }) => ({
    ...entry,
    ...(b === undefined ? {} : { base: base[b] }),
    ...(h === undefined ? {} : { head: head[h] }),
  }));
  return {
    scope: raw.scope,
    excludedTypes: raw.excludedTypes,
    entries,
    counts: raw.counts,
    byKey: new Map(entries.map(entry => [entry.key, entry])),
    ...(raw.appliedKeyAliases === undefined ? {} : { appliedKeyAliases: new Map(raw.appliedKeyAliases) }),
    ...(raw.contentMatches === undefined ? {} : {
      contentMatches: raw.contentMatches.map(({ base: b, head: h, ...match }) => ({
        ...match, base: b.map(index => base[index]), head: h.map(index => head[index]),
      })),
    }),
    ...(raw.splitMerges === undefined ? {} : {
      splitMerges: raw.splitMerges.map(({ whole, pieces, excluded, ...claim }) => {
        const [wholeSide, pieceSide] = claim.kind === 'split' ? [base, head] : [head, base];
        return { ...claim, whole: wholeSide[whole], pieces: pieces.map(index => pieceSide[index]),
          ...(excluded === undefined ? {} : { excluded: pieceSide[excluded] }) };
      }),
    }),
    ...(raw.successors === undefined ? {} : {
      successors: raw.successors.map(({ base: b, head: h, ...claim }) => ({ ...claim, base: base[b], head: head[h] })),
    }),
  };
}
