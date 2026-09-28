/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ============================================================================
// The fixture's implementation of the commit half of `FileSourceProvider`.
//
// Split out of `provider.ts` rather than added to it: that file already owns
// the 2.0.0 surface, and the two halves share nothing but the guard and the
// pager, which are passed in.
// ============================================================================

import type {
  CommitFingerprintSet,
  CommitEvent,
  CommitPayload,
  CommitRef,
  CommitWatchResult,
  CreateCommitInput,
  CreateModelInput,
  ElementHistoryEntry,
  ElementHistoryQuery,
  GetCommitDiffOptions,
  IdentityEntryLike,
  IdentityRecordSet,
  ListCommitsOptions,
  ListModelsOptions,
  ListOptions,
  LoadCommitOptions,
  LoadFingerprintsOptions,
  ModelRef,
  Page,
  PluginContext,
  SourceCommit,
  SourceFingerprint,
  SourceModel,
  StoredCommitDiff,
} from '@ifc-lite/plugin-api';

import {
  FixtureCommitIndex,
  deriveCommitDiff,
  deriveElementHistory,
  type RuntimeCommit,
} from './commit-data.js';
import { FIXTURE_ENGINE } from './commit-derive.js';
import { FixtureCommitError } from './errors.js';
import type { FixtureMethodName, InjectedFailure } from './failures.js';
import { applyTruncate } from './failures.js';
import { paginate } from './paging.js';

export interface CommitMethodDeps {
  readonly index: FixtureCommitIndex;
  readonly maxPageSize: number;
  readonly payloadFormats: readonly ('ifc-step' | 'ifc-zip' | 'ifcx' | 'ifc-lite-cache')[];
  /** Shared abort / sign-in / failure-injection gate from `provider.ts`. */
  readonly guard: (method: FixtureMethodName, ctx: PluginContext, signal: AbortSignal | undefined) => Promise<void>;
  readonly failureFor: (method: FixtureMethodName) => InjectedFailure | undefined;
  /** Author stamped on commits the write path creates. */
  readonly identity: { readonly id: string; readonly displayName?: string };
}

function contextKey(method: string, ...parts: string[]): string {
  return `${method}:${parts.join(':')}`;
}

/** One hour past the model's newest commit; a fixed epoch for an empty model. */
function nextCommitTimestamp(model: { readonly commits: readonly RuntimeCommit[] }): string {
  const newest = model.commits.reduce(
    (max, commit) => Math.max(max, Date.parse(commit.createdAt)),
    Number.NEGATIVE_INFINITY,
  );
  return new Date(Number.isFinite(newest) ? newest + 3_600_000 : 1700000000000).toISOString();
}

function refOf(commit: RuntimeCommit): CommitRef {
  return { projectId: commit.projectId, modelId: commit.modelId, commitId: commit.id };
}

/**
 * Stratified sampling by IFC type — the one strategy the contract names.
 * Round-robins across type buckets so a `maxEntries` well below the element
 * count still returns every type, which is what makes a sampled set useful to
 * the revision resolver at all.
 */
function sampleByType(entries: readonly SourceFingerprint[], maxEntries: number): SourceFingerprint[] {
  const buckets = new Map<string, SourceFingerprint[]>();
  for (const entry of entries) {
    const bucket = buckets.get(entry.ifcType);
    if (bucket) bucket.push(entry);
    else buckets.set(entry.ifcType, [entry]);
  }
  const lists = [...buckets.values()];
  const sampled: SourceFingerprint[] = [];
  for (let round = 0; sampled.length < maxEntries; round++) {
    let tookAny = false;
    for (const list of lists) {
      if (sampled.length >= maxEntries) break;
      const entry = list[round];
      if (entry === undefined) continue;
      sampled.push(entry);
      tookAny = true;
    }
    if (!tookAny) break;
  }
  return sampled;
}

export function createCommitMethods(deps: CommitMethodDeps) {
  const { index, maxPageSize, guard, failureFor } = deps;
  /** Commits already minted under an idempotency key, so a replay returns the original. */
  const byIdempotencyKey = new Map<string, SourceCommit>();

  async function listModels(ctx: PluginContext, projectId: string, options?: ListModelsOptions): Promise<Page<SourceModel>> {
    await guard('listModels', ctx, options?.signal);
    const query = options?.query;
    const models = index.listModels(projectId)
      .filter((model) => !query || model.name.toLowerCase().includes(query.toLowerCase()))
      .map((model) => index.toSourceModel(model));
    // Most recently updated first, as the contract requires.
    models.sort((a, b) => (a.updatedAt ?? '') < (b.updatedAt ?? '') ? 1 : (a.updatedAt ?? '') > (b.updatedAt ?? '') ? -1 : 0);
    return applyTruncate(paginate(models, contextKey('listModels', projectId, query ?? ''), options, maxPageSize), failureFor('listModels'));
  }

  async function getModel(ctx: PluginContext, ref: ModelRef): Promise<SourceModel> {
    await guard('getModel', ctx, undefined);
    return index.toSourceModel(index.getModel(ref.projectId, ref.modelId));
  }

  async function listCommits(ctx: PluginContext, ref: ModelRef, options?: ListCommitsOptions): Promise<Page<SourceCommit>> {
    await guard('listCommits', ctx, options?.signal);
    let commits = index.listCommits(ref.projectId, ref.modelId, options?.includeUnpublished ?? false);
    if (options?.before) commits = commits.filter((c) => c.createdAt < options.before!);
    if (options?.after) commits = commits.filter((c) => c.createdAt > options.after!);
    const page = paginate(
      commits.map((commit) => index.toSourceCommit(commit)),
      contextKey('listCommits', ref.projectId, ref.modelId, String(options?.includeUnpublished ?? false), options?.before ?? '', options?.after ?? ''),
      options,
      maxPageSize,
    );
    return applyTruncate(page, failureFor('listCommits'));
  }

  async function getCommit(ctx: PluginContext, ref: CommitRef): Promise<SourceCommit> {
    await guard('getCommit', ctx, undefined);
    return index.toSourceCommit(index.getCommit(ref));
  }

  async function loadCommit(ctx: PluginContext, ref: CommitRef, options?: LoadCommitOptions): Promise<CommitPayload> {
    await guard('loadCommit', ctx, options?.signal);
    const commit = index.getCommit(ref);
    // First format in the HOST's order of preference that this provider can
    // serve — not the provider's own first choice. A host that asks for
    // `ifc-step` before `ifcx` is expressing which of its load paths it would
    // rather use, and honouring the provider's order instead would silently
    // ignore that.
    const accepted = options?.accept ?? deps.payloadFormats;
    const format = accepted.find((candidate) => deps.payloadFormats.includes(candidate));
    if (!format) {
      throw new FixtureCommitError('unsupported-format', `No acceptable payload format; provider serves ${deps.payloadFormats.join(', ')}`, { status: 415 });
    }
    options?.onProgress?.(commit.content.byteLength, commit.content.byteLength);
    return {
      format,
      fileName: commit.fileName,
      bytes: commit.content.slice().buffer,
      artifactDigest: commit.digest,
    };
  }

  async function loadCommitFingerprints(ctx: PluginContext, ref: CommitRef, options?: LoadFingerprintsOptions): Promise<CommitFingerprintSet> {
    await guard('loadCommitFingerprints', ctx, options?.signal);
    const commit = index.getCommit(ref);
    const all = options?.dataOnly
      ? commit.fingerprints.map(({ geometryHash: _g, aabb: _a, volume: _v, ...rest }) => rest)
      : commit.fingerprints;
    const max = options?.maxEntries;
    const sampled = max !== undefined && all.length > max;
    return {
      format: 'ifc-lite/fingerprints',
      version: 1,
      commit: refOf(commit),
      artifactDigest: commit.digest,
      ...(options?.keyProperty !== undefined ? { keyProperty: options.keyProperty } : {}),
      engine: FIXTURE_ENGINE,
      entries: sampled ? sampleByType(all, max!) : [...all],
      ...(sampled ? { sample: { total: all.length, strategy: 'stratified-by-type' as const } } : {}),
    };
  }

  /** Every commit strictly after `base` up to and including `head`, oldest first. */
  function chainBetween(base: RuntimeCommit, head: RuntimeCommit): RuntimeCommit[] {
    const mainline = index.mainlineFrom(head.projectId, head.modelId, head.id);
    const cut = mainline.findIndex((commit) => commit.id === base.id);
    if (cut === -1) {
      throw new FixtureCommitError('invalid', `Commit ${base.id} is not an ancestor of ${head.id} on the mainline`, { status: 400 });
    }
    return mainline.slice(0, cut).reverse();
  }

  async function getCommitDiff(ctx: PluginContext, base: CommitRef, head: CommitRef, options?: GetCommitDiffOptions): Promise<StoredCommitDiff> {
    await guard('getCommitDiff', ctx, options?.signal);
    if (base.modelId !== head.modelId) {
      throw new FixtureCommitError('invalid', 'A stored diff compares two commits of ONE model', { status: 400 });
    }
    const baseCommit = index.getCommit(base);
    const headCommit = index.getCommit(head);
    return deriveCommitDiff({
      base: baseCommit,
      head: headCommit,
      baseRef: base,
      headRef: head,
      // Diffing a commit with itself is the degenerate case the conformance
      // suite pins: an empty chain means no aliases and no entries.
      chain: baseCommit.id === headCommit.id ? [] : chainBetween(baseCommit, headCommit),
      ...(options?.keyProperty !== undefined ? { keyProperty: options.keyProperty } : {}),
    });
  }

  async function listElementHistory(ctx: PluginContext, query: ElementHistoryQuery, options?: ListOptions): Promise<Page<ElementHistoryEntry>> {
    await guard('listElementHistory', ctx, options?.signal);
    const model = index.getModel(query.projectId, query.modelId);
    const at = query.atCommitId ?? model.headCommitId;
    const entries = deriveElementHistory({
      mainline: index.mainlineFrom(query.projectId, query.modelId, at),
      key: query.key,
    });
    const page = paginate(entries, contextKey('listElementHistory', query.projectId, query.modelId, query.key, at), options, maxPageSize);
    return applyTruncate(page, failureFor('listElementHistory'));
  }

  function identityRecordSet(base: RuntimeCommit, head: RuntimeCommit, entries: readonly IdentityEntryLike[]): IdentityRecordSet {
    return {
      base: { ...refOf(base), artifactDigest: base.digest },
      head: { ...refOf(head), artifactDigest: head.digest },
      entries: entries.map((entry) => ({ ...entry })),
    };
  }

  async function listIdentityRecords(ctx: PluginContext, base: CommitRef, head: CommitRef): Promise<IdentityRecordSet> {
    await guard('listIdentityRecords', ctx, undefined);
    const baseCommit = index.getCommit(base);
    const headCommit = index.getCommit(head);
    const chain = baseCommit.id === headCommit.id ? [] : chainBetween(baseCommit, headCommit);
    return identityRecordSet(baseCommit, headCommit, chain.flatMap((commit) => commit.identity));
  }

  async function createModel(ctx: PluginContext, input: CreateModelInput): Promise<SourceModel> {
    await guard('createModel', ctx, undefined);
    return index.toSourceModel(index.createModel({
      id: `model-${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${index.listModels(input.projectId).length}`,
      projectId: input.projectId,
      name: input.name,
      ...(input.containerId !== undefined ? { containerId: input.containerId } : {}),
      ...(input.discipline !== undefined ? { discipline: input.discipline } : {}),
    }));
  }

  async function createCommit(ctx: PluginContext, input: CreateCommitInput): Promise<SourceCommit> {
    await guard('createCommit', ctx, input.signal);
    const replay = byIdempotencyKey.get(input.idempotencyKey);
    if (replay) return replay;

    const model = index.getModel(input.projectId, input.modelId);
    // The conflict check is the reason `expectedParentId` exists: two people
    // uploading the same model minutes apart is ordinary, and a service that
    // silently accepted the second would lose the first's changes.
    const currentHead = model.headCommitId === '' ? null : model.headCommitId;
    if (input.expectedParentId !== currentHead) {
      throw new FixtureCommitError('conflict', `Model head is ${currentHead ?? '(none)'}, not ${input.expectedParentId ?? '(none)'}`, {
        status: 409,
        details: { headCommitId: model.headCommitId },
      });
    }

    const bytes = new Uint8Array(input.bytes.slice(0));
    input.onProgress?.(bytes.byteLength, bytes.byteLength);
    const commit = index.appendCommit(model, index.buildCommit({
      id: `commit-${model.id}-${model.commits.length + 1}`,
      model,
      parents: currentHead ? [currentHead] : [],
      // One hour after whatever is currently newest, so a created commit is
      // unambiguously the head — and deterministically so, which a wall-clock
      // stamp would not be. A fixed epoch would put an upload BEHIND a world
      // whose declared commits are dated later, and the model's head would
      // not move.
      createdAt: nextCommitTimestamp(model),
      author: deps.identity,
      ...(input.message !== undefined ? { message: input.message } : {}),
      fileName: input.fileName,
      content: bytes,
      identity: input.identity ?? [],
    }));
    const created = index.toSourceCommit(commit);
    byIdempotencyKey.set(input.idempotencyKey, created);
    return created;
  }

  async function recordIdentity(ctx: PluginContext, base: CommitRef, head: CommitRef, entries: readonly IdentityEntryLike[]): Promise<IdentityRecordSet> {
    await guard('recordIdentity', ctx, undefined);
    const baseCommit = index.getCommit(base);
    const headCommit = index.getCommit(head);
    const existing = headCommit.identity;
    const merged = [...existing];
    for (const entry of entries) {
      const duplicate = existing.find((e) => e.base === entry.base && e.here === entry.here);
      if (duplicate) continue; // recording the same pair twice is a no-op
      const conflict = existing.find((e) => e.base === entry.base || e.here === entry.here);
      if (conflict) {
        throw new FixtureCommitError('conflict', `Identity for ${entry.base}/${entry.here} conflicts with an existing claim`, { status: 409 });
      }
      merged.push(entry);
    }
    // `identity` is readonly on the runtime commit, so the write replaces the
    // commit's entry in the model rather than mutating it in place — which
    // also keeps "a commit is immutable" honest everywhere else.
    const model = index.getModel(head.projectId, head.modelId);
    model.commits = model.commits.map((c) => (c.id === headCommit.id ? { ...c, identity: merged } : c));
    return identityRecordSet(baseCommit, { ...headCommit, identity: merged }, merged);
  }

  /**
   * `ModelRef` carries no commit id — unlike `SourceFileRef`, which carries
   * `revisionId` and lets `watchRevisions` compare against what the host
   * holds. So the heads the caller last saw live in the CURSOR, and a first
   * call (no cursor) reports nothing and hands one back. Anything else would
   * make every first poll announce "new version available" for every model
   * the user already has open.
   */
  function encodeWatchCursor(heads: ReadonlyMap<string, string>): string {
    return [...heads].map(([modelId, head]) => `${encodeURIComponent(modelId)}=${encodeURIComponent(head)}`).join('|');
  }

  function decodeWatchCursor(cursor: string | undefined): Map<string, string> | undefined {
    if (cursor === undefined) return undefined;
    const heads = new Map<string, string>();
    for (const pair of cursor.split('|')) {
      if (pair === '') continue;
      const [modelId, head] = pair.split('=');
      if (modelId === undefined || head === undefined) {
        throw new FixtureCommitError('invalid', `Malformed watch cursor: ${JSON.stringify(cursor)}`, { status: 400 });
      }
      heads.set(decodeURIComponent(modelId), decodeURIComponent(head));
    }
    return heads;
  }

  async function watchCommits(ctx: PluginContext, models: readonly ModelRef[], cursor?: string, options?: ListOptions): Promise<CommitWatchResult> {
    await guard('watchCommits', ctx, options?.signal);
    const known = decodeWatchCursor(cursor);
    const events: CommitEvent[] = [];
    const heads = new Map<string, string>();
    for (const ref of models) {
      let head: string;
      try {
        head = index.getModel(ref.projectId, ref.modelId).headCommitId;
      } catch {
        if (known?.has(ref.modelId)) events.push({ modelId: ref.modelId, headCommitId: '', deleted: true });
        continue;
      }
      heads.set(ref.modelId, head);
      const previous = known?.get(ref.modelId);
      if (previous !== undefined && previous !== head) {
        events.push({ modelId: ref.modelId, headCommitId: head, previousHeadCommitId: previous });
      }
    }
    return { events, cursor: encodeWatchCursor(heads) };
  }

  return {
    listModels,
    getModel,
    listCommits,
    getCommit,
    loadCommit,
    loadCommitFingerprints,
    getCommitDiff,
    listElementHistory,
    listIdentityRecords,
    createModel,
    createCommit,
    recordIdentity,
    watchCommits,
  };
}
