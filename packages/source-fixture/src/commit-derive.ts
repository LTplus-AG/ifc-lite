/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ============================================================================
// Stored diffs and element history, DERIVED from the fingerprints a fixture
// commit declares — never stored separately.
//
// Deriving rather than declaring is the whole point: a fixture that let a
// test write `entries` and `counts` by hand could state a diff its own
// fingerprints contradict, and the conformance suite's "counts match entries"
// check would then be measuring the fixture author's arithmetic instead of a
// provider's. Here the two cannot disagree.
//
// This is NOT `@ifc-lite/diff`, and deliberately does not call it: that
// package is a dev dependency of this one (type compatibility is asserted in
// `commit-diff-shape.test.ts`), because a conformance oracle that needs the
// real engine would need the wasm runtime behind it. What a provider's stored
// diff has to satisfy is a contract about SHAPE and internal consistency, and
// key-set comparison over declared fingerprints settles that completely.
// ============================================================================

import type {
  CommitRef,
  CommitStats,
  ElementHistoryEntry,
  IdentityEntryLike,
  SourceFingerprint,
  StoredChangeKind,
  StoredCommitDiff,
  StoredDiffEntry,
} from '@ifc-lite/plugin-api';

/** The engine token the fixture stamps on everything it derives. */
export const FIXTURE_ENGINE = '@ifc-lite/source-fixture@0';

/** One commit, reduced to what a derivation needs. */
export interface DerivableCommit {
  readonly id: string;
  readonly createdAt: string;
  readonly fingerprints: readonly SourceFingerprint[];
  /** Reviewed identity against `parents[0]`: `base` is a key in the parent. */
  readonly identity: readonly IdentityEntryLike[];
}

/**
 * Composes the identity records along `chain` (oldest child first, i.e. the
 * commit right after the base, through to the head) into one map from a key
 * in the BASE commit to the key the same element carries in the HEAD commit.
 *
 * Composition matters: an element re-GUIDed twice across three commits has
 * two records, and a diff of the first commit against the third must follow
 * both or it reports one deletion and one addition for an element that was
 * never anything but renamed.
 */
function composeIdentity(chain: readonly DerivableCommit[]): Map<string, string> {
  const baseToHead = new Map<string, string>();
  for (const commit of chain) {
    const step = new Map(commit.identity.map((entry) => [entry.base, entry.here] as const));
    if (step.size === 0) continue;
    // Re-point every alias already accumulated, then adopt the ones this step
    // introduces for keys nothing has aliased yet.
    for (const [base, current] of baseToHead) {
      const next = step.get(current);
      if (next !== undefined) baseToHead.set(base, next);
    }
    const aliased = new Set(baseToHead.values());
    for (const [base, here] of step) {
      if (!aliased.has(here) && !baseToHead.has(base)) baseToHead.set(base, here);
    }
  }
  return baseToHead;
}

/** Every identity record applied between `base` and `head`, flattened. */
function appliedIdentity(chain: readonly DerivableCommit[]): IdentityEntryLike[] {
  return chain.flatMap((commit) => [...commit.identity]);
}

function changeKinds(base: SourceFingerprint, head: SourceFingerprint): StoredChangeKind[] {
  const kinds: StoredChangeKind[] = [];
  if (base.dataHash !== head.dataHash) kinds.push('data');
  if (base.geometryHash !== head.geometryHash) kinds.push('geometry');
  if (base.container !== head.container) kinds.push('container');
  return kinds;
}

/** Component keys present on either side whose hashes differ. Sorted, so the derivation is deterministic. */
function changedComponents(base: SourceFingerprint, head: SourceFingerprint): string[] {
  const names = new Set([...Object.keys(base.components ?? {}), ...Object.keys(head.components ?? {})]);
  const changed: string[] = [];
  for (const name of names) {
    if (base.components?.[name] !== head.components?.[name]) changed.push(name);
  }
  return changed.sort();
}

export interface DeriveDiffInput {
  readonly base: DerivableCommit;
  readonly head: DerivableCommit;
  readonly baseRef: CommitRef;
  readonly headRef: CommitRef;
  /** Commits strictly after `base` up to and including `head`, oldest first. */
  readonly chain: readonly DerivableCommit[];
  readonly keyProperty?: string;
}

/**
 * Classifies every element of `base` against `head`.
 *
 * Unchanged elements are counted and then dropped, exactly as the contract
 * says: a commit whose 40,000 elements are all untouched must not push 40,000
 * rows across the wire for a panel that shows none of them.
 */
export function deriveCommitDiff(input: DeriveDiffInput): StoredCommitDiff {
  const { base, head, chain, keyProperty } = input;
  const alias = composeIdentity(chain);

  // Base fingerprints, re-keyed into head space so an aliased element pairs
  // by key like any other. `baseKeyOf` keeps the original for reporting.
  const baseByHeadKey = new Map<string, SourceFingerprint>();
  const baseKeyOf = new Map<string, string>();
  for (const fingerprint of base.fingerprints) {
    const headKey = alias.get(fingerprint.key) ?? fingerprint.key;
    baseByHeadKey.set(headKey, fingerprint);
    baseKeyOf.set(headKey, fingerprint.key);
  }

  const entries: StoredDiffEntry[] = [];
  const counts = { added: 0, modified: 0, deleted: 0, unchanged: 0 };
  const paired = new Set<string>();

  for (const headFingerprint of head.fingerprints) {
    const baseFingerprint = baseByHeadKey.get(headFingerprint.key);
    if (!baseFingerprint) {
      counts.added += 1;
      entries.push({ key: headFingerprint.key, ifcType: headFingerprint.ifcType, state: 'added', changeKinds: [] });
      continue;
    }
    paired.add(headFingerprint.key);
    const kinds = changeKinds(baseFingerprint, headFingerprint);
    if (kinds.length === 0) {
      counts.unchanged += 1;
      continue;
    }
    counts.modified += 1;
    const components = changedComponents(baseFingerprint, headFingerprint);
    const originalKey = baseKeyOf.get(headFingerprint.key);
    entries.push({
      key: headFingerprint.key,
      ...(originalKey !== undefined && originalKey !== headFingerprint.key ? { baseKey: originalKey } : {}),
      ifcType: headFingerprint.ifcType,
      state: 'modified',
      changeKinds: kinds,
      ...(components.length > 0 ? { changedComponents: components } : {}),
    });
  }

  for (const [headKey, baseFingerprint] of baseByHeadKey) {
    if (paired.has(headKey)) continue;
    counts.deleted += 1;
    // For a deletion the contract puts the BASE key in `key`: there is no
    // head-side element to name, so an alias would point at nothing.
    entries.push({ key: baseFingerprint.key, ifcType: baseFingerprint.ifcType, state: 'deleted', changeKinds: [] });
  }

  return {
    format: 'ifc-lite/commit-diff',
    version: 1,
    base: input.baseRef,
    head: input.headRef,
    engine: FIXTURE_ENGINE,
    options: { scope: 'both', matchUnpairedByContent: false, ...(keyProperty !== undefined ? { keyProperty } : {}) },
    counts: counts satisfies CommitStats,
    entries,
    appliedIdentity: appliedIdentity(chain),
  };
}

export interface DeriveHistoryInput {
  /** The mainline from the queried commit back to the model's first commit, newest first. */
  readonly mainline: readonly DerivableCommit[];
  /** Key of the element in `mainline[0]`. */
  readonly key: string;
}

/**
 * One element's history, newest first, stopping at `added`.
 *
 * It walks BACKWARDS and rewrites the key it is tracking whenever an identity
 * record says the element used to be called something else — which is the
 * only reason this is a walk and not a filter. A re-GUIDed element has a
 * different key in every era of its life, and a history that searched for one
 * key would show it being born on the day it was renamed.
 *
 * Commits where the element did not change are omitted (see open question 1
 * in the spec: an `unchanged`-inclusive mode is not in v1).
 */
export function deriveElementHistory(input: DeriveHistoryInput): ElementHistoryEntry[] {
  const { mainline } = input;
  const entries: ElementHistoryEntry[] = [];
  let currentKey = input.key;

  for (let i = 0; i < mainline.length; i++) {
    const commit = mainline[i];
    const parent = mainline[i + 1];
    const present = commit.fingerprints.find((f) => f.key === currentKey);

    if (!parent) {
      // The model's first commit: an element present here was born here.
      if (present) {
        entries.push({ commitId: commit.id, createdAt: commit.createdAt, key: currentKey, state: 'added', changeKinds: [] });
      }
      break;
    }

    const rename = commit.identity.find((entry) => entry.here === currentKey && entry.base !== currentKey);
    const previousKey = rename ? rename.base : currentKey;
    const before = parent.fingerprints.find((f) => f.key === previousKey);

    if (!present) {
      // Gone in this commit but present in its parent: the element was deleted
      // HERE, and everything older is still its history.
      if (before) {
        entries.push({ commitId: commit.id, createdAt: commit.createdAt, key: currentKey, state: 'deleted', changeKinds: [] });
      }
      currentKey = previousKey;
      continue;
    }

    if (!before) {
      entries.push({ commitId: commit.id, createdAt: commit.createdAt, key: currentKey, state: 'added', changeKinds: [] });
      break;
    }

    const kinds = changeKinds(before, present);
    const components = changedComponents(before, present);
    if (rename) {
      entries.push({
        commitId: commit.id,
        createdAt: commit.createdAt,
        key: currentKey,
        state: 'renamed',
        changeKinds: kinds,
        ...(components.length > 0 ? { changedComponents: components } : {}),
        relatedKeys: [rename.base],
        reason: rename.reason,
      });
    } else if (kinds.length > 0) {
      entries.push({
        commitId: commit.id,
        createdAt: commit.createdAt,
        key: currentKey,
        state: 'modified',
        changeKinds: kinds,
        ...(components.length > 0 ? { changedComponents: components } : {}),
      });
    }
    currentKey = previousKey;
  }

  return entries;
}
