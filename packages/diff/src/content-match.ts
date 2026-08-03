/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The content-keyed matching pass (issue #1891): pair up the entities the
 * key-based pass in `diff.ts` classified as `added`/`deleted`, for the case
 * where GlobalIds are unreliable (a from-scratch re-export re-GUIDs
 * everything).
 *
 * Entities are bucketed by (`ifcType`, `dataHash`) and then refined
 * *hierarchically inside* each bucket. The outer key deliberately does not
 * include geometry: an element that genuinely moved would then land in a
 * different bucket from its own previous revision and could never be paired at
 * all, so every real move would revert to add+delete noise. Geometry is a
 * local decision within the bucket.
 */

import {
  classifyPair,
  componentsAgree,
  fingerprintsOf,
  groupKind,
  pairByPosition,
  refineByGeometryHash,
  type Candidate,
} from './content-tiers.js';
import type { GeometryTolerances } from './geometry-compare.js';
import type {
  ContentMatch,
  ContentMatchKind,
  ContentMatchTier,
  DiffCounts,
  DiffEntry,
  EntityFingerprint,
} from './types.js';

/**
 * Bucket key for the content pass.
 *
 * {@link EntityFingerprint.dataHash} alone is a 64-bit FNV-1a hex string
 * (`stableHash`, widened from 32 bits in issue #1962). It is a drift-catching
 * hash, not a cryptographic one, and the exposure grows with the square of the
 * number of distinct fingerprints compared — a from-scratch re-export leaves
 * the whole model unpaired. Pairing on `dataHash` alone would retire a real
 * `added` and a real `deleted` entry in favour of a fabricated match.
 *
 * Folding `ifcType` in as plaintext costs nothing and cannot reject a real
 * match: `buildDataFingerprint` already hashes `ifcType` as part of its
 * payload, so equal content implies equal `ifcType`. A disagreement therefore
 * *proves* the shared `dataHash` was a collision.
 */
function contentBucketKey<TRef>(entity: EntityFingerprint<TRef>): string {
  // NUL separator: `ifcType` is an IFC class name and never contains one, so
  // no ifcType/dataHash pair can be confused with another.
  return `${entity.ifcType}\u0000${entity.dataHash}`;
}

function bucketCandidates<TRef>(
  entries: readonly DiffEntry<TRef>[],
): {
  addedByBucket: Map<string, Candidate<TRef>[]>;
  deletedByBucket: Map<string, Candidate<TRef>[]>;
} {
  const addedByBucket = new Map<string, Candidate<TRef>[]>();
  const deletedByBucket = new Map<string, Candidate<TRef>[]>();

  const push = (map: Map<string, Candidate<TRef>[]>, candidate: Candidate<TRef>): void => {
    const key = contentBucketKey(candidate.fingerprint);
    const list = map.get(key);
    if (list) list.push(candidate);
    else map.set(key, [candidate]);
  };

  for (const entry of entries) {
    if (entry.state === 'added' && entry.head) {
      push(addedByBucket, { entry, fingerprint: entry.head });
    } else if (entry.state === 'deleted' && entry.base) {
      push(deletedByBucket, { entry, fingerprint: entry.base });
    }
  }

  return { addedByBucket, deletedByBucket };
}

/**
 * Content-keyed matching over the leftover `added`/`deleted` entries.
 *
 * `useGeometry` is resolved once by `diff.ts` and shared with the key-based
 * pass (`resolveUseGeometry`). It is false under `scope: 'data'`, where geometry
 * is excluded from the comparison, and false when the two revisions disagree on
 * whether they carry geometry hashes at all. Either way no geometry
 * sub-bucketing happens and every 1:1 match reports as `renamed` — a
 * geometry-derived `moved` would report a difference the caller either opted out
 * of seeing or that the fingerprints cannot support.
 *
 * `DiffState`/`DiffEntry` are never widened by this pass: it only removes
 * entries or leaves them alone, so downstream code that exhaustively switches
 * over `DiffState` needs no changes.
 *
 * Pure: never mutates its inputs.
 */
export function applyContentMatching<TRef>(
  entries: DiffEntry<TRef>[],
  counts: DiffCounts,
  useGeometry: boolean,
  tolerances: GeometryTolerances,
): { entries: DiffEntry<TRef>[]; counts: DiffCounts; contentMatches: ContentMatch<TRef>[] } {
  const { addedByBucket, deletedByBucket } = bucketCandidates(entries);

  const retired = new Set<DiffEntry<TRef>>();
  const contentMatches: ContentMatch<TRef>[] = [];
  let removedAdded = 0;
  let removedDeleted = 0;

  const retire = (
    bases: readonly Candidate<TRef>[],
    heads: readonly Candidate<TRef>[],
    dataHash: string,
    kind: ContentMatchKind,
    tier: ContentMatchTier,
    distance?: number,
  ): void => {
    for (const candidate of bases) {
      retired.add(candidate.entry);
      removedDeleted++;
    }
    for (const candidate of heads) {
      retired.add(candidate.entry);
      removedAdded++;
    }
    const match: ContentMatch<TRef> = {
      kind,
      tier,
      dataHash,
      base: bases.map((candidate) => candidate.fingerprint),
      head: heads.map((candidate) => candidate.fingerprint),
    };
    if (distance !== undefined) match.distance = distance;
    contentMatches.push(match);
  };

  for (const [bucketKey, headGroup] of addedByBucket) {
    const baseGroup = deletedByBucket.get(bucketKey);
    if (!baseGroup || baseGroup.length === 0) continue;
    const dataHash = headGroup[0]?.fingerprint.dataHash;
    if (dataHash === undefined) continue;

    let residueBase: readonly Candidate<TRef>[] = baseGroup;
    let residueHead: readonly Candidate<TRef>[] = headGroup;

    if (useGeometry) {
      const refined = refineByGeometryHash(baseGroup, headGroup);
      for (const group of refined.resolved) {
        retire(group.bases, group.heads, dataHash, 'renamed', 'geometry-hash');
      }
      residueBase = refined.residueBase;
      residueHead = refined.residueHead;
    }

    if (residueBase.length === 0 || residueHead.length === 0) continue;

    if (residueBase.length === 1 && residueHead.length === 1) {
      // TIER 2. This is the one destructive path resting on the data hash
      // alone — no geometry hash agreed, so `componentsAgree` and the bucket's
      // `ifcType` are all that stand between a genuine re-GUID and a retired
      // pair of unrelated entities. The false-positive budget of the whole
      // feature concentrates here; every other retiring path also had a world
      // geometry hash or a mutual-nearest-neighbour agreement behind it.
      const base = residueBase[0];
      const head = residueHead[0];
      if (componentsAgree([base.fingerprint, head.fingerprint])) {
        const { kind, distance } = classifyPair(
          base.fingerprint,
          head.fingerprint,
          useGeometry,
          tolerances,
        );
        retire([base], [head], dataHash, kind, 'residue-1-1', distance);
      }
      // Guard rejected: a proven collision. Report nothing rather than a match.
      continue;
    }

    const positioned = pairByPosition(residueBase, residueHead, useGeometry, tolerances);
    for (const [base, head] of positioned.pairs) {
      const { kind, distance } = classifyPair(
        base.fingerprint,
        head.fingerprint,
        useGeometry,
        tolerances,
      );
      retire([base], [head], dataHash, kind, 'positional', distance);
    }

    const { leftoverBase, leftoverHead } = positioned;
    if (leftoverBase.length === 0 || leftoverHead.length === 0) continue;
    contentMatches.push({
      kind: groupKind(leftoverBase.length, leftoverHead.length),
      tier: 'unresolved',
      dataHash,
      base: fingerprintsOf(leftoverBase),
      head: fingerprintsOf(leftoverHead),
    });
  }

  if (retired.size === 0) {
    return { entries, counts, contentMatches };
  }

  const nextEntries = entries.filter((entry) => !retired.has(entry));
  const nextCounts: DiffCounts = {
    ...counts,
    added: counts.added - removedAdded,
    deleted: counts.deleted - removedDeleted,
  };

  return { entries: nextEntries, counts: nextCounts, contentMatches };
}
