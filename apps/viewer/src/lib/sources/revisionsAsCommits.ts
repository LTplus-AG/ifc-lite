/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Presents a revision-only provider's file as a commit-aware model
 * (`docs/architecture/commit-history/01-commit-source-api.md` §8).
 *
 * Dropbox and Microsoft Graph already list a file's revisions and neither
 * will ever grow a commit API. Rather than leave the History panel empty for
 * them, this adapter maps `listRevisions` onto a linear commit chain, so the
 * panel works with NO provider changes.
 *
 * What it cannot fake, it does not:
 *  - no stats, because computing them needs both files' fingerprints;
 *  - no stored diffs, element history or identity records;
 *  - no writes;
 *  - and `artifact.digest` is genuinely unknown until the bytes are fetched,
 *    so it is reported as an `unknown:` placeholder rather than as a hash of
 *    something. A placeholder that looked like `sha256:…` would be worse
 *    than absent: the host's digest check would compare two real-looking
 *    values and report a mismatch as corruption.
 */

import type {
  FileSourceProvider,
  ListOptions,
  Page,
  PluginContext,
  SourceCommit,
  SourceFile,
  SourceFileRef,
  SourceModel,
  SourceRevision,
} from '@ifc-lite/plugin-api';

/** `artifact.digest` for a revision whose bytes nobody has fetched yet. */
export function unknownDigest(revisionId: string): string {
  return `unknown:${revisionId}`;
}

export function isUnknownDigest(digest: string): boolean {
  return digest.startsWith('unknown:');
}

/** One source file, addressed as a model. The model id IS the file id. */
export function fileAsModel(file: SourceFile, projectId: string): SourceModel {
  return {
    id: file.id,
    projectId,
    name: file.name,
    containerId: file.containerId,
    headCommitId: file.currentRevisionId,
    ...(file.modifiedAt !== undefined ? { updatedAt: file.modifiedAt } : {}),
  };
}

/**
 * Revisions as a linear chain, newest first.
 *
 * `listRevisions` is newest-first by contract, so `parents[0]` is simply the
 * next entry — the adapter does not re-sort, for the same reason
 * `joinCommitPages` does not: the provider's order is the authority and a
 * client-side sort on `createdAt` would disagree with it on ties.
 */
export function revisionsAsCommits(
  revisions: readonly SourceRevision[],
  file: SourceFile,
  projectId: string,
): SourceCommit[] {
  return revisions.map((revision, index) => {
    const parent = revisions[index + 1];
    return {
      id: revision.id,
      modelId: file.id,
      projectId,
      parents: parent ? [parent.id] : [],
      createdAt: revision.createdAt,
      ...(revision.createdBy !== undefined ? { author: { id: revision.createdBy, displayName: revision.createdBy } } : {}),
      // The revision LABEL, not a message: `"2.0"` is what SharePoint calls
      // this version, and inventing a commit message would be putting words
      // in the author's mouth.
      message: revision.label,
      status: 'published' as const,
      artifact: {
        digest: unknownDigest(revision.id),
        fileName: file.name,
        sizeBytes: revision.sizeBytes ?? 0,
      },
      origin: { fileId: file.id, revisionId: revision.id },
    } satisfies SourceCommit;
  });
}

export interface RevisionHistoryPage {
  readonly model: SourceModel;
  readonly commits: readonly SourceCommit[];
  readonly cursor?: string;
  /**
   * `false` when the provider can list history but cannot fetch it —
   * `downloadHistoricalRevisions`. The panel then shows the timeline with
   * Open disabled and says why, instead of offering an action that fails.
   */
  readonly canOpenHistorical: boolean;
}

/**
 * One page of a revision-only file's history.
 *
 * Returns `null` when the provider has no revision history at all, which is
 * the panel's "History is available for models opened from a source" state
 * rather than an error.
 */
export async function loadRevisionHistoryPage(
  provider: FileSourceProvider,
  ctx: PluginContext,
  ref: SourceFileRef,
  file: SourceFile,
  options?: ListOptions,
): Promise<RevisionHistoryPage | null> {
  if (!provider.manifest.capabilities.revisionHistory || !provider.listRevisions) return null;
  const page: Page<SourceRevision> = await provider.listRevisions(ctx, ref, options);
  return {
    model: fileAsModel(file, ref.projectId),
    commits: revisionsAsCommits(page.items, file, ref.projectId),
    ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
    canOpenHistorical: provider.manifest.capabilities.downloadHistoricalRevisions,
  };
}
