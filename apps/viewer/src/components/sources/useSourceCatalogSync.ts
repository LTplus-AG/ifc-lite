/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useRef, useState } from 'react';
import type { FileSourceProvider, PluginContext, SourceContainer, SourceFile } from '@ifc-lite/plugin-api';
import { toast } from '@/components/ui/toast';
import { loadSourceCatalogCache, saveSourceCatalogCache } from '@/lib/sources/persistence';

const IFC_NAME_PATTERNS = ['*.ifc', '*.ifcx', '*.ifc5'];

interface UseSourceCatalogSyncOptions {
  provider: FileSourceProvider;
  ctx: PluginContext;
  setError: (message: string | null) => void;
  onSynced?: () => void;
}

/**
 * Owns a file area's folder/file catalog: the in-memory + localStorage
 * caches, and the (re)sync fetch against the provider. Kept separate from
 * SourceBrowser's navigation state since it has its own request-guarding
 * and caching concerns.
 */
export function useSourceCatalogSync({ provider, ctx, setError, onSynced }: UseSourceCatalogSyncOptions) {
  // Guards against a slow, stale fetch overwriting a newer one if the user
  // backs out and re-enters a file area quickly.
  const fileAreaContentsRequestRef = useRef(0);

  // A file area's folder tree can mean thousands of paginated items — cache
  // it per file area for the life of this browsing session so backing out
  // and re-entering the same file area doesn't re-run the full fetch.
  const foldersCacheRef = useRef(new Map<string, SourceContainer[]>());
  const filesCacheRef = useRef(new Map<string, SourceFile[]>());

  const [folders, setFolders] = useState<SourceContainer[]>([]);
  const [allFiles, setAllFiles] = useState<SourceFile[]>([]);
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [catalogUpdatedAt, setCatalogUpdatedAt] = useState<number | null>(null);

  const applyCachedCatalog = useCallback(
    (projectId: string, fileAreaId: string): boolean => {
      const cached = loadSourceCatalogCache(provider.manifest.name, projectId, fileAreaId);
      if (!cached) return false;

      const cachedFolders = [...cached.folders];
      const cachedFiles = [...cached.files];
      foldersCacheRef.current.set(fileAreaId, cachedFolders);
      filesCacheRef.current.set(fileAreaId, cachedFiles);
      setFolders(cachedFolders);
      setAllFiles(cachedFiles);
      setCatalogUpdatedAt(cached.updatedAt);
      return true;
    },
    [provider.manifest.name],
  );

  const syncFileArea = useCallback(
    async (projectId: string, fileAreaId: string, options: { announce?: boolean } = {}) => {
      const requestId = ++fileAreaContentsRequestRef.current;
      setSyncing(true);
      setLoadingFolders(true);
      setLoadingFiles(true);
      setError(null);

      try {
        // Fetch sequentially to avoid bursting provider-side rate limits.
        const nextFolders = await provider.listContainers(ctx, projectId, fileAreaId);
        if (fileAreaContentsRequestRef.current !== requestId) return;

        const nextFiles = await provider.listFiles(ctx, fileAreaId, {
          namePatterns: IFC_NAME_PATTERNS,
        });
        if (fileAreaContentsRequestRef.current !== requestId) return;

        foldersCacheRef.current.set(fileAreaId, nextFolders);
        filesCacheRef.current.set(fileAreaId, nextFiles);
        setFolders(nextFolders);
        setAllFiles(nextFiles);
        const cached = saveSourceCatalogCache(
          provider.manifest.name,
          projectId,
          fileAreaId,
          nextFolders,
          nextFiles,
        );
        setCatalogUpdatedAt(cached.updatedAt);
        onSynced?.();
        if (options.announce) {
          toast.success(
            `Synced ${nextFolders.length} folder${nextFolders.length === 1 ? '' : 's'} and ${nextFiles.length} IFC file${nextFiles.length === 1 ? '' : 's'}`,
          );
        }
      } catch (err) {
        if (fileAreaContentsRequestRef.current === requestId) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (fileAreaContentsRequestRef.current === requestId) {
          setLoadingFolders(false);
          setLoadingFiles(false);
          setSyncing(false);
        }
      }
    },
    [ctx, onSynced, provider, setError],
  );

  /** Resolves a newly-entered file area's catalog: localStorage cache, then in-memory cache, then a fresh sync. */
  const openFileArea = useCallback(
    (projectId: string, fileAreaId: string) => {
      // Invalidates any in-flight syncFileArea request. Its own finally block
      // can no longer clear these flags once invalidated, so reset them here.
      fileAreaContentsRequestRef.current += 1;
      setCatalogUpdatedAt(null);
      setLoadingFolders(false);
      setLoadingFiles(false);
      setSyncing(false);

      if (applyCachedCatalog(projectId, fileAreaId)) return;

      const cachedFolders = foldersCacheRef.current.get(fileAreaId);
      const cachedFiles = filesCacheRef.current.get(fileAreaId);
      if (cachedFolders && cachedFiles) {
        setFolders(cachedFolders);
        setAllFiles(cachedFiles);
        return;
      }

      setFolders([]);
      setAllFiles([]);
      void syncFileArea(projectId, fileAreaId);
    },
    [applyCachedCatalog, syncFileArea],
  );

  const resetCatalog = useCallback(() => {
    // See openFileArea: invalidating the request here means its finally
    // block will no longer reset these flags, so do it eagerly.
    fileAreaContentsRequestRef.current += 1;
    setFolders([]);
    setAllFiles([]);
    setCatalogUpdatedAt(null);
    setLoadingFolders(false);
    setLoadingFiles(false);
    setSyncing(false);
  }, []);

  return {
    folders,
    allFiles,
    loadingFolders,
    loadingFiles,
    syncing,
    catalogUpdatedAt,
    openFileArea,
    syncFileArea,
    resetCatalog,
  };
}
