/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ============================================================================
// The commit half of `DaluxBuildProvider`, over the version-set index.
//
// Split out of `provider.ts` for the module-size rule; the mapping and its
// reasoning live in `commit-index.ts`.
// ============================================================================

import type {
  CommitPayload,
  CommitPayloadFormat,
  CommitRef,
  ListCommitsOptions,
  ListModelsOptions,
  ModelRef,
  Page,
  PluginContext,
  SourceCommit,
  SourceModel,
} from '@ifc-lite/plugin-api';

import { getCommitIndex, type DaluxCommitIndex, type DaluxModelCommit, type DaluxModelHistory } from './commit-index.js';
import { DaluxCommitError } from './errors.js';
import { BrowserDaluxApiClient } from './http-client.js';
import { enc, nonEmptyString } from './mapping.js';
import { commitDigest, commitTimestamp } from './version-sets.js';

/**
 * `SourceCommit.createdAt` is required, so an undated revision still needs a
 * value. The epoch reads as "older than everything real", which is where
 * `newestFirst` already sorts it — a fabricated recent date would put an
 * undated row at the TOP of the timeline and have it mistaken for the head.
 */
const UNDATED = new Date(0).toISOString();

/**
 * The format of one commit's bytes, from the file's extension.
 *
 * Dalux stores what was uploaded and transcodes nothing, so a commit has
 * exactly ONE format and `accept` can only reject it — which is why the
 * manifest's `payloadFormats` (all three) is a statement about the store,
 * not about any single commit.
 */
function formatForFileName(fileName: string): CommitPayloadFormat {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.ifczip')) return 'ifc-zip';
  if (lower.endsWith('.ifcx') || lower.endsWith('.ifc5')) return 'ifcx';
  return 'ifc-step';
}

/**
 * The commit message: the version set(s) that pin this revision.
 *
 * A Dalux revision has no commit message of its own — the nearest thing is
 * what the team called the package it went into, which is exactly the label
 * a coordinator recognises ("Coordination round 14"). Several sets pinning
 * one revision are all named, because dropping the others would hide that
 * this same file went into several packages.
 */
function commitMessage(commit: DaluxModelCommit): string {
  const names = commit.versionSets.map((set) => set.name);
  return names.length <= 1 ? names[0] ?? '' : `${names[0]} (also in ${names.slice(1).join(', ')})`;
}

function toSourceCommit(projectId: string, history: DaluxModelHistory, index: number): SourceCommit {
  const commits = history.commits;
  const commit = commits[index];
  const parent = commits[index + 1];
  const message = commitMessage(commit);
  return {
    id: commit.revisionId,
    modelId: history.fileId,
    projectId,
    parents: parent ? [parent.revisionId] : [],
    createdAt: commitTimestamp(commit.file) ?? UNDATED,
    ...(commit.file.lastModifiedByUserId ?? commit.file.uploadedByUserId
      ? { author: { id: (commit.file.lastModifiedByUserId ?? commit.file.uploadedByUserId)! } }
      : {}),
    ...(message ? { message } : {}),
    // Dalux has no review state on a file revision. A version set's
    // `locked`/`unlocked` is about whether the SET can be re-pointed, not
    // about whether this revision is approved, so mapping it onto
    // `pending`/`rejected` would be inventing a workflow Dalux does not have.
    status: 'published',
    artifact: {
      digest: commitDigest(commit.file),
      fileName: commit.file.fileName,
      sizeBytes: commit.file.fileSize ?? 0,
    },
    meta: {
      versionSetIds: commit.versionSets.map((set) => set.versionSetId),
      fileAreaId: commit.fileAreaId,
      ...(commit.revisionNumber !== undefined ? { revisionNumber: commit.revisionNumber } : {}),
    },
    origin: { provider: 'dalux', fileId: history.fileId, revisionId: commit.revisionId },
  };
}

function toSourceModel(projectId: string, history: DaluxModelHistory, index: DaluxCommitIndex): SourceModel {
  const newest = history.commits[0];
  return {
    id: history.fileId,
    projectId,
    name: history.fileName,
    containerId: history.fileAreaId,
    headCommitId: newest.revisionId,
    commitCount: history.commits.length,
    ...(commitTimestamp(newest.file) !== undefined ? { updatedAt: commitTimestamp(newest.file)! } : {}),
    meta: {
      // A partial sweep is reported on every model rather than swallowed: a
      // history missing its newest package would otherwise present a stale
      // revision as HEAD with nothing saying so.
      ...(index.truncated ? { historyTruncated: true, versionSetsSwept: index.versionSetCount } : {}),
    },
  };
}

function requireModel(index: DaluxCommitIndex, ref: ModelRef): DaluxModelHistory {
  const history = index.models.get(ref.modelId);
  if (!history) {
    throw new DaluxCommitError(
      'not-found',
      `No Dalux model history for file ${ref.modelId}: it is in no version set of project ${ref.projectId}`,
      404,
    );
  }
  return history;
}

export interface DaluxCommitMethodDeps {
  readonly createClient: (ctx: PluginContext) => Promise<BrowserDaluxApiClient>;
}

export function createDaluxCommitMethods({ createClient }: DaluxCommitMethodDeps) {
  async function indexFor(ctx: PluginContext, projectId: string, signal?: AbortSignal): Promise<{
    index: DaluxCommitIndex;
    client: BrowserDaluxApiClient;
  }> {
    const client = await createClient(ctx);
    return { index: await getCommitIndex(client, projectId, signal), client };
  }

  /**
   * Every model file the project's version sets cover, most recently updated
   * first.
   *
   * NOT paged against the server: the index is already in memory, and Dalux
   * has no endpoint that pages models. A single page with no cursor is the
   * honest answer — a synthetic cursor would make a host believe it was
   * streaming when it was slicing an array it already had.
   */
  async function listModels(
    ctx: PluginContext,
    projectId: string,
    options?: ListModelsOptions,
  ): Promise<Page<SourceModel>> {
    const { index } = await indexFor(ctx, projectId, options?.signal);
    const query = options?.query?.toLowerCase();
    const models = [...index.models.values()]
      .filter((history) => !query || history.fileName.toLowerCase().includes(query))
      .map((history) => toSourceModel(projectId, history, index));
    models.sort((a, b) => ((a.updatedAt ?? '') < (b.updatedAt ?? '') ? 1 : (a.updatedAt ?? '') > (b.updatedAt ?? '') ? -1 : 0));
    return { items: models };
  }

  async function getModel(ctx: PluginContext, ref: ModelRef): Promise<SourceModel> {
    const { index } = await indexFor(ctx, ref.projectId);
    return toSourceModel(ref.projectId, requireModel(index, ref), index);
  }

  async function listCommits(
    ctx: PluginContext,
    ref: ModelRef,
    options?: ListCommitsOptions,
  ): Promise<Page<SourceCommit>> {
    const { index } = await indexFor(ctx, ref.projectId, options?.signal);
    const history = requireModel(index, ref);
    let commits = history.commits.map((_, position) => toSourceCommit(ref.projectId, history, position));
    if (options?.before) commits = commits.filter((commit) => commit.createdAt < options.before!);
    if (options?.after) commits = commits.filter((commit) => commit.createdAt > options.after!);
    // `includeUnpublished` is ignored on purpose: every Dalux revision is
    // published (see `toSourceCommit`), so there is nothing the flag could
    // reveal and filtering on it would only be theatre.
    return { items: commits };
  }

  async function getCommit(ctx: PluginContext, ref: CommitRef): Promise<SourceCommit> {
    const { index } = await indexFor(ctx, ref.projectId);
    const history = requireModel(index, ref);
    const position = history.commits.findIndex((commit) => commit.revisionId === ref.commitId);
    if (position === -1) {
      throw new DaluxCommitError(
        'not-found',
        `No revision ${ref.commitId} of file ${ref.modelId} in any version set of project ${ref.projectId}`,
        404,
      );
    }
    return toSourceCommit(ref.projectId, history, position);
  }

  async function loadCommit(
    ctx: PluginContext,
    ref: CommitRef,
    options?: { readonly accept?: readonly CommitPayloadFormat[]; readonly signal?: AbortSignal; readonly onProgress?: (sent: number, total?: number) => void },
  ): Promise<CommitPayload> {
    const { index, client } = await indexFor(ctx, ref.projectId, options?.signal);
    const history = requireModel(index, ref);
    const commit = history.commits.find((candidate) => candidate.revisionId === ref.commitId);
    if (!commit) {
      throw new DaluxCommitError('not-found', `No revision ${ref.commitId} of file ${ref.modelId}`, 404);
    }

    // The format is a property of the BYTES, not a choice: Dalux stores
    // whatever was uploaded. So there is one candidate, and `accept` can only
    // reject it.
    const format = formatForFileName(commit.file.fileName);
    if (options?.accept && !options.accept.includes(format)) {
      throw new DaluxCommitError(
        'unsupported-format',
        `Dalux holds ${commit.file.fileName} as ${format}, which this host did not accept`,
        415,
      );
    }

    // PREFER THE LINK DALUX GAVE US. A version-set file row carries its own
    // `downloadLink`, and it is NOT the route this used to construct: Dalux
    // answers with a version-set-scoped `/1.0/.../version_sets/{vs}/files/
    // {f}/revisions/{r}/content`, not the file-area-scoped `/2.0/.../
    // file_areas/{fa}/...` one. Measured against a live tenant — building
    // the URL by hand was reaching for a route Dalux does not advertise for
    // a pinned revision. `download()` already prefers the provider's link
    // for current bytes, for the same reason; this is that rule applied to
    // the commit path.
    //
    // The fallback stays because `downloadLink` is nullable in the schema,
    // and the file-area route is documented and does take a revision id.
    const url = nonEmptyString(commit.file.downloadLink)
      ?? `${client.baseUrl}/2.0/projects/${enc(ref.projectId)}/file_areas/${enc(commit.fileAreaId)}`
        + `/files/${enc(ref.modelId)}/revisions/${enc(ref.commitId)}/content`;
    const bytes = await client.getBinary(url, options?.signal);
    options?.onProgress?.(bytes.byteLength, bytes.byteLength);
    return {
      format,
      fileName: commit.file.fileName,
      bytes,
      artifactDigest: commitDigest(commit.file),
    };
  }

  return { listModels, getModel, listCommits, getCommit, loadCommit };
}
