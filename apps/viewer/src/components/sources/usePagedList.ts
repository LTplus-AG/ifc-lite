/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Page } from '@ifc-lite/plugin-api';

export interface PagedListState<T> {
  readonly items: readonly T[];
  /** True while the first page is loading (list is empty or being replaced). */
  readonly loading: boolean;
  /** True while a follow-up page is loading. */
  readonly loadingMore: boolean;
  /** True when the provider reported another page after the last one fetched. */
  readonly hasMore: boolean;
  /** (Re)start from the first page. */
  readonly start: () => void;
  /** Fetch the next page and append. No-op while loading or when exhausted. */
  readonly loadMore: () => void;
  /** Drop all items and cancel any in-flight fetch. */
  readonly reset: () => void;
}

/**
 * Drives a v2 `Page<T>` listing from the UI: first page eagerly, further
 * pages on demand — never a silent truncation, never an eager drain of
 * thousands of items. Aborts in-flight fetches when restarted, reset, or
 * unmounted, and reports errors through `onError` instead of throwing into
 * React.
 */
export function usePagedList<T>(
  fetchPage: (cursor: string | undefined, signal: AbortSignal) => Promise<Page<T>>,
  onError: (message: string) => void,
): PagedListState<T> {
  const [items, setItems] = useState<readonly T[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [hasMore, setHasMore] = useState(false);

  // Bumped whenever a newer request supersedes older ones; stale responses
  // compare against it before touching state.
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);

  const beginRequest = useCallback((): { requestId: number; signal: AbortSignal } => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    return { requestId: ++requestIdRef.current, signal: controller.signal };
  }, []);

  const runFetch = useCallback(
    (fromCursor: string | undefined, append: boolean) => {
      const { requestId, signal } = beginRequest();
      busyRef.current = true;
      if (append) setLoadingMore(true);
      else setLoading(true);

      void (async () => {
        try {
          const page = await fetchPage(fromCursor, signal);
          if (requestIdRef.current !== requestId) return;
          setItems((previous) => (append ? [...previous, ...page.items] : [...page.items]));
          setCursor(page.cursor);
          setHasMore(page.cursor !== undefined);
        } catch (err) {
          if (requestIdRef.current !== requestId) return;
          if (err instanceof DOMException && err.name === 'AbortError') return;
          onError(err instanceof Error ? err.message : String(err));
        } finally {
          if (requestIdRef.current === requestId) {
            busyRef.current = false;
            setLoading(false);
            setLoadingMore(false);
          }
        }
      })();
    },
    [beginRequest, fetchPage, onError],
  );

  const start = useCallback(() => {
    setItems([]);
    setCursor(undefined);
    setHasMore(false);
    runFetch(undefined, false);
  }, [runFetch]);

  const loadMore = useCallback(() => {
    if (busyRef.current || cursor === undefined) return;
    runFetch(cursor, true);
  }, [cursor, runFetch]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    requestIdRef.current++;
    busyRef.current = false;
    setItems([]);
    setCursor(undefined);
    setHasMore(false);
    setLoading(false);
    setLoadingMore(false);
  }, []);

  useEffect(() => () => {
    abortRef.current?.abort();
    requestIdRef.current++;
  }, []);

  return { items, loading, loadingMore, hasMore, start, loadMore, reset };
}
