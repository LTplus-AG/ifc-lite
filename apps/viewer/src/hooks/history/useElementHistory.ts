/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One element's history, for the properties-panel card.
 *
 * Deliberately lazy: the card fetches only when it is expanded. The
 * properties panel re-renders on every selection change, and a request per
 * click would be one round trip per element a user hovers through — for a
 * card most of them never open.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ElementHistoryEntry } from '@ifc-lite/plugin-api';

import { useHistoryProvider } from './useHistoryProvider';

const FIRST_PAGE = 10;

export interface ElementHistoryState {
  readonly entries: readonly ElementHistoryEntry[];
  readonly loading: boolean;
  readonly error: string | null;
  /** `false` when the source has no element history at all. */
  readonly supported: boolean;
  readonly hasMore: boolean;
  readonly loadMore: () => void;
}

const EMPTY: readonly ElementHistoryEntry[] = [];

export function useElementHistory(
  modelId: string | null,
  key: string | null,
  enabled: boolean,
): ElementHistoryState {
  const resolved = useHistoryProvider(modelId);
  const [entries, setEntries] = useState<readonly ElementHistoryEntry[]>(EMPTY);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [complete, setComplete] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const supported =
    resolved?.kind === 'commit'
    && resolved.provider.manifest.capabilities.commits?.elementHistory === true
    && resolved.provider.listElementHistory !== undefined;

  const fetchPage = useCallback(
    async (append: boolean, from: string | undefined) => {
      if (!resolved || !supported || !modelId || !key) return;
      setLoading(true);
      setError(null);
      try {
        const page = await resolved.provider.listElementHistory!(
          resolved.createContext(),
          {
            projectId: resolved.projectId,
            modelId: resolved.sourceModelId,
            key,
            // Anchored at the commit the user is LOOKING at, not at the head:
            // an element selected in a historical model must not be described
            // by what happened to it after that version.
            ...(resolved.commitTag ? { atCommitId: resolved.commitTag.commitId } : {}),
          },
          { cursor: from, limit: FIRST_PAGE },
        );
        setEntries((previous) => (append ? [...previous, ...page.items] : page.items));
        setCursor(page.cursor);
        setComplete(page.cursor === undefined);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setLoading(false);
      }
    },
    [resolved, supported, modelId, key],
  );

  useEffect(() => {
    setEntries(EMPTY);
    setCursor(undefined);
    setComplete(false);
    setError(null);
    if (!enabled || !supported) return;
    void fetchPage(false, undefined);
    // `fetchPage` closes over the selection, so this re-runs when the user
    // picks a different element — which is the intent.
  }, [enabled, supported, fetchPage]);

  const loadMore = useCallback(() => {
    if (complete) return;
    void fetchPage(true, cursor);
  }, [complete, cursor, fetchPage]);

  return { entries, loading, error, supported, hasMore: !complete && entries.length > 0, loadMore };
}
