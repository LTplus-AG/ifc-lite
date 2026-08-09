/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useRef, useState } from 'react';
import type { FileSourceProvider, PluginContext, SourceFile } from '@ifc-lite/plugin-api';
import { usePagedList } from './usePagedList';
import { IFC_NAME_PATTERNS, LIST_PAGE_LIMIT } from './sourceCatalogPaging';

interface UseSourceFileSearchOptions {
  provider: FileSourceProvider;
  ctx: PluginContext;
  /** Project to search within, read at fetch time so a change needs no restart. */
  projectIdRef: { readonly current: string | null };
  /** Report a search error, or clear the current one with `null`. */
  setError: (message: string | null) => void;
}

/**
 * Server-side file search (`capabilities.search` providers only), kept as its
 * own state machine: the query box, whether results are currently displacing
 * the folder listing, and the paged result list.
 *
 * `active` is what the browser switches on — while it is true the file pane
 * renders `items` instead of the catalog, so clearing must reset both.
 */
export function useSourceFileSearch({ provider, ctx, projectIdRef, setError }: UseSourceFileSearchOptions) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(false);
  // The fetcher reads the submitted query from a ref so a new search only
  // needs a `start()`, not a rebuilt hook.
  const queryRef = useRef('');

  const paged = usePagedList<SourceFile>(
    useCallback(
      (cursor, signal) => {
        const projectId = projectIdRef.current;
        const submitted = queryRef.current.trim();
        if (!projectId || !submitted || !provider.searchFiles) return Promise.resolve({ items: [] });
        return provider.searchFiles(
          ctx,
          projectId,
          submitted,
          { namePatterns: IFC_NAME_PATTERNS },
          { cursor, limit: LIST_PAGE_LIMIT, signal },
        );
      },
      [provider, ctx, projectIdRef],
    ),
    setError,
  );

  const clear = useCallback(() => {
    setActive(false);
    setQuery('');
    queryRef.current = '';
    paged.reset();
  }, [paged]);

  const submit = useCallback(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      clear();
      return;
    }
    // A retry after a failed search must not render results under the stale
    // red banner — clear it up front, like handleSync/selectContainer do.
    setError(null);
    queryRef.current = trimmed;
    setActive(true);
    paged.start();
  }, [clear, paged, query, setError]);

  return {
    query,
    active,
    items: paged.items,
    loading: paged.loading,
    loadingMore: paged.loadingMore,
    hasMore: paged.hasMore,
    setQuery,
    submit,
    clear,
    loadMore: paged.loadMore,
  };
}
