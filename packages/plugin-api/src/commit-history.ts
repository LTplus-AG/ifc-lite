/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ============================================================================
// What a commit-aware provider can answer WITHOUT transferring the model
// file: per-element fingerprints, a stored diff between any two commits, one
// element's history, and the reviewed identity between two commits.
//
// These shapes are structurally compatible with `@ifc-lite/diff`'s
// (`EntityFingerprint`, `IdentityMapEntry`) but restated here, because this
// package is dependency-free by contract. Structural, not nominal: a host
// converts with a spread, and the conformance suite pins the field names.
// ============================================================================

import type { CommitRef, CommitStats, ModelRef } from './commits.js';

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

/** `EntityFingerprint` from `@ifc-lite/diff`, minus its adapter-defined `ref`. */
export interface SourceFingerprint {
  /** Stable cross-commit identity: the IFC `GlobalId`, or the `keyProperty` value. */
  readonly key: string;
  readonly ifcType: string;
  readonly dataHash: string;
  /**
   * Hex string of the 64-bit geometry hash, or a `p:` placement string for
   * products with a placement but no mesh. A string rather than the engine's
   * `bigint` because these cross a JSON boundary; both sides of a diff must
   * use one representation, exactly as the engine requires.
   */
  readonly geometryHash?: string;
  readonly aabb?: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  };
  readonly volume?: number;
  readonly components?: Readonly<Record<string, string>>;
  readonly container?: string;
}

export interface CommitFingerprintSet {
  readonly format: 'ifc-lite/fingerprints';
  readonly version: 1;
  readonly commit: CommitRef;
  readonly artifactDigest: string;
  /** Absent means GlobalId keys. */
  readonly keyProperty?: string;
  /**
   * Producer, e.g. `@ifc-lite/diff@0.10.0`. Hashes are only comparable within
   * one engine major, so a host that cannot read this refuses the set rather
   * than reporting a whole model as changed.
   */
  readonly engine: string;
  readonly entries: readonly SourceFingerprint[];
  /** Present when the set is a sample rather than every element. */
  readonly sample?: { readonly total: number; readonly strategy: 'stratified-by-type' };
}

export interface LoadFingerprintsOptions {
  readonly keyProperty?: string;
  /** Upper bound on entries. The provider samples stratified by IFC type above it. */
  readonly maxEntries?: number;
  /** Omit geometry fields to reduce size. */
  readonly dataOnly?: boolean;
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Stored diffs
// ---------------------------------------------------------------------------

export type StoredDiffState = 'added' | 'modified' | 'deleted';
export type StoredChangeKind = 'data' | 'geometry' | 'container';

export interface StoredDiffEntry {
  /** Key in the head commit. For `deleted`, the key in the base commit. */
  readonly key: string;
  /** Base key when an identity record re-keyed the element. */
  readonly baseKey?: string;
  readonly ifcType: string;
  readonly state: StoredDiffState;
  readonly changeKinds: readonly StoredChangeKind[];
  /** Component keys as in `@ifc-lite/diff`, e.g. `attr:core`, `pset:Pset_WallCommon`. */
  readonly changedComponents?: readonly string[];
}

/** One reviewed "the base element and this one are the same thing" claim. */
export interface IdentityEntryLike {
  readonly base: string;
  readonly here: string;
  /** Same reason vocabulary as identity sidecars, e.g. `content-match:renamed`. */
  readonly reason: string;
}

export interface StoredCommitDiff {
  readonly format: 'ifc-lite/commit-diff';
  readonly version: 1;
  readonly base: CommitRef;
  readonly head: CommitRef;
  readonly engine: string;
  readonly options: {
    readonly scope: 'data' | 'geometry' | 'both';
    readonly matchUnpairedByContent: boolean;
    readonly keyProperty?: string;
  };
  readonly counts: CommitStats;
  /** Unchanged elements are omitted; `counts.unchanged` still reports them. */
  readonly entries: readonly StoredDiffEntry[];
  /** Identity entries applied as key aliases for this diff. */
  readonly appliedIdentity: readonly IdentityEntryLike[];
}

export interface GetCommitDiffOptions {
  readonly keyProperty?: string;
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Element history
// ---------------------------------------------------------------------------

export type ElementHistoryState =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'split'
  | 'merged'
  | 'replaced';

export interface ElementHistoryQuery extends ModelRef {
  /** Key of the element in `atCommitId` (default: the model head). */
  readonly key: string;
  readonly keyProperty?: string;
  readonly atCommitId?: string;
}

export interface ElementHistoryEntry {
  readonly commitId: string;
  readonly createdAt: string;
  /** The element's key in THIS commit — differs from the query key after a rename. */
  readonly key: string;
  readonly state: ElementHistoryState;
  readonly changeKinds: readonly StoredChangeKind[];
  readonly changedComponents?: readonly string[];
  /** Other keys involved: the old key after `renamed`, the pieces after `split`, the sources after `merged`. */
  readonly relatedKeys?: readonly string[];
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// Reviewed identity
// ---------------------------------------------------------------------------

/**
 * Converts losslessly to an `IdentityMapSidecar` whose `base.hash` /
 * `head.hash` are the two artifact digests — which is why both refs carry
 * their digest inline rather than making the host re-fetch the commits.
 */
export interface IdentityRecordSet {
  readonly base: CommitRef & { readonly artifactDigest: string };
  readonly head: CommitRef & { readonly artifactDigest: string };
  readonly keyProperty?: string;
  readonly entries: readonly (IdentityEntryLike & {
    readonly reviewedBy?: string;
    readonly reviewedAt?: string;
  })[];
}
