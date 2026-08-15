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
import { loadDownloadedSourceFileRecords } from '@/lib/sources/persistence';
import { useSourceCatalogSync } from './useSourceCatalogSync';
import { useSourceFileSearch } from './useSourceFileSearch';
import { useLoadedSourceModels } from './useLoadedSourceModels';
import { usePagedList } from './usePagedList';
import { SourceProjectsStep } from './SourceProjectsStep';
import { SourceFileAreasStep } from './SourceFileAreasStep';
import { SourceFolderStep } from './SourceFolderStep';
import { SourceBrowserHeader } from './SourceBrowserHeader';
import { AlertCircle } from 'lucide-react';

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
  const capabilities = provider.manifest.capabilities;
  const [step, setStep] = useState<Step>('projects');
  const [selectedProject, setSelectedProject] = useState<SourceProject | null>(null);
  const [selectedFileArea, setSelectedFileArea] = useState<SourceContainer | null>(null);
  const [selectedContainer, setSelectedContainer] = useState<SourceContainer | null>(null);
  // Selections persist across folders within a file area, so files picked
  // from several folders can be loaded together as one federated model.
  const [selectedFiles, setSelectedFiles] = useState<Map<string, SourceFile>>(new Map());
  const [downloadedRecords, setDownloadedRecords] = useState(() => loadDownloadedSourceFileRecords());
  const [error, setError] = useState<string | null>(null);

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

  const search = useSourceFileSearch({ provider, ctx, projectIdRef, setError });

  const loadedModels = useLoadedSourceModels({
    providerName: provider.manifest.name,
    projectId: selectedProject?.id ?? null,
    onSynced: refreshDownloadedRecords,
  });

  const sortedFolders = useMemo(
    () => [...folders].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })),
    [folders],
  );

  // Always scoped to the selected folder's own containerId — even at the
  // file area root, where a recursive-listing provider (e.g. Dalux) already
  // holds every descendant file in `allFiles`. Showing that whole set at the
  // root mixed files from every subfolder together, which broke both the
  // "files only appear in their own folder" expectation and, downstream,
  // made the per-folder alphabetical sort look wrong (it was sorting a
  // cross-folder set, not that folder's files).
  const visibleFiles = useMemo(() => {
    if (search.active) return search.items;
    const targetId = selectedContainer?.id ?? selectedFileArea?.id;
    if (!targetId || !selectedFileArea) return [];
    return allFiles.filter((file) => file.containerId === targetId);
  }, [allFiles, search.active, search.items, selectedContainer, selectedFileArea]);

  const sortedFiles = useMemo(
    () => [...visibleFiles].sort((left, right) => left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: 'base',
    })),
    [visibleFiles],
  );

  useEffect(() => {
    refreshDownloadedRecords();
  }, [refreshDownloadedRecords, selectedFileArea?.id]);

  const clearSearch = search.clear;

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
    // Files selected while a search is active come from the search results,
    // not `allFiles` — reconciling against `allFiles` alone would drop a
    // search-origin selection the moment the catalog changes underneath it
    // (e.g. "Load more files" or a manual sync), with no message to the user.
    const byId = new Map(
      [...allFiles, ...search.items].map((file) => [file.id, file] as const),
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
  }, [allFiles, search.items]);

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
        <SourceFileAreasStep
          fileAreas={fileAreasPaged.items}
          loading={fileAreasPaged.loading}
          hasMore={fileAreasPaged.hasMore}
          loadingMore={fileAreasPaged.loadingMore}
          onSelect={openFileArea}
          onLoadMore={() => {
            setError(null);
            fileAreasPaged.loadMore();
          }}
        />
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
          loadingFiles={search.active ? search.loading : catalog.loadingFiles}
          sortedFiles={sortedFiles}
          selectedFiles={selectedFiles}
          onToggleFile={toggleFile}
          downloadedRecords={downloadedRecords}
          loadedModelNamesByFileId={loadedModels.loadedModelNamesByFileId}
          syncingFileIds={loadedModels.syncingFileIds}
          onSyncLoadedFile={(file) => void loadedModels.syncLoadedFile(file)}
          busy={busy}
          onLoad={handleLoad}
          foldersHaveMore={catalog.hasMoreFolders(selectedContainerId)}
          onLoadMoreFolders={() => {
            setError(null);
            catalog.loadMoreFolders(selectedContainerId);
          }}
          filesHaveMore={search.active ? search.hasMore : catalog.hasMoreFiles(selectedContainerId)}
          onLoadMoreFiles={() => {
            setError(null);
            if (search.active) search.loadMore();
            else catalog.loadMoreFiles(selectedContainerId);
          }}
          loadingMore={catalog.loadingMore || search.loadingMore}
          searchEnabled={capabilities.search && provider.searchFiles !== undefined}
          searchQuery={search.query}
          searchActive={search.active}
          onSearchQueryChange={search.setQuery}
          onSearchSubmit={search.submit}
          onSearchClear={search.clear}
        />
      )}
    </div>
  );
}
