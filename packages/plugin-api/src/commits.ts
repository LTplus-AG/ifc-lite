/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ============================================================================
// Commit-aware source API (contract 2.1.0) — models as a history of immutable
// commits.
//
// Additive to the 2.0.0 file/revision contract, never a replacement: a
// provider opts in by declaring `capabilities.commits`, and every member
// below is optional on `FileSourceProvider`. A `^2.0.0` provider that has
// never heard of a commit still registers and still works.
//
// The split across `commits.ts` / `commit-history.ts` / `commit-write.ts` /
// `commit-errors.ts` / `commit-provider.ts` is the module-size rule, not a
// layering claim — read them as one contract.
// ============================================================================

import type { SourceIdentity } from './auth.js';
import type { DownloadOptions, ListOptions } from './types.js';

// ---------------------------------------------------------------------------
// Capability declaration
// ---------------------------------------------------------------------------

/**
 * What `loadCommit` can hand back.
 *
 * `ifc-lite-cache` is RESERVED and not served by any v1 host: hydrating a
 * pre-parsed federated snapshot needs a load path that does not exist yet
 * (and lazy access to the source bytes for on-demand extraction). It is
 * spelled out here so the format list does not have to change when it lands.
 */
export type CommitPayloadFormat = 'ifc-step' | 'ifc-zip' | 'ifcx' | 'ifc-lite-cache';

/**
 * Presence of this object on {@link ProviderCapabilities} is what marks a
 * provider commit-aware. Each boolean gates exactly one method: the method is
 * present iff its flag is `true`, which `runCommitConformanceSuite` checks the
 * same way the 2.0.0 suite checks `listRevisions` against `revisionHistory`.
 *
 * `listModels`, `getModel`, `listCommits`, `getCommit` and `loadCommit` have
 * no flag — declaring `commits` at all requires them.
 */
export interface CommitCapabilities {
  /** Formats `loadCommit` can return, in the provider's order of preference. */
  readonly payloadFormats: readonly CommitPayloadFormat[];
  /** Provider implements `loadCommitFingerprints`. */
  readonly fingerprints: boolean;
  /** Provider implements `getCommitDiff`. */
  readonly storedDiffs: boolean;
  /** Provider implements `listElementHistory`. */
  readonly elementHistory: boolean;
  /** Provider implements `listIdentityRecords`. */
  readonly identityRecords: boolean;
  /** Provider implements `createModel`, `createCommit` and `recordIdentity`. */
  readonly write: boolean;
  /** Provider implements `watchCommits`. */
  readonly watch: boolean;
  /**
   * A model's id IS the id of the source file backing it, so a host holding
   * only a `SourceTag` can address the model directly as
   * `{ projectId, modelId: tag.fileId }`.
   *
   * Without this a host that loaded a file through the ordinary file browser
   * has no way to find the model it belongs to, and the History panel stays
   * empty for a model whose history the provider can serve perfectly well —
   * which is the Dalux case: its commits are file revisions discovered
   * through version sets, and the file id is the model id.
   *
   * `false` for a commit service whose model ids are its own (a model there
   * may be backed by several files over its life, or by none).
   */
  readonly modelIdsAreFileIds: boolean;
}

// ---------------------------------------------------------------------------
// Addressing
// ---------------------------------------------------------------------------

export interface ModelRef {
  readonly projectId: string;
  readonly modelId: string;
}

export interface CommitRef extends ModelRef {
  readonly commitId: string;
}

// ---------------------------------------------------------------------------
// Models and commits
// ---------------------------------------------------------------------------

/**
 * A named, versioned model inside a project — typically one discipline's
 * deliverable. Backed by one source file, by several over its life, or by
 * none at all (a commit service that never exposes files).
 */
export interface SourceModel {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  /** Container the model is filed under, when the provider has containers. */
  readonly containerId?: string;
  /** Controlled discipline code, when the provider classifies models. */
  readonly discipline?: string;
  /** Newest mainline commit. Empty only for a model with no commits yet. */
  readonly headCommitId: string;
  readonly commitCount?: number;
  readonly updatedAt?: string;
  readonly meta?: Record<string, unknown>;
}

/**
 * The original file bytes a commit was created from.
 *
 * `digest` is `<algorithm>:<value>` — the same opaque spelling as
 * `ModelIdentity.hash` in `@ifc-lite/diff`, so identity-map and lineage
 * sidecars pin to a commit with no format change.
 *
 * `sha256:<hex>` is STRONGLY preferred and is what a host can independently
 * verify against the bytes `loadCommit` returns. Another algorithm is
 * allowed because some stores expose only their own content hash and
 * relabelling it `sha256:` would be a claim nobody checked — but the cost is
 * real: a host cannot prove the payload matches the commit, and a sidecar
 * written against sha256 cannot pin to it. Declare what you actually have.
 *
 * Whatever the algorithm, the value MUST change when the bytes change and
 * MUST NOT change when only metadata does — the same rule as
 * `SourceFile.currentRevisionId`.
 */
export interface CommitArtifact {
  readonly digest: string;
  readonly fileName: string;
  readonly sizeBytes: number;
  /** Schema token from FILE_SCHEMA, e.g. `IFC4X3_ADD2`. */
  readonly schema?: string;
}

export interface CommitStats {
  readonly added: number;
  readonly modified: number;
  readonly deleted: number;
  readonly unchanged: number;
}

/**
 * `published` commits are visible to everyone who can see the model.
 * `pending` / `rejected` are visible only to users the provider authorizes;
 * a host badges them and never treats one as the head.
 */
export type CommitStatus = 'published' | 'pending' | 'rejected';

/** An immutable version of a model. Nothing here changes after creation. */
export interface SourceCommit {
  readonly id: string;
  readonly modelId: string;
  readonly projectId: string;
  /**
   * `parents[0]` is the mainline parent; empty for the first commit. More
   * than one parent is a merge. v1 hosts render the mainline and mark merges,
   * which is why the field is plural now rather than after a format break.
   */
  readonly parents: readonly string[];
  readonly createdAt: string;
  readonly author?: SourceIdentity;
  readonly message?: string;
  readonly status: CommitStatus;
  readonly artifact: CommitArtifact;
  /** Change counts against `parents[0]`, when the provider has computed them. */
  readonly stats?: CommitStats;
  /** Where the artifact came from, when it was synced from a file source. */
  readonly origin?: {
    readonly provider?: string;
    readonly fileId?: string;
    readonly revisionId?: string;
  };
  readonly meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Reading commits
// ---------------------------------------------------------------------------

export interface ListCommitsOptions extends ListOptions {
  /** Only commits created before this ISO timestamp. */
  readonly before?: string;
  /** Only commits created after this ISO timestamp. */
  readonly after?: string;
  /** Include `pending` / `rejected` commits the caller may see. Default false. */
  readonly includeUnpublished?: boolean;
}

export interface LoadCommitOptions extends DownloadOptions {
  /** Acceptable formats in the host's order of preference. */
  readonly accept?: readonly CommitPayloadFormat[];
}

export interface CommitPayload {
  readonly format: CommitPayloadFormat;
  /** File name the host should give the bytes, including extension. */
  readonly fileName: string;
  readonly bytes: ArrayBuffer;
  /**
   * Digest of the commit's original artifact, equal to
   * {@link CommitArtifact.digest}. Hosts verify it before loading: a payload
   * that does not hash to the commit it claims is a different model.
   */
  readonly artifactDigest: string;
}

// ---------------------------------------------------------------------------
// Watching
// ---------------------------------------------------------------------------

export interface CommitEvent {
  readonly modelId: string;
  readonly headCommitId: string;
  readonly previousHeadCommitId?: string;
  /** The model is gone upstream (deleted, or moved out of the user's reach). */
  readonly deleted?: boolean;
}

export interface CommitWatchResult {
  readonly events: readonly CommitEvent[];
  /** Same cursor semantics as `RevisionWatchResult.cursor`. */
  readonly cursor?: string;
}
