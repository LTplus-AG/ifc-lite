/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One background "did any loaded model get a new head?" pass per History
 * panel mount.
 *
 * Nothing reloads automatically. The result is recorded with `noteNewHead`
 * and rendered as an action the user can take — opening a newer version
 * under someone while they are reading it is the behaviour every CDE viewer
 * gets complained about for.
 */

import { useEffect } from 'react';

import { claimRevisionWatchSlot } from '@/lib/sources/revisionWatch';
import { watchSourceCommits } from '@/lib/sources/commitWatch';
import { useOptionalSourceHost } from '@/services/sources/SourceHostProvider';
import { useViewerStore } from '@/store';

export function useCommitWatch(enabled: boolean): void {
  const sourceHost = useOptionalSourceHost();

  useEffect(() => {
    if (!enabled || !sourceHost) return;
    const tags = useViewerStore.getState().commitTags;
    if (tags.size === 0) return;
    // Shares the sources panel's slot, so opening both panels does not double
    // the poll rate against one CDE.
    if (!claimRevisionWatchSlot()) return;

    const controller = new AbortController();
    void watchSourceCommits(sourceHost, tags, controller.signal)
      .then((updates) => {
        if (controller.signal.aborted) return;
        const { noteNewHead } = useViewerStore.getState();
        for (const update of updates) noteNewHead(update.modelId, update.event.headCommitId);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.warn('[history] Background commit check failed', error);
      });
    return () => controller.abort();
  }, [enabled, sourceHost]);
}
