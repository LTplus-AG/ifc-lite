/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Opening a commit in the viewer.
 *
 * There is ONE load path in this app (`useIfcLoader.loadFile`), and a commit
 * does not get a second one: the bytes arrive, are wrapped in a `File`, and
 * go down the same source-download bridge a cloud file uses. The only new
 * things are the commit tag attached on success and the optional
 * `replaceModelId` that swaps a model rather than federating another.
 */

import { useCallback } from 'react';
import { toast } from '@/components/ui/toast';
import type { CommitPayloadFormat, CommitRef, SourceCommit } from '@ifc-lite/plugin-api';

import { dispatchSourceDownload } from '@/services/sources/source-host';
import { useViewerStore } from '@/store';
import { useResolveHistoryProvider } from './useHistoryProvider';

/**
 * Host preference order. `ifc-lite-cache` is absent deliberately — it is
 * reserved in the format list and has no load path yet (spec 01 §9), so
 * accepting it would mean asking for bytes nothing can open.
 */
const ACCEPT: readonly CommitPayloadFormat[] = ['ifc-step', 'ifc-zip', 'ifcx'];

type OpenCommitMode = 'replace' | 'alongside';

export interface OpenCommitOptions {
  /** Viewer model id whose history this is. */
  readonly modelId: string;
  readonly ref: CommitRef;
  readonly commit: SourceCommit;
  readonly mode: OpenCommitMode;
  /** The model's head at the time of the click — used to decide `historical`. */
  readonly headCommitId: string;
  /** Display name for the "alongside" copy. Ignored when replacing. */
  readonly displayName?: string;
}

export function useCommitLoad(): {
  openCommit: (options: OpenCommitOptions) => Promise<boolean>;
} {
  const resolveProvider = useResolveHistoryProvider();

  const openCommit = useCallback(
    async (options: OpenCommitOptions): Promise<boolean> => {
      const resolved = resolveProvider(options.modelId);
      if (!resolved) {
        toast.error('This model is no longer connected to a source.');
        return false;
      }

      const ctx = resolved.createContext();
      try {
        let bytes: ArrayBuffer;
        let fileName: string;
        let artifactDigest: string;

        if (resolved.kind === 'commit' && resolved.provider.loadCommit) {
          const payload = await resolved.provider.loadCommit(ctx, options.ref, { accept: ACCEPT });
          // The digest check is the whole reason the payload carries one: a
          // service that served the wrong commit's bytes would otherwise be
          // indistinguishable from one that served the right ones, and the
          // user would be looking at a model labelled as a version it is not.
          if (payload.artifactDigest !== options.commit.artifact.digest) {
            toast.error('The commit service returned bytes that do not match this version.');
            return false;
          }
          bytes = payload.bytes;
          fileName = payload.fileName;
          artifactDigest = payload.artifactDigest;
        } else if (resolved.sourceTag) {
          // Revision-only source: `download` with an explicit revision id.
          // Gated by the capability, because listing history does not imply
          // being able to fetch it.
          if (!resolved.provider.manifest.capabilities.downloadHistoricalRevisions) {
            toast.error('This source cannot open older versions.');
            return false;
          }
          bytes = await resolved.provider.download(ctx, {
            projectId: resolved.sourceTag.projectId,
            containerId: resolved.sourceTag.containerId,
            fileId: resolved.sourceTag.fileId,
            revisionId: options.ref.commitId,
          });
          fileName = options.commit.artifact.fileName;
          // The adapter could not know the digest before the bytes existed;
          // now they do, but hashing here would duplicate what the loader
          // already does, so the placeholder is carried and the tag records
          // that it is one.
          artifactDigest = options.commit.artifact.digest;
        } else {
          toast.error('This version cannot be opened from its source.');
          return false;
        }

        dispatchSourceDownload([
          {
            name: fileName,
            buffer: bytes,
            commit: {
              provider: resolved.provider.manifest.name,
              projectId: options.ref.projectId,
              sourceModelId: options.ref.modelId,
              commitId: options.ref.commitId,
              artifactDigest,
              historical: options.ref.commitId !== options.headCommitId,
              loadedAt: Date.now(),
            },
            ...(resolved.sourceTag ? { tag: resolved.sourceTag } : {}),
            ...(options.mode === 'replace' ? { replaceModelId: options.modelId } : {}),
            ...(options.mode === 'alongside' && options.displayName !== undefined
              ? { displayName: options.displayName }
              : {}),
          },
        ]);
        return true;
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        toast.error(
          code === 'forbidden'
            ? 'You do not have access to this version.'
            : `Failed to open this version: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      }
    },
    [resolveProvider],
  );

  return { openCommit };
}

/** "Back to latest version": open the model's head in place. */
export function useBackToLatest(): (modelId: string) => void {
  const { openCommit } = useCommitLoad();
  const resolveProvider = useResolveHistoryProvider();

  return useCallback(
    (modelId: string) => {
      const resolved = resolveProvider(modelId);
      if (!resolved || resolved.kind !== 'commit' || !resolved.provider.getModel) return;
      void (async () => {
        const ctx = resolved.createContext();
        const ref = { projectId: resolved.projectId, modelId: resolved.sourceModelId };
        const model = await resolved.provider.getModel!(ctx, ref);
        if (model.headCommitId === '') return;
        const head = await resolved.provider.getCommit!(ctx, { ...ref, commitId: model.headCommitId });
        await openCommit({
          modelId,
          ref: { ...ref, commitId: head.id },
          commit: head,
          mode: 'replace',
          headCommitId: model.headCommitId,
        });
        useViewerStore.getState().clearNewHead(modelId);
      })();
    },
    [openCommit, resolveProvider],
  );
}
