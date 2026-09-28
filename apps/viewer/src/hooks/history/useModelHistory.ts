/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Paged commit history for one loaded model.
 *
 * Commits are immutable by contract, so pages are cached in a MODULE-LEVEL
 * map with no expiry, keyed by `provider|projectId|sourceModelId`. That is
 * the point of the immutability guarantee: re-opening the panel, or switching
 * focus back and forth between two models, costs nothing after the first
 * fetch. Only the head can move, and `useCommitWatch` is what notices that.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SourceCommit, SourceModel } from '@ifc-lite/plugin-api';

import { joinCommitPages } from '@/lib/history/commitGraph';
import { loadRevisionHistoryPage } from '@/lib/sources/revisionsAsCommits';
import { useViewerStore } from '@/store';
import { useHistoryProvider, type HistoryKind } from './useHistoryProvider';

const PAGE_SIZE = 50;

interface CachedHistory {
  model: SourceModel | null;
  commits: SourceCommit[];
  cursor: string | undefined;
  /** `true` once a page came back without a cursor. */
  complete: boolean;
}

const cache = new Map<string, CachedHistory>();

function cacheKey(provider: string, projectId: string, sourceModelId: string): string {
  return `${provider}|${projectId}|${sourceModelId}`;
}

/** Drops the cache. Exported for tests and for the "a commit was just created" path. */
export function invalidateModelHistory(provider?: string, projectId?: string, sourceModelId?: string): void {
  if (provider === undefined || projectId === undefined || sourceModelId === undefined) {
    cache.clear();
    return;
  }
  cache.delete(cacheKey(provider, projectId, sourceModelId));
}

export interface ModelHistoryState {
  readonly kind: HistoryKind | 'no-source';
  readonly model: SourceModel | null;
  readonly commits: readonly SourceCommit[];
  readonly loading: boolean;
  readonly error: string | null;
  /** Provider error code, when the failure carried one — `forbidden` reads differently to the user. */
  readonly errorCode: string | null;
  readonly hasMore: boolean;
  /** `false` for a revision-only source that cannot fetch historical bytes. */
  readonly canOpenHistorical: boolean;
  readonly loadMore: () => void;
  readonly reload: () => void;
}

const EMPTY: readonly SourceCommit[] = [];

export function useModelHistory(modelId: string | null): ModelHistoryState {
  const resolved = useHistoryProvider(modelId);
  const sourceFile = useViewerStore((s) => (modelId ? s.sourceTags.get(modelId) : undefined));
  const [, forceRender] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [canOpenHistorical, setCanOpenHistorical] = useState(true);
  // Guards against a page from a previous focus landing after the user moved
  // on: every fetch captures the key it was started for.
  const activeKey = useRef<string | null>(null);

  const key = resolved ? cacheKey(resolved.provider.manifest.name, resolved.projectId, resolved.sourceModelId) : null;
  const entry = key ? cache.get(key) : undefined;

  const fetchPage = useCallback(
    async (append: boolean) => {
      if (!resolved || !key) return;
      const existing = cache.get(key);
      if (append && existing?.complete) return;
      activeKey.current = key;
      setLoading(true);
      setError(null);
      setErrorCode(null);
      try {
        const ctx = resolved.createContext();
        const cursor = append ? existing?.cursor : undefined;

        if (resolved.kind === 'commit') {
          const ref = { projectId: resolved.projectId, modelId: resolved.sourceModelId };
          const [model, page] = await Promise.all([
            resolved.provider.getModel!(ctx, ref),
            resolved.provider.listCommits!(ctx, ref, { cursor, limit: PAGE_SIZE }),
          ]);
          if (activeKey.current !== key) return;
          cache.set(key, {
            model,
            commits: append ? joinCommitPages(existing?.commits ?? EMPTY, page.items) : [...page.items],
            cursor: page.cursor,
            complete: page.cursor === undefined,
          });
          setCanOpenHistorical(true);
        } else if (resolved.kind === 'revision' && sourceFile) {
          // The adapter needs the FILE, and a revision-only provider has no
          // "get file by id" — so the file's own listing metadata, captured
          // in the source tag at load time, is what addresses it.
          const page = await loadRevisionHistoryPage(
            resolved.provider,
            ctx,
            {
              projectId: sourceFile.projectId,
              containerId: sourceFile.containerId,
              fileId: sourceFile.fileId,
            },
            {
              id: sourceFile.fileId,
              name: useViewerStore.getState().models.get(modelId ?? '')?.name ?? sourceFile.fileId,
              containerId: sourceFile.containerId,
              currentRevisionId: sourceFile.revisionId,
            },
            { cursor, limit: PAGE_SIZE },
          );
          if (activeKey.current !== key) return;
          cache.set(key, {
            model: page?.model ?? null,
            commits: append ? joinCommitPages(existing?.commits ?? EMPTY, page?.commits ?? EMPTY) : [...(page?.commits ?? EMPTY)],
            cursor: page?.cursor,
            complete: page?.cursor === undefined,
          });
          setCanOpenHistorical(page?.canOpenHistorical ?? false);
        }
        forceRender((tick) => tick + 1);
      } catch (caught) {
        if (activeKey.current !== key) return;
        const code = (caught as { code?: unknown } | null)?.code;
        setErrorCode(typeof code === 'string' ? code : null);
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (activeKey.current === key) setLoading(false);
      }
    },
    [resolved, key, sourceFile, modelId],
  );

  useEffect(() => {
    if (!key || !resolved || resolved.kind === 'none') return;
    if (cache.has(key)) {
      activeKey.current = key;
      return;
    }
    void fetchPage(false);
  }, [key, resolved, fetchPage]);

  const reload = useCallback(() => {
    if (key) cache.delete(key);
    void fetchPage(false);
  }, [key, fetchPage]);

  const loadMore = useCallback(() => {
    void fetchPage(true);
  }, [fetchPage]);

  return {
    kind: resolved ? resolved.kind : 'no-source',
    model: entry?.model ?? null,
    commits: entry?.commits ?? EMPTY,
    loading,
    error,
    errorCode,
    hasMore: entry !== undefined && !entry.complete,
    canOpenHistorical,
    loadMore,
    reload,
  };
}
