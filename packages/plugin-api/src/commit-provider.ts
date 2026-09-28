/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ============================================================================
// The commit half of `FileSourceProvider`, which extends this interface.
//
// Every member is optional. Which ones are actually present is decided by
// `capabilities.commits`: the five reads at the top are required whenever
// that object exists at all, and each of the rest is present iff its flag is
// `true`. A host therefore never has to feature-detect by calling.
// ============================================================================

import type {
  CommitFingerprintSet,
  ElementHistoryEntry,
  ElementHistoryQuery,
  GetCommitDiffOptions,
  IdentityEntryLike,
  IdentityRecordSet,
  LoadFingerprintsOptions,
  StoredCommitDiff,
} from './commit-history.js';
import type { CreateCommitInput, CreateModelInput } from './commit-write.js';
import type {
  CommitPayload,
  CommitRef,
  CommitWatchResult,
  ListCommitsOptions,
  LoadCommitOptions,
  ModelRef,
  SourceCommit,
  SourceModel,
} from './commits.js';
import type { ListOptions, Page, PluginContext } from './types.js';

export interface ListModelsOptions extends ListOptions {
  /** Case-insensitive name filter. */
  readonly query?: string;
}

export interface CommitSourceMethods {
  // -- Required when `capabilities.commits` is present -----------------------

  /** Most recently updated first. */
  listModels?(ctx: PluginContext, projectId: string, options?: ListModelsOptions): Promise<Page<SourceModel>>;
  getModel?(ctx: PluginContext, ref: ModelRef): Promise<SourceModel>;
  /** Newest first by `createdAt`, ties broken by commit id. Published only unless asked. */
  listCommits?(ctx: PluginContext, ref: ModelRef, options?: ListCommitsOptions): Promise<Page<SourceCommit>>;
  getCommit?(ctx: PluginContext, ref: CommitRef): Promise<SourceCommit>;
  /**
   * First format in `options.accept` the provider can serve; throws
   * `unsupported-format` when none match. `artifactDigest` must equal the
   * commit's own — the host checks it before loading.
   */
  loadCommit?(ctx: PluginContext, ref: CommitRef, options?: LoadCommitOptions): Promise<CommitPayload>;

  // -- Gated by their capability flag ---------------------------------------

  /** Fingerprints of the commit's elements. Samples only when `maxEntries` is set and exceeded. */
  loadCommitFingerprints?(
    ctx: PluginContext,
    ref: CommitRef,
    options?: LoadFingerprintsOptions,
  ): Promise<CommitFingerprintSet>;
  /**
   * Any two commits of one model, not only adjacent ones. May throw
   * `not-ready` with `retryAfterMs` while the provider computes it.
   */
  getCommitDiff?(
    ctx: PluginContext,
    base: CommitRef,
    head: CommitRef,
    options?: GetCommitDiffOptions,
  ): Promise<StoredCommitDiff>;
  /**
   * Newest first, following identity and lineage records so a renamed
   * element keeps ONE history. Stops at `added`.
   */
  listElementHistory?(
    ctx: PluginContext,
    query: ElementHistoryQuery,
    options?: ListOptions,
  ): Promise<Page<ElementHistoryEntry>>;
  listIdentityRecords?(ctx: PluginContext, base: CommitRef, head: CommitRef): Promise<IdentityRecordSet>;

  /** Creates an EMPTY model; the caller then commits with `expectedParentId: null`. */
  createModel?(ctx: PluginContext, input: CreateModelInput): Promise<SourceModel>;
  /**
   * Atomic. Throws `conflict` with the current head in
   * `details.headCommitId` when `expectedParentId` is not the model's head.
   * Replaying an `idempotencyKey` returns the original commit.
   */
  createCommit?(ctx: PluginContext, input: CreateCommitInput): Promise<SourceCommit>;
  /** Recording the same `(base, here)` pair twice is a no-op; a conflicting claim throws `conflict`. */
  recordIdentity?(
    ctx: PluginContext,
    base: CommitRef,
    head: CommitRef,
    entries: readonly IdentityEntryLike[],
  ): Promise<IdentityRecordSet>;

  /** Same cursor semantics as `watchRevisions`. One event per model whose head moved. */
  watchCommits?(
    ctx: PluginContext,
    models: readonly ModelRef[],
    cursor?: string,
    options?: ListOptions,
  ): Promise<CommitWatchResult>;
}
