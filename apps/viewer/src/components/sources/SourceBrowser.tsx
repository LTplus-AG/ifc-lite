/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import type {
  FileSourceProvider,
  PluginContext,
  SourceProject,
  SourceContainer,
  SourceFile,
} from '@ifc-lite/plugin-api';
import { useIfc } from '@/hooks/useIfc';
import { syncSourceModel } from '@/lib/sources/syncSourceModel';
import { toast } from '@/components/ui/toast';
import { loadDownloadedSourceFileRecords } from '@/lib/sources/persistence';
import { useSourceHost } from '@/services/sources/SourceHostProvider';
import { useViewerStore } from '@/store';
import { useSourceCatalogSync } from './useSourceCatalogSync';
import { usePagedList } from './usePagedList';
import { SourceEntityList, LoadMoreRow } from './SourceEntityList';
import { SourceProjectsStep } from './SourceProjectsStep';
import { SourceFolderStep } from './SourceFolderStep';
import { SourceBrowserHeader } from './SourceBrowserHeader';
import { FolderOpen, AlertCircle } from 'lucide-react';

interface SourceBrowserProps {
  provider: FileSourceProvider;
  ctx: PluginContext;
  onDownload: (selection: { projectId: string; files: readonly SourceFile[] }) => void;
  onBack: () => void;
  /** True while a previously submitted selection is downloading — disables the load button. */
  busy?: boolean;
}

type Step = 'projects' | 'file-areas' | 'folders';

export function SourceBrowser({ provider, ctx, onDownload, onBack, busy = false }: SourceBrowserProps) {
  const sourceHost = useSourceHost();
  const { models, addModel, removeModel } = useIfc();
  const sourceTags = useViewerStore((s) => s.sourceTags);
  const capabilities = provider.manifest.capabilities;
  const [step, setStep] = useState<Step>('projects');
  const [selectedProject, setSelectedProject] = useState<SourceProject | null>(null);
  const [selectedFileArea, setSelectedFileArea] = useState<SourceContainer | null>(null);
  const [selectedContainer, setSelectedContainer] = useState<SourceContainer | null>(null);
  // Selections persist across folders within a file area, so files picked
  // from several folders can be loaded together as one federated model.
  const [selectedFiles, setSelectedFiles] = useState<Map<string, SourceFile>>(new Map());
  const [downloadedRecords, setDownloadedRecords] = useState(() => loadDownloadedSourceFileRecords());
  const [syncingFileIds, setSyncingFileIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // Server-side file search (capabilities.search only).
  const [searchQuery, setSearchQuery] = useState('');
  const [searchActive, setSearchActive] = useState(false);
  const searchQueryRef = useRef('');

  const refreshDownloadedRecords = useCallback(() => {
    setDownloadedRecords(loadDownloadedSourceFileRecords());
  }, []);

  const catalog = useSourceCatalogSync({
    provider,
    ctx,
    setError,
    onSynced: refreshDownloadedRecords,
  });
  const { folders, allFiles } = catalog;

  // Top-level containers ("file areas"): a paged listing with no parent.
  // The fetcher reads the project id from a ref so a project change only
  // needs a `start()`.
  const projectIdRef = useRef<string | null>(null);
  const fileAreasPaged = usePagedList<SourceContainer>(
    useCallback(
      (cursor, signal) => {
        const projectId = projectIdRef.current;
        if (!projectId) return Promise.resolve({ items: [] });
        return provider.listContainers(ctx, projectId, undefined, { cursor, limit: 200, signal });
      },
      [provider, ctx],
    ),
    setError,
  );

  const searchPaged = usePagedList<SourceFile>(
    useCallback(
      (cursor, signal) => {
        const projectId = projectIdRef.current;
        const query = searchQueryRef.current.trim();
        if (!projectId || !query || !provider.searchFiles) return Promise.resolve({ items: [] });
        return provider.searchFiles(
          ctx,
          projectId,
          query,
          { namePatterns: ['*.ifc', '*.ifcx', '*.ifc5'] },
          { cursor, limit: 200, signal },
        );
      },
      [provider, ctx],
    ),
    setError,
  );

  const sortedFolders = useMemo(
    () => [...folders].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })),
    [folders],
  );

  const visibleFiles = useMemo(() => {
    if (searchActive) return searchPaged.items;
    const targetId = selectedContainer?.id ?? selectedFileArea?.id;
    if (!targetId || !selectedFileArea) return [];
    if (capabilities.listFilesIsRecursive && targetId === selectedFileArea.id) return allFiles;
    return allFiles.filter((file) => file.containerId === targetId);
  }, [allFiles, capabilities.listFilesIsRecursive, searchActive, searchPaged.items, selectedContainer, selectedFileArea]);

  const sortedFiles = useMemo(
    () => [...visibleFiles].sort((left, right) => left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: 'base',
    })),
    [visibleFiles],
  );

  const loadedModelIdsByFileId = useMemo(() => {
    const next = new Map<string, string[]>();
    if (!selectedProject) return next;

    for (const [modelId, tag] of sourceTags) {
      if (tag.provider !== provider.manifest.name || tag.projectId !== selectedProject.id) {
        continue;
      }
      const current = next.get(tag.fileId);
      if (current) {
        current.push(modelId);
      } else {
        next.set(tag.fileId, [modelId]);
      }
    }

    return next;
  }, [provider.manifest.name, selectedProject, sourceTags]);
  const loadedModelNamesByFileId = useMemo(() => {
    const next = new Map<string, string[]>();
    for (const [fileId, modelIds] of loadedModelIdsByFileId) {
      next.set(
        fileId,
        modelIds.map((modelId) => models.get(modelId)?.name).filter((name): name is string => Boolean(name)),
      );
    }
    return next;
  }, [loadedModelIdsByFileId, models]);

  useEffect(() => {
    refreshDownloadedRecords();
  }, [refreshDownloadedRecords, selectedFileArea?.id]);

  const clearSearch = useCallback(() => {
    setSearchActive(false);
    setSearchQuery('');
    searchQueryRef.current = '';
    searchPaged.reset();
  }, [searchPaged]);

  const submitSearch = useCallback(() => {
    const query = searchQuery.trim();
    if (!query) {
      clearSearch();
      return;
    }
    // A retry after a failed search must not render results under the stale
    // red banner — clear it up front, like handleSync/selectContainer do.
    setError(null);
    searchQueryRef.current = query;
    setSearchActive(true);
    searchPaged.start();
  }, [clearSearch, searchPaged, searchQuery]);

  const selectContainer = useCallback((c: SourceContainer) => {
    setError(null);
    setSelectedContainer(c);
    catalog.openContainer(c);
  }, [catalog]);

  const openProject = useCallback(
    (p: SourceProject) => {
      setSelectedProject(p);
      setStep('file-areas');
      setSelectedFileArea(null);
      setSelectedContainer(null);
      setSelectedFiles(new Map());
      setError(null);
      clearSearch();
      catalog.resetCatalog();
      projectIdRef.current = p.id;
      fileAreasPaged.start();
    },
    [catalog, clearSearch, fileAreasPaged],
  );

  const openFileArea = useCallback(
    (c: SourceContainer) => {
      if (!selectedProject) return;
      setSelectedFileArea(c);
      setStep('folders');
      setSelectedFiles(new Map());
      setSelectedContainer(c);
      setError(null);
      clearSearch();
      catalog.openFileArea(selectedProject.id, c.id);
    },
    [catalog, clearSearch, selectedProject],
  );

  const toggleFile = useCallback((file: SourceFile) => {
    setSelectedFiles((prev) => {
      const next = new Map(prev);
      if (next.has(file.id)) next.delete(file.id);
      else next.set(file.id, file);
      return next;
    });
  }, []);

  const handleLoad = useCallback(() => {
    const toLoad = Array.from(selectedFiles.values());
    if (toLoad.length > 0 && selectedProject) {
      onDownload({ projectId: selectedProject.id, files: toLoad });
    }
  }, [onDownload, selectedFiles, selectedProject]);

  const handleSync = useCallback(() => {
    if (!selectedProject || !selectedFileArea || catalog.syncing) return;
    setError(null);
    // A manual sync refetches from the area root. Per-folder catalogs
    // (direct-children containers or per-folder files) are dropped by it, so
    // the selection returns to the root rather than pointing at a folder
    // whose data is gone until re-entered.
    if (capabilities.containerListing === 'direct-children' || !capabilities.listFilesIsRecursive) {
      setSelectedContainer(selectedFileArea);
    }
    void catalog.syncFileArea(selectedProject.id, selectedFileArea.id, { announce: true });
  }, [capabilities, catalog, selectedFileArea, selectedProject]);

  const handleSyncLoadedFile = useCallback(async (file: SourceFile) => {
    const loadedModelIds = loadedModelIdsByFileId.get(file.id);
    if (!loadedModelIds || loadedModelIds.length === 0) return;

    setSyncingFileIds((previous) => new Set(previous).add(file.id));
    try {
      let synced = 0;
      let lastLatestFileName: string | undefined;
      let lastProviderTitle: string | undefined;
      for (const modelId of loadedModelIds) {
        const tag = sourceTags.get(modelId);
        if (!tag) continue;

        const { latestFile } = await syncSourceModel({
          modelId,
          tag,
          sourceHost,
          addModel,
          removeModel,
        });
        synced += 1;
        lastLatestFileName = latestFile.name;
        lastProviderTitle = sourceHost.get(tag.provider)?.manifest.title ?? tag.provider;
      }
      refreshDownloadedRecords();
      if (synced > 0 && lastLatestFileName && lastProviderTitle) {
        toast.success(
          synced === 1
            ? `Synced ${lastLatestFileName} from ${lastProviderTitle}`
            : `Synced ${synced} models from ${lastProviderTitle}`,
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to sync source model');
    } finally {
      setSyncingFileIds((previous) => {
        const next = new Set(previous);
        next.delete(file.id);
        return next;
      });
    }
  }, [
    addModel,
    loadedModelIdsByFileId,
    refreshDownloadedRecords,
    removeModel,
    sourceHost,
    sourceTags,
  ]);

  const goBack = useCallback(() => {
    // A failed listing must never leave a dead-end screen: navigating always
    // clears the error and re-renders the previous step's list.
    setError(null);
    if (step === 'folders') {
      setStep('file-areas');
      setSelectedFileArea(null);
      setSelectedContainer(null);
      setSelectedFiles(new Map());
      clearSearch();
      catalog.resetCatalog();
    } else if (step === 'file-areas') {
      setStep('projects');
      setSelectedProject(null);
      projectIdRef.current = null;
      fileAreasPaged.reset();
    } else {
      onBack();
    }
  }, [catalog, clearSearch, fileAreasPaged, step, onBack]);

  // Keep selected files fresh as listings update; files that vanished from
  // the source drop out of the selection.
  useEffect(() => {
    // Files selected while a search is active come from `searchPaged.items`,
    // not `allFiles` — reconciling against `allFiles` alone would drop a
    // search-origin selection the moment the catalog changes underneath it
    // (e.g. "Load more files" or a manual sync), with no message to the user.
    const byId = new Map(
      [...allFiles, ...searchPaged.items].map((file) => [file.id, file] as const),
    );
    setSelectedFiles((previous) => {
      let changed = false;
      const next = new Map<string, SourceFile>();
      for (const [id, file] of previous) {
        const fresh = byId.get(id);
        if (!fresh) {
          changed = true;
          continue;
        }
        next.set(id, fresh);
        if (fresh !== file) changed = true;
      }
      return changed ? next : previous;
    });
  }, [allFiles, searchPaged.items]);

  const selectedContainerId = selectedContainer?.id ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <SourceBrowserHeader
        step={step}
        providerTitle={provider.manifest.title}
        selectedProject={selectedProject}
        selectedFileArea={selectedFileArea}
        catalogUpdatedAt={catalog.catalogUpdatedAt}
        syncing={catalog.syncing}
        busy={busy}
        onBack={goBack}
        onSync={handleSync}
      />

      {error && (
        <div className="flex items-center gap-2 border-b px-3 py-2 text-sm text-red-600 dark:text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
          <span>{error}</span>
        </div>
      )}

      {step === 'projects' && (
        <SourceProjectsStep
          provider={provider}
          ctx={ctx}
          onError={setError}
          onSelect={openProject}
        />
      )}

      {step === 'file-areas' && (
        <div className="flex-1 overflow-y-auto">
          <SourceEntityList
            items={fileAreasPaged.items}
            loading={fileAreasPaged.loading}
            icon={FolderOpen}
            emptyLabel="No file areas found"
            onSelect={openFileArea}
          />
          <LoadMoreRow
            hasMore={fileAreasPaged.hasMore}
            loading={fileAreasPaged.loadingMore}
            onLoadMore={() => {
              setError(null);
              fileAreasPaged.loadMore();
            }}
            label="Load more"
          />
        </div>
      )}

      {step === 'folders' && selectedFileArea && (
        <SourceFolderStep
          providerName={provider.manifest.name}
          selectedProject={selectedProject}
          selectedFileArea={selectedFileArea}
          selectedContainer={selectedContainer}
          onSelectContainer={selectContainer}
          sortedFolders={sortedFolders}
          allFiles={allFiles}
          gateEmptyFolders={
            capabilities.containerListing === 'flat-subtree' &&
            capabilities.listFilesIsRecursive &&
            catalog.catalogComplete
          }
          loadingFolders={catalog.loadingFolders}
          loadingFiles={searchActive ? searchPaged.loading : catalog.loadingFiles}
          sortedFiles={sortedFiles}
          selectedFiles={selectedFiles}
          onToggleFile={toggleFile}
          downloadedRecords={downloadedRecords}
          loadedModelNamesByFileId={loadedModelNamesByFileId}
          syncingFileIds={syncingFileIds}
          onSyncLoadedFile={(file) => void handleSyncLoadedFile(file)}
          busy={busy}
          onLoad={handleLoad}
          foldersHaveMore={catalog.hasMoreFolders(selectedContainerId)}
          onLoadMoreFolders={() => {
            setError(null);
            catalog.loadMoreFolders(selectedContainerId);
          }}
          filesHaveMore={
            searchActive ? searchPaged.hasMore : catalog.hasMoreFiles(selectedContainerId)
          }
          onLoadMoreFiles={() => {
            setError(null);
            if (searchActive) searchPaged.loadMore();
            else catalog.loadMoreFiles(selectedContainerId);
          }}
          loadingMore={catalog.loadingMore || searchPaged.loadingMore}
          searchEnabled={capabilities.search && provider.searchFiles !== undefined}
          searchQuery={searchQuery}
          searchActive={searchActive}
          onSearchQueryChange={setSearchQuery}
          onSearchSubmit={submitSearch}
          onSearchClear={clearSearch}
        />
      )}
    </div>
  );
}
