/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo } from 'react';
import type { SourceContainer, SourceFile, SourceProject } from '@ifc-lite/plugin-api';
import type { DownloadedSourceFileRecord } from '@/lib/sources/persistence';
import { getDownloadedSourceFileRecord, getDownloadedSourceFileStatus } from '@/lib/sources/persistence';
import { Button } from '@/components/ui/button';
import { SourceFolderTree } from './SourceFolderTree';
import { SourceFileRow } from './SourceFileRow';
import { Download, FolderOpen, Loader2 } from 'lucide-react';

interface SourceFolderStepProps {
  providerName: string;
  selectedProject: SourceProject | null;
  selectedFileArea: SourceContainer;
  selectedContainer: SourceContainer | null;
  onSelectContainer: (container: SourceContainer) => void;
  sortedFolders: SourceContainer[];
  allFiles: readonly SourceFile[];
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
}

export function SourceFolderStep({
  providerName,
  selectedProject,
  selectedFileArea,
  selectedContainer,
  onSelectContainer,
  sortedFolders,
  allFiles,
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
  }, [allFiles, containerById, selectedFileArea]);

  const childFolders = useMemo(() => {
    if (!selectedContainer) return [];
    return sortedFolders.filter((folder) => folder.parentId === selectedContainer.id);
  }, [selectedContainer, sortedFolders]);

  const trail = selectedContainerTrail.length > 0 ? selectedContainerTrail : [selectedFileArea];

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <div className="grid min-h-0 flex-1 grid-cols-2 overflow-hidden">
        <div className="flex min-h-0 flex-col overflow-hidden border-r">
          <button
            type="button"
            className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-accent ${
              selectedContainer?.id === selectedFileArea.id ? 'bg-accent font-medium' : ''
            }`}
            onClick={() => onSelectContainer(selectedFileArea)}
          >
            <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{selectedFileArea.name}</span>
          </button>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {loadingFolders ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <SourceFolderTree
                containers={sortedFolders}
                rootId={selectedFileArea.id}
                selectedId={selectedContainer?.id}
                activeIds={activeFolderIds}
                onSelect={onSelectContainer}
              />
            )}
          </div>
        </div>

        <div className="min-h-0 flex flex-col overflow-hidden">
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
          {childFolders.length > 0 && (
            <div className="border-b px-3 py-2">
              <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                Subfolders
              </div>
              <div className="flex flex-wrap gap-1">
                {childFolders.map((folder) => (
                  <button
                    key={folder.id}
                    type="button"
                    className={`rounded border px-2 py-1 text-xs hover:bg-accent ${
                      activeFolderIds.has(folder.id)
                        ? ''
                        : 'cursor-default text-muted-foreground/60 hover:bg-transparent'
                    }`}
                    disabled={!activeFolderIds.has(folder.id)}
                    onClick={() => activeFolderIds.has(folder.id) && onSelectContainer(folder)}
                  >
                    {folder.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {loadingFiles ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
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
                    />
                  );
                })}
                {sortedFiles.length === 0 && (
                  <li className="px-3 py-4 text-center text-sm text-muted-foreground">
                    No IFC files found in this folder
                  </li>
                )}
              </ul>
            )}
          </div>
        </div>
      </div>

      {selectedFiles.size > 0 && (
        <div className="shrink-0 border-t bg-background px-3 py-2">
          <Button className="w-full" onClick={onLoad} disabled={busy}>
            {busy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
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
