/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo } from 'react';
import type { SourceContainer, SourceFile, SourceProject } from '@ifc-lite/plugin-api';
import type { DownloadedSourceFileRecord } from '@/lib/sources/persistence';
import { getDownloadedSourceFileRecord, getDownloadedSourceFileStatus } from '@/lib/sources/persistence';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SourceFolderTree } from './SourceFolderTree';
import { SourceFileRow } from './SourceFileRow';
import { LoadMoreRow } from './SourceEntityList';
import { Download, FolderOpen, Loader2, Search, Star, X } from 'lucide-react';

interface SourceFolderStepProps {
  providerName: string;
  selectedProject: SourceProject | null;
  selectedFileArea: SourceContainer;
  selectedContainer: SourceContainer | null;
  onSelectContainer: (container: SourceContainer) => void;
  sortedFolders: SourceContainer[];
  allFiles: readonly SourceFile[];
  /** Only grey out folders that contain no files when the catalog is complete
   *  enough to actually know that (flat-subtree + recursive files, no pages
   *  outstanding). Partial or per-folder catalogs must not guess. */
  gateEmptyFolders: boolean;
  loadingFolders: boolean;
  loadingFiles: boolean;
  sortedFiles: readonly SourceFile[];
  selectedFiles: ReadonlyMap<string, SourceFile>;
  onToggleFile: (file: SourceFile) => void;
  downloadedRecords: ReadonlyMap<string, DownloadedSourceFileRecord>;
  loadedModelNamesByFileId: ReadonlyMap<string, readonly string[]>;
  syncingFileIds: ReadonlySet<string>;
  onSyncLoadedFile: (file: SourceFile) => void;
  busy: boolean;
  onLoad: () => void;
  foldersHaveMore: boolean;
  onLoadMoreFolders: () => void;
  filesHaveMore: boolean;
  onLoadMoreFiles: () => void;
  loadingMore: boolean;
  /** Server-side file search — rendered only when the provider declares `capabilities.search`. */
  searchEnabled: boolean;
  searchQuery: string;
  searchActive: boolean;
  onSearchQueryChange: (query: string) => void;
  onSearchSubmit: () => void;
  onSearchClear: () => void;
  /** Favourites — `isFolderFavourite` covers the file area itself as well as the tree. */
  isFolderFavourite: (containerId: string) => boolean;
  onToggleFolderFavourite: (container: SourceContainer) => void;
  isFileFavourite: (file: SourceFile) => boolean;
  onToggleFileFavourite: (file: SourceFile) => void;
}

export function SourceFolderStep({
  providerName,
  selectedProject,
  selectedFileArea,
  selectedContainer,
  onSelectContainer,
  sortedFolders,
  allFiles,
  gateEmptyFolders,
  loadingFolders,
  loadingFiles,
  sortedFiles,
  selectedFiles,
  onToggleFile,
  downloadedRecords,
  loadedModelNamesByFileId,
  syncingFileIds,
  onSyncLoadedFile,
  busy,
  onLoad,
  foldersHaveMore,
  onLoadMoreFolders,
  filesHaveMore,
  onLoadMoreFiles,
  loadingMore,
  searchEnabled,
  searchQuery,
  searchActive,
  onSearchQueryChange,
  onSearchSubmit,
  onSearchClear,
  isFolderFavourite,
  onToggleFolderFavourite,
  isFileFavourite,
  onToggleFileFavourite,
}: SourceFolderStepProps) {
  const containerById = useMemo(() => {
    const entries = sortedFolders.map((folder) => [folder.id, folder] as const);
    entries.push([selectedFileArea.id, selectedFileArea] as const);
    return new Map<string, SourceContainer>(entries);
  }, [sortedFolders, selectedFileArea]);

  const selectedContainerTrail = useMemo(() => {
    if (!selectedContainer) return [];

    const result: SourceContainer[] = [];
    let current: SourceContainer | undefined = selectedContainer;
    const seen = new Set<string>();

    while (current && !seen.has(current.id)) {
      result.unshift(current);
      seen.add(current.id);
      if (current.id === selectedFileArea.id) break;
      current = current.parentId ? containerById.get(current.parentId) : undefined;
    }

    return result;
  }, [containerById, selectedContainer, selectedFileArea]);

  const activeFolderIds = useMemo(() => {
    if (!gateEmptyFolders) return undefined;

    const active = new Set<string>();
    active.add(selectedFileArea.id);

    for (const file of allFiles) {
      let currentId = file.containerId;
      const seen = new Set<string>();

      while (currentId && !seen.has(currentId)) {
        active.add(currentId);
        seen.add(currentId);
        if (currentId === selectedFileArea.id) break;
        currentId = containerById.get(currentId)?.parentId ?? selectedFileArea.id;
      }
    }

    return active;
  }, [allFiles, containerById, gateEmptyFolders, selectedFileArea]);

  const childFolders = useMemo(() => {
    if (!selectedContainer) return [];
    return sortedFolders.filter((folder) => folder.parentId === selectedContainer.id);
  }, [selectedContainer, sortedFolders]);

  const trail = selectedContainerTrail.length > 0 ? selectedContainerTrail : [selectedFileArea];

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <div className="grid min-h-0 flex-1 grid-cols-2 overflow-hidden">
        <div className="flex min-h-0 flex-col overflow-hidden border-r">
          {/* The star is a sibling of the button, not inside it: a button
              cannot nest inside a button. This is how the file area ITSELF
              gets favourited — the tree below only covers its subfolders. */}
          <div
            className={`flex w-full items-center gap-1 pr-1 text-sm hover:bg-accent ${
              selectedContainer?.id === selectedFileArea.id ? 'bg-accent font-medium' : ''
            }`}
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
              onClick={() => onSelectContainer(selectedFileArea)}
            >
              <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">{selectedFileArea.name}</span>
            </button>
            <button
              type="button"
              className={`shrink-0 rounded p-0.5 hover:bg-accent hover:text-foreground ${
                isFolderFavourite(selectedFileArea.id) ? 'text-amber-500' : 'text-muted-foreground'
              }`}
              aria-label={`${isFolderFavourite(selectedFileArea.id) ? 'Remove' : 'Add'} favourite: ${selectedFileArea.name}`}
              aria-pressed={isFolderFavourite(selectedFileArea.id)}
              onClick={() => onToggleFolderFavourite(selectedFileArea)}
            >
              <Star
                className={`h-3.5 w-3.5 ${isFolderFavourite(selectedFileArea.id) ? 'fill-current' : ''}`}
              />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {loadingFolders && sortedFolders.length === 0 ? (
              // Only the initial fetch (no folders loaded yet) shows the
              // spinner in place of the tree. `loadingFolders` also goes
              // true for on-demand child fetches (entering a folder on a
              // `direct-children` provider) — unmounting `SourceFolderTree`
              // then would discard its locally-owned `openIds`, collapsing
              // every already-expanded branch.
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
              </div>
            ) : (
              <>
                <SourceFolderTree
                  containers={sortedFolders}
                  rootId={selectedFileArea.id}
                  selectedId={selectedContainer?.id}
                  activeIds={activeFolderIds}
                  onSelect={onSelectContainer}
                  isFavourite={isFolderFavourite}
                  onToggleFavourite={onToggleFolderFavourite}
                />
                <LoadMoreRow
                  hasMore={foldersHaveMore}
                  loading={loadingMore}
                  onLoadMore={onLoadMoreFolders}
                  label="Load more folders"
                />
              </>
            )}
          </div>
        </div>

        <div className="min-h-0 flex flex-col overflow-hidden">
          {searchEnabled && (
            <div className="border-b px-3 py-2">
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  className="h-8 pl-7 pr-7 text-sm"
                  placeholder="Search files in project…"
                  aria-label="Search files in project"
                  value={searchQuery}
                  onChange={(e) => onSearchQueryChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onSearchSubmit();
                    if (e.key === 'Escape') onSearchClear();
                  }}
                />
                {searchActive && (
                  <button
                    type="button"
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                    aria-label="Clear search"
                    onClick={onSearchClear}
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </button>
                )}
              </div>
              {searchActive && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Showing search results across the whole project.
                </p>
              )}
            </div>
          )}
          {!searchActive && (
            <div className="border-b px-3 py-2 text-xs text-muted-foreground">
              <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
                {trail.map((container, index) => (
                  <div key={container.id} className="flex items-center gap-x-1">
                    <button
                      type="button"
                      className="hover:text-foreground hover:underline"
                      onClick={() => onSelectContainer(container)}
                    >
                      {container.name}
                    </button>
                    {index < trail.length - 1 && <span>/</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
          {!searchActive && childFolders.length > 0 && (
            <div className="border-b px-3 py-2">
              <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                Subfolders
              </div>
              <div className="flex flex-wrap gap-1">
                {childFolders.map((folder) => {
                  const inactive = activeFolderIds !== undefined && !activeFolderIds.has(folder.id);
                  return (
                    <button
                      key={folder.id}
                      type="button"
                      className={`rounded border px-2 py-1 text-xs hover:bg-accent ${
                        inactive ? 'cursor-default text-muted-foreground/60 hover:bg-transparent' : ''
                      }`}
                      disabled={inactive}
                      onClick={() => !inactive && onSelectContainer(folder)}
                    >
                      {folder.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {loadingFiles ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
              </div>
            ) : (
              <>
                <ul className="divide-y">
                  {sortedFiles.map((f) => {
                    const downloadedRecord = selectedProject
                      ? getDownloadedSourceFileRecord(downloadedRecords, providerName, selectedProject.id, f.id)
                      : undefined;

                    return (
                      <SourceFileRow
                        key={f.id}
                        file={f}
                        selected={selectedFiles.has(f.id)}
                        onToggle={() => onToggleFile(f)}
                        loadedModelNames={loadedModelNamesByFileId.get(f.id) ?? []}
                        syncingFile={syncingFileIds.has(f.id)}
                        onSyncLoadedFile={() => onSyncLoadedFile(f)}
                        downloadedStatus={getDownloadedSourceFileStatus(f, downloadedRecord)}
                        favourited={isFileFavourite(f)}
                        onToggleFavourite={() => onToggleFileFavourite(f)}
                      />
                    );
                  })}
                  {sortedFiles.length === 0 && (
                    <li className="px-3 py-4 text-center text-sm text-muted-foreground">
                      {searchActive ? 'No files match this search' : 'No IFC files found in this folder'}
                    </li>
                  )}
                </ul>
                <LoadMoreRow
                  hasMore={filesHaveMore}
                  loading={loadingMore}
                  onLoadMore={onLoadMoreFiles}
                  label="Load more files"
                />
              </>
            )}
          </div>
        </div>
      </div>

      {selectedFiles.size > 0 && (
        <div className="shrink-0 border-t bg-background px-3 py-2">
          <Button className="w-full" onClick={onLoad} disabled={busy}>
            {busy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Download className="mr-2 h-4 w-4" aria-hidden />
            )}
            {busy
              ? 'Loading…'
              : `Load ${selectedFiles.size} file${selectedFiles.size > 1 ? 's' : ''} as federated model`}
          </Button>
        </div>
      )}
    </div>
  );
}
