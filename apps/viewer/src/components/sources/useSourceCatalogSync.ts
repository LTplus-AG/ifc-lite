/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileSourceProvider, PluginContext, SourceContainer, SourceFile } from '@ifc-lite/plugin-api';
import { toast } from '@/components/ui/toast';
import { isCatalogCacheable, persistCompleteCatalog, readCachedCatalog } from './sourceCatalogCache';
import { appendPage, fetchContainerPage, fetchFilePage, type PagedItems } from './sourceCatalogPaging';
import {
  collectUniqueById,
  isCatalogComplete,
  pageHasMore,
  resolveCatalogKey,
  type CatalogArea,
} from './sourceCatalogSelectors';

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
 *
 * Page fetching lives in `sourceCatalogPaging`, cache read/write in
 * `sourceCatalogCache`, and the derived views in `sourceCatalogSelectors`;
 * what remains here is the request lifecycle (generations, aborts, flags).
 */
export function useSourceCatalogSync({ provider, ctx, setError, onSynced }: UseSourceCatalogSyncOptions) {
  const { containerListing, listFilesIsRecursive } = provider.manifest.capabilities;
  const flatSubtree = containerListing === 'flat-subtree';
  const cacheable = isCatalogCacheable(provider.manifest.capabilities);
  const providerName = provider.manifest.name;

  // Guards against a slow, stale fetch overwriting a newer one if the user
  // backs out and re-enters a file area quickly. Bumping it also orphans any
  // in-flight request, which the paired AbortController then cancels.
  const requestGenRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const areaRef = useRef<CatalogArea | null>(null);
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

  const folders = useMemo(() => collectUniqueById(containersByParent.values()), [containersByParent]);
  const allFiles = useMemo(() => collectUniqueById(filesByContainer.values()), [filesByContainer]);
  const catalogComplete = useMemo(
    () => isCatalogComplete(containersByParent, filesByContainer),
    [containersByParent, filesByContainer],
  );

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
    (projectId: string, parentKey: string, cursor: string | undefined, signal: AbortSignal) =>
      fetchContainerPage(provider, ctx, projectId, parentKey, cursor, signal),
    [ctx, provider],
  );

  const fetchFiles = useCallback(
    (projectId: string, containerId: string, cursor: string | undefined, signal: AbortSignal) =>
      fetchFilePage(provider, ctx, projectId, containerId, cursor, signal),
    [ctx, provider],
  );

  const maybePersist = useCallback(
    (
      projectId: string,
      fileAreaId: string,
      containers: ReadonlyMap<string, PagedItems<SourceContainer>>,
      files: ReadonlyMap<string, PagedItems<SourceFile>>,
    ) => {
      if (!cacheable) return;
      const updatedAt = persistCompleteCatalog({ providerName, projectId, fileAreaId }, containers, files);
      if (updatedAt !== null) setCatalogUpdatedAt(updatedAt);
    },
    [cacheable, providerName],
  );

  const applyCachedCatalog = useCallback(
    (projectId: string, fileAreaId: string): boolean => {
      if (!cacheable) return false;
      const cached = readCachedCatalog({ providerName, projectId, fileAreaId });
      if (!cached) return false;

      setContainersByParent(cached.containersByParent);
      setFilesByContainer(cached.filesByContainer);
      setCatalogUpdatedAt(cached.updatedAt);
      return true;
    },
    [cacheable, providerName],
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
      //
      // Null the ref as well as aborting it. `beginGeneration()` replaces the
      // controller, but the cached-catalog path below returns early WITHOUT
      // calling it — so a stale, already-aborted controller would stay in the
      // ref, and every later `abortRef.current?.signal` read (openContainer,
      // loadMore) would hand out a pre-aborted signal. Opening a cached file
      // area and then expanding a folder would silently do nothing. Clearing it
      // makes those reads fall through to their `?? new AbortController()`
      // default, which is live.
      abortRef.current?.abort();
      abortRef.current = null;
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
    (selectedContainerId: string | null) =>
      resolveCatalogKey(areaRef.current, selectedContainerId, flatSubtree),
    [flatSubtree],
  );

  /** The map key holding files for the current selection. */
  const fileKeyFor = useCallback(
    (selectedContainerId: string | null) =>
      resolveCatalogKey(areaRef.current, selectedContainerId, listFilesIsRecursive),
    [listFilesIsRecursive],
  );

  const hasMoreFolders = useCallback(
    (selectedContainerId: string | null) => pageHasMore(containersByParent, folderKeyFor(selectedContainerId)),
    [containersByParent, folderKeyFor],
  );

  const hasMoreFiles = useCallback(
    (selectedContainerId: string | null) => pageHasMore(filesByContainer, fileKeyFor(selectedContainerId)),
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
          const next = new Map(containersByParent).set(key, appendPage(current, page));
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
          const next = new Map(filesByContainer).set(key, appendPage(current, page));
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
    // Same gap as openFileArea above: null the ref after aborting so a later
    // on-demand fetch (openContainer, loadMore*) does not inherit an
    // already-aborted signal.
    abortRef.current?.abort();
    abortRef.current = null;
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
