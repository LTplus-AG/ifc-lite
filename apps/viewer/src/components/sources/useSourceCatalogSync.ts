/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileSourceProvider, PluginContext, SourceContainer, SourceFile } from '@ifc-lite/plugin-api';
import { toast } from '@/components/ui/toast';
import { loadSourceCatalogCache, saveSourceCatalogCache } from '@/lib/sources/persistence';

const IFC_NAME_PATTERNS = ['*.ifc', '*.ifcx', '*.ifc5'];
const LIST_PAGE_LIMIT = 200;

interface PagedItems<T> {
  readonly items: readonly T[];
  readonly cursor?: string;
}

interface UseSourceCatalogSyncOptions {
  provider: FileSourceProvider;
  ctx: PluginContext;
  setError: (message: string | null) => void;
  onSynced?: () => void;
}

/**
 * Owns a file area's folder/file catalog, driven by the provider's declared
 * capabilities:
 *
 * - `containerListing: 'flat-subtree'` — one (paged) listing per file area
 *   returns every descendant folder; the tree nests client-side.
 * - `containerListing: 'direct-children'` — one listing per browsed folder;
 *   entering a folder fetches its children on demand.
 * - `listFilesIsRecursive` — files are fetched once per area and filtered
 *   client-side per folder; otherwise entering a folder fetches its files.
 *
 * Listings are cursor-paged: the first page loads eagerly, further pages on
 * demand via `loadMore*` (never an eager drain, never a silent truncation).
 * Fully-fetched flat-subtree catalogs are cached in localStorage; partial or
 * per-folder catalogs stay in memory only.
 */
export function useSourceCatalogSync({ provider, ctx, setError, onSynced }: UseSourceCatalogSyncOptions) {
  const { containerListing, listFilesIsRecursive } = provider.manifest.capabilities;
  const flatSubtree = containerListing === 'flat-subtree';

  // Guards against a slow, stale fetch overwriting a newer one if the user
  // backs out and re-enters a file area quickly. Bumping it also orphans any
  // in-flight request, which the paired AbortController then cancels.
  const requestGenRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const areaRef = useRef<{ projectId: string; fileAreaId: string } | null>(null);
  // Container ids with an on-demand fetch already running (direct-children /
  // per-folder files), so rapid re-selection cannot double-fetch.
  const openingContainersRef = useRef(new Set<string>());

  // flat-subtree: single entry keyed by the file-area id.
  // direct-children: one entry per browsed parent container.
  const [containersByParent, setContainersByParent] = useState(new Map<string, PagedItems<SourceContainer>>());
  // recursive files: single entry keyed by the file-area id.
  // per-folder files: one entry per browsed container.
  const [filesByContainer, setFilesByContainer] = useState(new Map<string, PagedItems<SourceFile>>());

  const [loadingFolders, setLoadingFolders] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [catalogUpdatedAt, setCatalogUpdatedAt] = useState<number | null>(null);

  const folders = useMemo(() => {
    const byId = new Map<string, SourceContainer>();
    for (const page of containersByParent.values()) {
      for (const container of page.items) byId.set(container.id, container);
    }
    return [...byId.values()];
  }, [containersByParent]);

  const allFiles = useMemo(() => {
    const byId = new Map<string, SourceFile>();
    for (const page of filesByContainer.values()) {
      for (const file of page.items) byId.set(file.id, file);
    }
    return [...byId.values()];
  }, [filesByContainer]);

  /** True when every fetched listing is complete (no cursor outstanding). Only
   *  then can "folder X has no files" be asserted for UI gating. */
  const catalogComplete = useMemo(() => {
    for (const page of containersByParent.values()) if (page.cursor !== undefined) return false;
    for (const page of filesByContainer.values()) if (page.cursor !== undefined) return false;
    return containersByParent.size > 0 || filesByContainer.size > 0;
  }, [containersByParent, filesByContainer]);

  const beginGeneration = useCallback((): { gen: number; signal: AbortSignal } => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    return { gen: ++requestGenRef.current, signal: controller.signal };
  }, []);

  useEffect(() => () => {
    abortRef.current?.abort();
    requestGenRef.current++;
  }, []);

  const fetchContainers = useCallback(
    async (projectId: string, parentKey: string, cursor: string | undefined, signal: AbortSignal) => {
      const page = await provider.listContainers(ctx, projectId, parentKey, {
        cursor,
        limit: LIST_PAGE_LIMIT,
        signal,
      });
      // Providers may omit `parentId` on direct children; normalise so the
      // client-side tree always has a link back to the queried parent.
      const items = page.items.map((container) =>
        container.parentId === undefined ? { ...container, parentId: parentKey } : container,
      );
      return { items, cursor: page.cursor } satisfies PagedItems<SourceContainer>;
    },
    [ctx, provider],
  );

  const fetchFiles = useCallback(
    async (projectId: string, containerId: string, cursor: string | undefined, signal: AbortSignal) => {
      const page = await provider.listFiles(
        ctx,
        projectId,
        containerId,
        { namePatterns: IFC_NAME_PATTERNS },
        { cursor, limit: LIST_PAGE_LIMIT, signal },
      );
      return { items: [...page.items], cursor: page.cursor } satisfies PagedItems<SourceFile>;
    },
    [ctx, provider],
  );

  /** Persist the catalog when (and only when) it is completely fetched and the
   *  provider uses one listing per area — partial pages must not masquerade as
   *  the whole area next session. */
  const maybePersist = useCallback(
    (
      projectId: string,
      fileAreaId: string,
      containers: ReadonlyMap<string, PagedItems<SourceContainer>>,
      files: ReadonlyMap<string, PagedItems<SourceFile>>,
    ) => {
      if (!flatSubtree || !listFilesIsRecursive) return;
      const containerPage = containers.get(fileAreaId);
      const filePage = files.get(fileAreaId);
      if (!containerPage || !filePage) return;
      if (containerPage.cursor !== undefined || filePage.cursor !== undefined) return;
      const entry = saveSourceCatalogCache(
        provider.manifest.name,
        projectId,
        fileAreaId,
        containerPage.items,
        filePage.items,
      );
      setCatalogUpdatedAt(entry.updatedAt);
    },
    [flatSubtree, listFilesIsRecursive, provider.manifest.name],
  );

  const applyCachedCatalog = useCallback(
    (projectId: string, fileAreaId: string): boolean => {
      if (!flatSubtree || !listFilesIsRecursive) return false;
      const cached = loadSourceCatalogCache(provider.manifest.name, projectId, fileAreaId);
      if (!cached) return false;

      setContainersByParent(new Map([[fileAreaId, { items: [...cached.folders] }]]));
      setFilesByContainer(new Map([[fileAreaId, { items: [...cached.files] }]]));
      setCatalogUpdatedAt(cached.updatedAt);
      return true;
    },
    [flatSubtree, listFilesIsRecursive, provider.manifest.name],
  );

  const syncFileArea = useCallback(
    async (projectId: string, fileAreaId: string, options: { announce?: boolean } = {}) => {
      const { gen, signal } = beginGeneration();
      areaRef.current = { projectId, fileAreaId };
      setSyncing(true);
      setLoadingFolders(true);
      setLoadingFiles(true);
      setError(null);

      try {
        // Fetch sequentially to avoid bursting provider-side rate limits.
        const containerPage = await fetchContainers(projectId, fileAreaId, undefined, signal);
        if (requestGenRef.current !== gen) return;
        setContainersByParent(new Map([[fileAreaId, containerPage]]));
        setLoadingFolders(false);

        const filePage = await fetchFiles(projectId, fileAreaId, undefined, signal);
        if (requestGenRef.current !== gen) return;
        const nextContainers = new Map([[fileAreaId, containerPage]]);
        const nextFiles = new Map([[fileAreaId, filePage]]);
        setFilesByContainer(nextFiles);
        setCatalogUpdatedAt(null);
        maybePersist(projectId, fileAreaId, nextContainers, nextFiles);
        onSynced?.();
        if (options.announce) {
          const folderCount = containerPage.items.length;
          const fileCount = filePage.items.length;
          const partial = containerPage.cursor !== undefined || filePage.cursor !== undefined;
          toast.success(
            `Synced ${folderCount} folder${folderCount === 1 ? '' : 's'} and ${fileCount} IFC file${fileCount === 1 ? '' : 's'}${partial ? ' (more available — use Load more)' : ''}`,
          );
        }
      } catch (err) {
        if (requestGenRef.current === gen && !(err instanceof DOMException && err.name === 'AbortError')) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (requestGenRef.current === gen) {
          setLoadingFolders(false);
          setLoadingFiles(false);
          setSyncing(false);
        }
      }
    },
    [beginGeneration, fetchContainers, fetchFiles, maybePersist, onSynced, setError],
  );

  /** Resolves a newly-entered file area's catalog: localStorage cache (complete
   *  flat catalogs only), else a fresh first-page sync. */
  const openFileArea = useCallback(
    (projectId: string, fileAreaId: string) => {
      // Invalidate any in-flight request; its finally block can no longer
      // clear these flags once invalidated, so reset them here.
      abortRef.current?.abort();
      requestGenRef.current += 1;
      areaRef.current = { projectId, fileAreaId };
      openingContainersRef.current.clear();
      setContainersByParent(new Map());
      setFilesByContainer(new Map());
      setCatalogUpdatedAt(null);
      setLoadingFolders(false);
      setLoadingFiles(false);
      setLoadingMore(false);
      setSyncing(false);

      if (applyCachedCatalog(projectId, fileAreaId)) return;
      void syncFileArea(projectId, fileAreaId);
    },
    [applyCachedCatalog, syncFileArea],
  );

  /**
   * Ensures the data a newly-selected container needs is fetched, per the
   * provider's capabilities: children for `direct-children` providers, files
   * for non-recursive ones. No-op (client-side filtering) otherwise.
   */
  const openContainer = useCallback(
    (container: SourceContainer) => {
      const area = areaRef.current;
      if (!area) return;
      const gen = requestGenRef.current;
      const signal = abortRef.current?.signal ?? new AbortController().signal;

      const needChildren =
        !flatSubtree && container.hasChildren !== false && !containersByParent.has(container.id);
      const needFiles = !listFilesIsRecursive && !filesByContainer.has(container.id);
      if (!needChildren && !needFiles) return;
      if (openingContainersRef.current.has(container.id)) return;
      openingContainersRef.current.add(container.id);

      setError(null);
      void (async () => {
        try {
          if (needChildren) {
            setLoadingFolders(true);
            const page = await fetchContainers(area.projectId, container.id, undefined, signal);
            if (requestGenRef.current !== gen) return;
            setContainersByParent((previous) => new Map(previous).set(container.id, page));
            setLoadingFolders(false);
          }
          if (needFiles) {
            setLoadingFiles(true);
            const page = await fetchFiles(area.projectId, container.id, undefined, signal);
            if (requestGenRef.current !== gen) return;
            setFilesByContainer((previous) => new Map(previous).set(container.id, page));
            setLoadingFiles(false);
          }
        } catch (err) {
          if (requestGenRef.current === gen && !(err instanceof DOMException && err.name === 'AbortError')) {
            setError(err instanceof Error ? err.message : String(err));
          }
        } finally {
          openingContainersRef.current.delete(container.id);
          if (requestGenRef.current === gen) {
            setLoadingFolders(false);
            setLoadingFiles(false);
          }
        }
      })();
    },
    [containersByParent, fetchContainers, fetchFiles, filesByContainer, flatSubtree, listFilesIsRecursive, setError],
  );

  /** The map key holding folders for the current selection. */
  const folderKeyFor = useCallback(
    (selectedContainerId: string | null) => {
      const area = areaRef.current;
      if (!area) return null;
      return flatSubtree ? area.fileAreaId : (selectedContainerId ?? area.fileAreaId);
    },
    [flatSubtree],
  );

  /** The map key holding files for the current selection. */
  const fileKeyFor = useCallback(
    (selectedContainerId: string | null) => {
      const area = areaRef.current;
      if (!area) return null;
      return listFilesIsRecursive ? area.fileAreaId : (selectedContainerId ?? area.fileAreaId);
    },
    [listFilesIsRecursive],
  );

  const hasMoreFolders = useCallback(
    (selectedContainerId: string | null) => {
      const key = folderKeyFor(selectedContainerId);
      return key !== null && containersByParent.get(key)?.cursor !== undefined;
    },
    [containersByParent, folderKeyFor],
  );

  const hasMoreFiles = useCallback(
    (selectedContainerId: string | null) => {
      const key = fileKeyFor(selectedContainerId);
      return key !== null && filesByContainer.get(key)?.cursor !== undefined;
    },
    [fileKeyFor, filesByContainer],
  );

  const loadMoreFolders = useCallback(
    (selectedContainerId: string | null) => {
      const area = areaRef.current;
      const key = folderKeyFor(selectedContainerId);
      if (!area || key === null || loadingMore) return;
      const current = containersByParent.get(key);
      if (current?.cursor === undefined) return;

      const gen = requestGenRef.current;
      const signal = abortRef.current?.signal ?? new AbortController().signal;
      setLoadingMore(true);
      void (async () => {
        try {
          const page = await fetchContainers(area.projectId, key, current.cursor, signal);
          if (requestGenRef.current !== gen) return;
          const merged: PagedItems<SourceContainer> = {
            items: [...current.items, ...page.items],
            cursor: page.cursor,
          };
          const next = new Map(containersByParent).set(key, merged);
          setContainersByParent(next);
          maybePersist(area.projectId, area.fileAreaId, next, filesByContainer);
        } catch (err) {
          if (requestGenRef.current === gen && !(err instanceof DOMException && err.name === 'AbortError')) {
            setError(err instanceof Error ? err.message : String(err));
          }
        } finally {
          if (requestGenRef.current === gen) setLoadingMore(false);
        }
      })();
    },
    [containersByParent, fetchContainers, filesByContainer, folderKeyFor, loadingMore, maybePersist, setError],
  );

  const loadMoreFiles = useCallback(
    (selectedContainerId: string | null) => {
      const area = areaRef.current;
      const key = fileKeyFor(selectedContainerId);
      if (!area || key === null || loadingMore) return;
      const current = filesByContainer.get(key);
      if (current?.cursor === undefined) return;

      const gen = requestGenRef.current;
      const signal = abortRef.current?.signal ?? new AbortController().signal;
      setLoadingMore(true);
      void (async () => {
        try {
          const page = await fetchFiles(area.projectId, key, current.cursor, signal);
          if (requestGenRef.current !== gen) return;
          const merged: PagedItems<SourceFile> = {
            items: [...current.items, ...page.items],
            cursor: page.cursor,
          };
          const next = new Map(filesByContainer).set(key, merged);
          setFilesByContainer(next);
          maybePersist(area.projectId, area.fileAreaId, containersByParent, next);
          onSynced?.();
        } catch (err) {
          if (requestGenRef.current === gen && !(err instanceof DOMException && err.name === 'AbortError')) {
            setError(err instanceof Error ? err.message : String(err));
          }
        } finally {
          if (requestGenRef.current === gen) setLoadingMore(false);
        }
      })();
    },
    [containersByParent, fetchFiles, fileKeyFor, filesByContainer, loadingMore, maybePersist, onSynced, setError],
  );

  const resetCatalog = useCallback(() => {
    abortRef.current?.abort();
    requestGenRef.current += 1;
    areaRef.current = null;
    openingContainersRef.current.clear();
    setContainersByParent(new Map());
    setFilesByContainer(new Map());
    setCatalogUpdatedAt(null);
    setLoadingFolders(false);
    setLoadingFiles(false);
    setLoadingMore(false);
    setSyncing(false);
  }, []);

  return {
    folders,
    allFiles,
    filesByContainer,
    catalogComplete,
    loadingFolders,
    loadingFiles,
    loadingMore,
    syncing,
    catalogUpdatedAt,
    openFileArea,
    openContainer,
    syncFileArea,
    resetCatalog,
    hasMoreFolders,
    hasMoreFiles,
    loadMoreFolders,
    loadMoreFiles,
  };
}
