/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Show in 3D": make sure both commits are loaded, then hand off to the
 * EXISTING compare.
 *
 * There is no second diff engine here and no second overlay. The handoff is
 * three writes — `compareBaseModelId`, `compareHeadModelId`, and the reviewed
 * identity as key aliases — followed by `runComparison()`. Everything the
 * compare panel already does (scope, exclusions, content matching, the 3D
 * colouring) applies unchanged, which is the whole reason commit compare is
 * worth having rather than a parallel feature that behaves almost the same.
 */

import { useCallback, useRef } from 'react';
import { toast } from '@/components/ui/toast';
import type { CommitRef, SourceCommit } from '@ifc-lite/plugin-api';

import { commitModelDisplayName } from '@/lib/history/commitLabels';
import { getLocale } from '@/i18n/registry';
import { useViewerStore } from '@/store';
import type { CommitTag } from '@/store/slices/historySlice';
import { useCommitLoad } from './useCommitLoad';
import { useCommitIdentity } from './useCommitCompare';

/** How long to wait for a commit opened alongside to finish loading. */
const LOAD_TIMEOUT_MS = 120_000;

function findLoadedCommit(tags: ReadonlyMap<string, CommitTag>, ref: CommitRef): string | null {
  for (const [modelId, tag] of tags) {
    if (tag.sourceModelId === ref.modelId && tag.commitId === ref.commitId && tag.projectId === ref.projectId) {
      return modelId;
    }
  }
  return null;
}

/**
 * Resolves once a viewer model carrying `ref`'s commit tag exists.
 *
 * A store subscription rather than a poll: the tag is written by the download
 * listener the moment the model registers, and polling would either add
 * latency or spin. Times out so a load that dies (a parse failure, a user
 * removing the model mid-flight) does not leave this awaiting forever.
 */
function waitForCommitModel(ref: CommitRef): Promise<string | null> {
  const immediate = findLoadedCommit(useViewerStore.getState().commitTags, ref);
  if (immediate) return Promise.resolve(immediate);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(null);
    }, LOAD_TIMEOUT_MS);
    const unsubscribe = useViewerStore.subscribe((state) => {
      const modelId = findLoadedCommit(state.commitTags, ref);
      if (!modelId) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(modelId);
    });
  });
}

export interface ShowCommitsIn3DInput {
  /** Viewer model id whose history the panel is showing. */
  readonly modelId: string;
  readonly modelName: string;
  readonly base: { readonly ref: CommitRef; readonly commit: SourceCommit };
  readonly head: { readonly ref: CommitRef; readonly commit: SourceCommit };
  readonly headCommitId: string;
  /** Runs the comparison once both models are in place. */
  readonly runComparison: () => Promise<void> | void;
}

export function useShowCommitsIn3D(): {
  showInViewport: (input: ShowCommitsIn3DInput) => Promise<void>;
  busy: boolean;
} {
  const { openCommit } = useCommitLoad();
  const readIdentity = useCommitIdentity();
  const busy = useRef(false);

  const showInViewport = useCallback(
    async (input: ShowCommitsIn3DInput) => {
      if (busy.current) return;
      busy.current = true;
      try {
        const locale = getLocale();
        const ensure = async (side: 'base' | 'head'): Promise<string | null> => {
          const target = input[side];
          const existing = findLoadedCommit(useViewerStore.getState().commitTags, target.ref);
          if (existing) return existing;
          const opened = await openCommit({
            modelId: input.modelId,
            ref: target.ref,
            commit: target.commit,
            mode: 'alongside',
            headCommitId: input.headCommitId,
            displayName: commitModelDisplayName(input.modelName, target.commit, locale),
          });
          if (!opened) return null;
          return waitForCommitModel(target.ref);
        };

        // Sequential, not parallel: the WASM parser is not thread-safe and the
        // source-load queue serializes anyway, so racing two loads only makes
        // the failure modes harder to read.
        const baseModelId = await ensure('base');
        const headModelId = baseModelId ? await ensure('head') : null;
        if (!baseModelId || !headModelId) {
          toast.error('Could not load both versions to compare.');
          return;
        }

        const store = useViewerStore.getState();
        // The BASE is hidden: the compare overlay colours the head in place
        // and a second full-opacity copy of the same building on top of it is
        // unreadable.
        if (baseModelId !== headModelId) store.setModelVisibility(baseModelId, false);

        const identity = await readIdentity(input.modelId, input.base.ref, input.head.ref);
        if (identity.length > 0) {
          store.acceptCompareIdentity({ baseModelId, headModelId }, identity);
        }

        store.setCompareBaseModelId(baseModelId);
        store.setCompareHeadModelId(headModelId);
        await input.runComparison();
      } finally {
        busy.current = false;
      }
    },
    [openCommit, readIdentity],
  );

  return { showInViewport, busy: busy.current };
}
