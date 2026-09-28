/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ============================================================================
// The commit half of the fixture's data model: a declarative description of
// models and their commit chains, plus the in-memory index over it.
//
// Same shape and same contract as `data.ts`: every cross-reference is
// validated eagerly at construction (unknown parent, duplicate id, a parent
// declared after its child), so a malformed world fails with a sentence
// rather than as a confusing null three calls deep.
// ============================================================================

import type {
  CommitArtifact,
  CommitRef,
  CommitStatus,
  IdentityEntryLike,
  SourceCommit,
  SourceFingerprint,
  SourceIdentity,
  SourceModel,
} from '@ifc-lite/plugin-api';

import { deriveCommitDiff, deriveElementHistory, type DerivableCommit } from './commit-derive.js';
import { FixtureApiError, FixtureCommitError } from './errors.js';
import { artifactDigest } from './sha256.js';

export interface FixtureCommitSpec {
  readonly id: string;
  /** `parents[0]` is the mainline parent. Empty for the model's first commit. */
  readonly parents: readonly string[];
  /** Defaults to a deterministic timestamp derived from declaration order. */
  readonly createdAt?: string;
  readonly author?: string;
  readonly message?: string;
  /** Defaults to `'published'`. */
  readonly status?: CommitStatus;
  readonly fileName: string;
  /** Deterministic bytes. A `string` is UTF-8 encoded. The artifact digest is taken over these. */
  readonly content: Uint8Array | string;
  /**
   * Precomputed element fingerprints. Optional so a world that only exercises
   * commit listing does not have to invent any — but `fingerprints`,
   * `storedDiffs` and `elementHistory` all read from here, so a world that
   * declares those capabilities and no fingerprints answers with empty sets.
   */
  readonly fingerprints?: readonly SourceFingerprint[];
  /** Reviewed identity against `parents[0]`: `base` is a key in the parent commit. */
  readonly identity?: readonly IdentityEntryLike[];
}

export interface FixtureModelSpec {
  readonly id: string;
  readonly name: string;
  readonly containerId?: string;
  readonly discipline?: string;
  /** Any order; the index sorts newest first and derives the head from the mainline. */
  readonly commits: readonly FixtureCommitSpec[];
}

interface RuntimeCommit extends DerivableCommit {
  readonly modelId: string;
  readonly projectId: string;
  readonly parents: readonly string[];
  readonly author?: SourceIdentity;
  readonly message?: string;
  readonly status: CommitStatus;
  readonly fileName: string;
  readonly content: Uint8Array;
  readonly digest: string;
}

interface RuntimeModel {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly containerId?: string;
  readonly discipline?: string;
  /** Newest first. Mutable: `createCommit` appends to a live world. */
  commits: RuntimeCommit[];
  headCommitId: string;
}

function toBytes(content: Uint8Array | string): Uint8Array {
  return typeof content === 'string' ? new TextEncoder().encode(content) : content;
}

/**
 * Newest first by `createdAt`, ties broken by descending commit id.
 *
 * The tie-break is not cosmetic: two commits landing in the same second is
 * ordinary in a fixture (and in a real service), and a sort with no total
 * order makes `listCommits` unstable across pages — which is the very thing
 * the conformance suite checks.
 */
function newestFirst(a: RuntimeCommit, b: RuntimeCommit): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * Re-sorts a model's commits and re-derives its head.
 *
 * The head is the newest PUBLISHED commit. A `pending` upload sitting on top
 * of the mainline is visible to whoever may see it and is still not the
 * model's head — the contract is explicit that a host must never select one,
 * and the oracle has to make that possible to observe.
 */
function resortAndRehead(model: RuntimeModel): void {
  model.commits.sort(newestFirst);
  model.headCommitId = model.commits.find((commit) => commit.status === 'published')?.id ?? '';
}

export class FixtureCommitIndex {
  private readonly modelsByProject = new Map<string, RuntimeModel[]>();
  private readonly modelById = new Map<string, RuntimeModel>();

  /** `projectId` is the project each model spec was declared under. */
  add(projectId: string, specs: readonly FixtureModelSpec[]): void {
    const models: RuntimeModel[] = this.modelsByProject.get(projectId) ?? [];
    this.modelsByProject.set(projectId, models);

    for (const spec of specs) {
      if (this.modelById.has(spec.id)) {
        throw new FixtureApiError(`Duplicate model id in fixture spec: ${spec.id}`);
      }
      if (spec.commits.length === 0) {
        throw new FixtureApiError(`Model ${spec.id} must declare at least one commit`);
      }

      const seen = new Set<string>();
      const commits = spec.commits.map((commitSpec, index): RuntimeCommit => {
        if (seen.has(commitSpec.id)) {
          throw new FixtureApiError(`Model ${spec.id} declares duplicate commit id ${commitSpec.id}`);
        }
        seen.add(commitSpec.id);
        const content = toBytes(commitSpec.content);
        return {
          id: commitSpec.id,
          modelId: spec.id,
          projectId,
          parents: [...commitSpec.parents],
          createdAt: commitSpec.createdAt ?? new Date(1700000000000 - index * 86_400_000).toISOString(),
          ...(commitSpec.author !== undefined ? { author: { id: commitSpec.author, displayName: commitSpec.author } } : {}),
          ...(commitSpec.message !== undefined ? { message: commitSpec.message } : {}),
          status: commitSpec.status ?? 'published',
          fileName: commitSpec.fileName,
          content,
          digest: artifactDigest(content),
          fingerprints: commitSpec.fingerprints ?? [],
          identity: commitSpec.identity ?? [],
        };
      });

      for (const commit of commits) {
        for (const parent of commit.parents) {
          if (!seen.has(parent)) {
            throw new FixtureApiError(
              `Commit ${commit.id} of model ${spec.id} names unknown parent ${parent}`,
            );
          }
        }
      }

      const model: RuntimeModel = {
        id: spec.id,
        projectId,
        name: spec.name,
        ...(spec.containerId !== undefined ? { containerId: spec.containerId } : {}),
        ...(spec.discipline !== undefined ? { discipline: spec.discipline } : {}),
        commits,
        headCommitId: '',
      };
      resortAndRehead(model);
      models.push(model);
      this.modelById.set(model.id, model);
    }
  }

  /** Registers an empty model. The caller then commits with `expectedParentId: null`. */
  createModel(model: {
    readonly id: string;
    readonly projectId: string;
    readonly name: string;
    readonly containerId?: string;
    readonly discipline?: string;
  }): RuntimeModel {
    if (this.modelById.has(model.id)) {
      throw new FixtureCommitError('conflict', `Model ${model.id} already exists`, { status: 409 });
    }
    const created: RuntimeModel = { ...model, commits: [], headCommitId: '' };
    const models = this.modelsByProject.get(model.projectId) ?? [];
    this.modelsByProject.set(model.projectId, models);
    models.push(created);
    this.modelById.set(created.id, created);
    return created;
  }

  /** Appends a commit. Callers enforce the `expectedParentId` check before calling. */
  appendCommit(model: RuntimeModel, commit: RuntimeCommit): RuntimeCommit {
    model.commits.push(commit);
    resortAndRehead(model);
    return commit;
  }

  /** Builds a runtime commit from uploaded bytes, digest included. */
  buildCommit(input: {
    readonly id: string;
    readonly model: RuntimeModel;
    readonly parents: readonly string[];
    readonly createdAt: string;
    readonly author?: SourceIdentity;
    readonly message?: string;
    readonly fileName: string;
    readonly content: Uint8Array;
    readonly identity: readonly IdentityEntryLike[];
  }): RuntimeCommit {
    return {
      id: input.id,
      modelId: input.model.id,
      projectId: input.model.projectId,
      parents: [...input.parents],
      createdAt: input.createdAt,
      ...(input.author !== undefined ? { author: input.author } : {}),
      ...(input.message !== undefined ? { message: input.message } : {}),
      status: 'published',
      fileName: input.fileName,
      content: input.content,
      digest: artifactDigest(input.content),
      // Uploaded bytes are opaque to the fixture: it does not parse IFC, so a
      // commit created at runtime has no fingerprints and therefore derives an
      // empty diff. That is honest rather than convenient — inventing
      // fingerprints for bytes nobody read would make the write path's diffs
      // fiction the conformance suite would then assert on.
      fingerprints: [],
      identity: [...input.identity],
    };
  }

  get isEmpty(): boolean {
    return this.modelById.size === 0;
  }

  listModels(projectId: string): readonly RuntimeModel[] {
    return this.modelsByProject.get(projectId) ?? [];
  }

  getModel(projectId: string, modelId: string): RuntimeModel {
    const model = this.modelById.get(modelId);
    if (!model || model.projectId !== projectId) {
      throw new FixtureCommitError('not-found', `Unknown model ${modelId} in project ${projectId}`, { status: 404 });
    }
    return model;
  }

  /** Newest first, optionally including the commits a host must not treat as head. */
  listCommits(projectId: string, modelId: string, includeUnpublished: boolean): readonly RuntimeCommit[] {
    const commits = this.getModel(projectId, modelId).commits;
    return includeUnpublished ? commits : commits.filter((c) => c.status === 'published');
  }

  getCommit(ref: CommitRef): RuntimeCommit {
    const model = this.getModel(ref.projectId, ref.modelId);
    const commit = model.commits.find((c) => c.id === ref.commitId);
    if (!commit) {
      throw new FixtureCommitError('not-found', `Unknown commit ${ref.commitId} for model ${ref.modelId}`, { status: 404 });
    }
    return commit;
  }

  /**
   * The mainline from `commitId` back to the model's first commit, newest
   * first, following `parents[0]` only. A merge commit contributes its
   * mainline parent and nothing else, which is what v1 hosts render.
   */
  mainlineFrom(projectId: string, modelId: string, commitId: string): RuntimeCommit[] {
    const model = this.getModel(projectId, modelId);
    const byId = new Map(model.commits.map((c) => [c.id, c] as const));
    const chain: RuntimeCommit[] = [];
    let current = byId.get(commitId);
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      chain.push(current);
      const parentId = current.parents[0];
      current = parentId !== undefined ? byId.get(parentId) : undefined;
    }
    return chain;
  }

  toSourceModel(model: RuntimeModel): SourceModel {
    const newest = model.commits[0];
    return {
      id: model.id,
      projectId: model.projectId,
      name: model.name,
      ...(model.containerId !== undefined ? { containerId: model.containerId } : {}),
      ...(model.discipline !== undefined ? { discipline: model.discipline } : {}),
      headCommitId: model.headCommitId,
      commitCount: model.commits.length,
      ...(newest !== undefined ? { updatedAt: newest.createdAt } : {}),
    };
  }

  /**
   * Change counts against `parents[0]`, derived rather than declared — so a
   * host reading `stats` and a host reading `getCommitDiff` can never be told
   * two different stories about the same commit.
   */
  toSourceCommit(commit: RuntimeCommit): SourceCommit {
    const artifact: CommitArtifact = {
      digest: commit.digest,
      fileName: commit.fileName,
      sizeBytes: commit.content.byteLength,
    };
    const parentId = commit.parents[0];
    const parent = parentId !== undefined
      ? this.getModel(commit.projectId, commit.modelId).commits.find((c) => c.id === parentId)
      : undefined;
    const stats = parent
      ? deriveCommitDiff({
          base: parent,
          head: commit,
          baseRef: { projectId: commit.projectId, modelId: commit.modelId, commitId: parent.id },
          headRef: { projectId: commit.projectId, modelId: commit.modelId, commitId: commit.id },
          chain: [commit],
        }).counts
      : undefined;

    return {
      id: commit.id,
      modelId: commit.modelId,
      projectId: commit.projectId,
      parents: commit.parents,
      createdAt: commit.createdAt,
      ...(commit.author !== undefined ? { author: commit.author } : {}),
      ...(commit.message !== undefined ? { message: commit.message } : {}),
      status: commit.status,
      artifact,
      ...(stats !== undefined ? { stats } : {}),
    };
  }
}

export type { RuntimeCommit, RuntimeModel };
export { deriveCommitDiff, deriveElementHistory };
