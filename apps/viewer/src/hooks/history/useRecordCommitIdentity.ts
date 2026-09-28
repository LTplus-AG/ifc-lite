/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Writing an accepted content match back to the commit service.
 *
 * A user reviewing the Compare panel's suggestions is answering a question
 * the SERVICE also has: "are these two elements the same thing across these
 * two versions?". Keeping that answer in the tab means the next person — and
 * this person tomorrow — is asked it again, and the stored diff the panel
 * shows beside it stays wrong about the same element forever.
 *
 * Best-effort by construction. The decision is already recorded locally
 * before this runs; failing to persist it must not undo it, so the write-back
 * warns and returns rather than throwing into the accept handler.
 */

import { useCallback } from 'react';
import type { CommitRef, IdentityEntryLike } from '@ifc-lite/plugin-api';

import { useViewerStore } from '@/store';
import { useResolveHistoryProvider } from './useHistoryProvider';

function commitRefFor(modelId: string): CommitRef | null {
  const tag = useViewerStore.getState().commitTags.get(modelId);
  return tag ? { projectId: tag.projectId, modelId: tag.sourceModelId, commitId: tag.commitId } : null;
}

export function useRecordCommitIdentity(): (
  baseModelId: string,
  headModelId: string,
  entries: readonly IdentityEntryLike[],
) => void {
  const resolveProvider = useResolveHistoryProvider();

  return useCallback(
    (baseModelId, headModelId, entries) => {
      if (entries.length === 0) return;
      const base = commitRefFor(baseModelId);
      const head = commitRefFor(headModelId);
      // Both sides must be commits OF THE SAME MODEL: identity between two
      // different models is not what `recordIdentity` records, and a service
      // asked to store one would be right to refuse.
      if (!base || !head || base.modelId !== head.modelId) return;

      const resolved = resolveProvider(headModelId);
      if (
        !resolved
        || resolved.provider.manifest.capabilities.commits?.write !== true
        || !resolved.provider.recordIdentity
      ) {
        // No write access: the decision stays local, exactly as it did before
        // commit sources existed.
        return;
      }

      void resolved.provider
        .recordIdentity(resolved.createContext(), base, head, entries)
        .catch((error: unknown) => {
          console.warn('[history] Could not record reviewed identity on the commit service', error);
        });
    },
    [resolveProvider],
  );
}
