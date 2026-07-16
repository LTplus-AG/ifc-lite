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
import { Button } from '@/components/ui/button';
import { useIfc } from '@/hooks/useIfc';
import { syncSourceModel } from '@/lib/sources/syncSourceModel';
import { SourceFolderTree } from './SourceFolderTree';
import { toast } from '@/components/ui/toast';
import {
  getDownloadedSourceFileRecord,
  getDownloadedSourceFileStatus,
  loadDownloadedSourceFileRecords,
  loadSourceCatalogCache,
  saveSourceCatalogCache,
} from '@/lib/sources/persistence';
import { useSourceHost } from '@/services/sources/SourceHostProvider';
import { useViewerStore } from '@/store';
import {
  ChevronLeft,
  Folder,
  FolderOpen,
  FileBox,
  Download,
  Loader2,
  AlertCircle,
  RefreshCw,
} from 'lucide-react';

interface SourceBrowserProps {
  provider: FileSourceProvider;
  ctx: PluginContext;
  onDownload: (selection: { projectId: string; files: readonly SourceFile[] }) => void;
  onBack: () => void;
  /** True while a previously submitted selection is downloading — disables the load button. */
  busy?: boolean;
}

type Step = 'projects' | 'file-areas' | 'folders';

const IFC_NAME_PATTERNS = ['*.ifc', '*.ifcx', '*.ifc5'];

export function SourceBrowser({ provider, ctx, onDownload, onBack, busy = false }: SourceBrowserProps) {
  const sourceHost = useSourceHost();
  const { models, activeModelId, addModel, removeModel, setActiveModel, setModelCollapsed } = useIfc();
  const sourceTags = useViewerStore((s) => s.sourceTags);
  const setSourceTag = useViewerStore((s) => s.setSourceTag);
  const [step, setStep] = useState<Step>('projects');
  const [projects, setProjects] = useState<SourceProject[]>([]);
  const [selectedProject, setSelectedProject] = useState<SourceProject | null>(null);
  const [fileAreas, setFileAreas] = useState<SourceContainer[]>([]);
  const [selectedFileArea, setSelectedFileArea] = useState<SourceContainer | null>(null);
  const [folders, setFolders] = useState<SourceContainer[]>([]);
  const [selectedContainer, setSelectedContainer] = useState<SourceContainer | null>(null);
  const [files, setFiles] = useState<SourceFile[]>([]);
  const [allFiles, setAllFiles] = useState<SourceFile[]>([]);
  // Selections persist across folders within a file area, so files picked
  // from several folders can be loaded together as one federated model.
  const [selectedFiles, setSelectedFiles] = useState<Map<string, SourceFile>>(new Map());
  const [downloadedRecords, setDownloadedRecords] = useState(() => loadDownloadedSourceFileRecords());

  const [loadingProjects, setLoadingProjects] = useState(false);
  const [loadingFileAreas, setLoadingFileAreas] = useState(false);
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncingFileIds, setSyncingFileIds] = useState<Set<string>>(new Set());
  const [catalogUpdatedAt, setCatalogUpdatedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Guards against a slow, stale fetch overwriting a newer one if the user
  // backs out and re-enters a project/file area quickly.
  const fileAreasRequestRef = useRef(0);
  const fileAreaContentsRequestRef = useRef(0);

  // A file area's folder tree can mean thousands of paginated items — cache
  // it per file area for the life of this browsing session so backing out
  // and re-entering the same file area doesn't re-run the full fetch.
  const foldersCacheRef = useRef(new Map<string, SourceContainer[]>());
  const filesCacheRef = useRef(new Map<string, SourceFile[]>());
  const sortedFolders = useMemo(
    () => [...folders].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })),
    [folders],
  );
  const sortedFiles = useMemo(
    () => [...files].sort((left, right) => left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: 'base',
    })),
    [files],
  );
  const containerById = useMemo(() => {
    const entries = folders.map((folder) => [folder.id, folder] as const);
    if (selectedFileArea) entries.push([selectedFileArea.id, selectedFileArea] as const);
    return new Map<string, SourceContainer>(entries);
  }, [folders, selectedFileArea]);
  const selectedContainerTrail = useMemo(() => {
    if (!selectedFileArea || !selectedContainer) return [];

    const trail: SourceContainer[] = [];
    let current: SourceContainer | undefined = selectedContainer;
    const seen = new Set<string>();

    while (current && !seen.has(current.id)) {
      trail.unshift(current);
      seen.add(current.id);
      if (current.id === selectedFileArea.id) break;
      current = current.parentId ? containerById.get(current.parentId) : undefined;
    }

    return trail;
  }, [containerById, selectedContainer, selectedFileArea]);
  const activeFolderIds = useMemo(() => {
    const active = new Set<string>();
    if (!selectedFileArea) return active;

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

  const load = useCallback(
    async (setLoading: (v: boolean) => void, fn: () => Promise<void>) => {
      setLoading(true);
      setError(null);
      try {
        await fn();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const refreshDownloadedRecords = useCallback(() => {
    setDownloadedRecords(loadDownloadedSourceFileRecords());
  }, []);

  const applyCachedCatalog = useCallback(
    (projectId: string, fileAreaId: string): boolean => {
      const cached = loadSourceCatalogCache(
        provider.manifest.name,
        projectId,
        fileAreaId,
      );
      if (!cached) return false;

      const folders = [...cached.folders];
      const files = [...cached.files];
      foldersCacheRef.current.set(fileAreaId, folders);
      filesCacheRef.current.set(fileAreaId, files);
      setFolders(folders);
      setAllFiles(files);
      setCatalogUpdatedAt(cached.updatedAt);
      return true;
    },
    [provider.manifest.name],
  );

  const syncFileArea = useCallback(
    async (
      projectId: string,
      fileAreaId: string,
      options: { announce?: boolean } = {},
    ) => {
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
        refreshDownloadedRecords();
        if (options.announce) {
          toast.success(
            `Synced ${nextFolders.length} folder${nextFolders.length === 1 ? '' : 's'} and ${nextFiles.length} IFC file${nextFiles.length === 1 ? '' : 's'}`,
          );
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (fileAreaContentsRequestRef.current === requestId) {
          setLoadingFolders(false);
          setLoadingFiles(false);
          setSyncing(false);
        }
      }
    },
    [ctx, provider, refreshDownloadedRecords],
  );

  useEffect(() => {
    load(setLoadingProjects, async () => {
      setProjects(await provider.listProjects(ctx));
    });
  }, [provider, ctx, load]);

  useEffect(() => {
    refreshDownloadedRecords();
  }, [refreshDownloadedRecords, selectedFileArea?.id]);

  const selectContainer = useCallback((c: SourceContainer) => {
    setSelectedContainer(c);
  }, []);

  const openProject = useCallback(
    (p: SourceProject) => {
      const requestId = ++fileAreasRequestRef.current;
      setSelectedProject(p);
      setStep('file-areas');
      setSelectedFileArea(null);
      setFolders([]);
      setSelectedContainer(null);
      setFiles([]);
      setAllFiles([]);
      setSelectedFiles(new Map());
      load(setLoadingFileAreas, async () => {
        const result = await provider.listContainers(ctx, p.id);
        if (fileAreasRequestRef.current === requestId) setFileAreas(result);
      });
    },
    [provider, ctx, load],
  );

  const openFileArea = useCallback(
    (c: SourceContainer) => {
      if (!selectedProject) return;
      fileAreaContentsRequestRef.current += 1;
      setSelectedFileArea(c);
      setStep('folders');
      setSelectedFiles(new Map());
      setSelectedContainer(c);
      setCatalogUpdatedAt(null);

      if (!applyCachedCatalog(selectedProject.id, c.id)) {
        const cachedFolders = foldersCacheRef.current.get(c.id);
        const cachedFiles = filesCacheRef.current.get(c.id);
        if (cachedFolders && cachedFiles) {
          setFolders(cachedFolders);
          setAllFiles(cachedFiles);
          return;
        }
        setFolders([]);
        setAllFiles([]);
        void syncFileArea(selectedProject.id, c.id);
      }
    },
    [applyCachedCatalog, selectedProject, syncFileArea],
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
    if (!selectedProject || !selectedFileArea || syncing) return;
    void syncFileArea(selectedProject.id, selectedFileArea.id, { announce: true });
  }, [selectedFileArea, selectedProject, syncFileArea, syncing]);

  const handleSyncLoadedFile = useCallback(async (file: SourceFile) => {
    const loadedModelIds = loadedModelIdsByFileId.get(file.id);
    const modelId = loadedModelIds?.[0];
    const model = modelId ? models.get(modelId) : undefined;
    const tag = modelId ? sourceTags.get(modelId) : undefined;
    if (!modelId || !model || !tag) return;

    setSyncingFileIds((previous) => new Set(previous).add(file.id));
    try {
      const { latestFile } = await syncSourceModel({
        modelId,
        model,
        tag,
        models,
        activeModelId,
        sourceHost,
        addModel,
        removeModel,
        setModelCollapsed,
        setActiveModel,
        setSourceTag,
      });
      refreshDownloadedRecords();
      toast.success(`Synced ${latestFile.name} from ${tag.provider}`);
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
    activeModelId,
    addModel,
    loadedModelIdsByFileId,
    models,
    refreshDownloadedRecords,
    removeModel,
    setActiveModel,
    setModelCollapsed,
    setSourceTag,
    sourceHost,
    sourceTags,
  ]);

  const goBack = useCallback(() => {
    if (step === 'folders') {
      setStep('file-areas');
      setSelectedFileArea(null);
      setFolders([]);
      setSelectedContainer(null);
      setFiles([]);
      setAllFiles([]);
      setSelectedFiles(new Map());
    } else if (step === 'file-areas') {
      setStep('projects');
      setSelectedProject(null);
      setFileAreas([]);
    } else {
      onBack();
    }
  }, [step, onBack]);

  useEffect(() => {
    if (!selectedFileArea || !selectedContainer) {
      setFiles(allFiles);
      return;
    }

    if (selectedContainer.id === selectedFileArea.id) {
      setFiles(allFiles);
      return;
    }

    setFiles(allFiles.filter((file) => file.containerId === selectedContainer.id));
  }, [allFiles, selectedContainer, selectedFileArea]);

  useEffect(() => {
    const byId = new Map(allFiles.map((file) => [file.id, file] as const));
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
  }, [allFiles]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={goBack}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="truncate text-sm font-medium">
          {step === 'projects' && provider.manifest.title}
          {step === 'file-areas' && selectedProject?.name}
          {step === 'folders' && `${selectedProject?.name} / ${selectedFileArea?.name}`}
        </span>
        {step === 'folders' && selectedProject && selectedFileArea && (
          <div className="ml-auto flex items-center gap-2">
            {catalogUpdatedAt != null && (
              <span className="text-xs text-muted-foreground">
                Synced {formatSyncTime(catalogUpdatedAt)}
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onClick={handleSync}
              disabled={syncing || busy}
            >
              {syncing ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              )}
              Sync
            </Button>
          </div>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {step === 'projects' && (
        <div className="flex-1 overflow-y-auto">
          {loadingProjects && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {!loadingProjects && !error && (
            <ul className="divide-y">
              {projects.map((p) => (
                <li key={p.id}>
                  <button
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                    onClick={() => openProject(p)}
                  >
                    <Folder className="h-4 w-4 text-muted-foreground" />
                    <span className="truncate">{p.name}</span>
                  </button>
                </li>
              ))}
              {projects.length === 0 && (
                <li className="px-3 py-4 text-center text-sm text-muted-foreground">
                  No projects found
                </li>
              )}
            </ul>
          )}
        </div>
      )}

      {step === 'file-areas' && (
        <div className="flex-1 overflow-y-auto">
          {loadingFileAreas && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {!loadingFileAreas && !error && (
            <ul className="divide-y">
              {fileAreas.map((c) => (
                <li key={c.id}>
                  <button
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                    onClick={() => openFileArea(c)}
                  >
                    <FolderOpen className="h-4 w-4 text-muted-foreground" />
                    <span className="truncate">{c.name}</span>
                  </button>
                </li>
              ))}
              {fileAreas.length === 0 && (
                <li className="px-3 py-4 text-center text-sm text-muted-foreground">
                  No file areas found
                </li>
              )}
            </ul>
          )}
        </div>
      )}

      {step === 'folders' && selectedFileArea && (
        <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
          <div className="grid min-h-0 flex-1 grid-cols-2 overflow-hidden">
            <div className="flex min-h-0 flex-col overflow-hidden border-r">
              <button
                type="button"
                className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-accent ${
                  selectedContainer?.id === selectedFileArea.id ? 'bg-accent font-medium' : ''
                }`}
                onClick={() => selectContainer(selectedFileArea)}
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
                    onSelect={selectContainer}
                  />
                )}
              </div>
            </div>

            <div className="min-h-0 flex flex-col overflow-hidden">
              <div className="border-b px-3 py-2 text-xs text-muted-foreground">
                <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
                  {(selectedContainerTrail.length > 0 ? selectedContainerTrail : selectedFileArea ? [selectedFileArea] : []).map((container, index, trail) => (
                    <div key={container.id} className="flex items-center gap-x-1">
                      <button
                        type="button"
                        className="hover:text-foreground hover:underline"
                        onClick={() => selectContainer(container)}
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
                        onClick={() => activeFolderIds.has(folder.id) && selectContainer(folder)}
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
                <>
                  <ul className="divide-y">
                    {sortedFiles.map((f) => {
                      const loadedModelIds = loadedModelIdsByFileId.get(f.id) ?? [];
                      const isLoadedInHierarchy = loadedModelIds.length > 0;
                      const loadedModelNames = loadedModelIds
                        .map((modelId) => models.get(modelId)?.name)
                        .filter((name): name is string => Boolean(name));
                      const syncingFile = syncingFileIds.has(f.id);
                      const downloadedRecord = selectedProject
                        ? getDownloadedSourceFileRecord(
                          downloadedRecords,
                          provider.manifest.name,
                          selectedProject.id,
                          f.id,
                        )
                        : undefined;
                      const downloadedStatus = getDownloadedSourceFileStatus(
                        f,
                        downloadedRecord,
                      );

                      return (
                        <li key={f.id}>
                          <button
                            className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm hover:bg-accent ${
                              downloadedStatus === 'update-available'
                                ? 'text-orange-600 dark:text-orange-400'
                                : ''
                            }`}
                            onClick={() => toggleFile(f)}
                          >
                            <input
                              type="checkbox"
                              className="pointer-events-none mt-0.5"
                              checked={selectedFiles.has(f.id)}
                              readOnly
                            />
                            <FileBox
                              className={`mt-0.5 h-4 w-4 shrink-0 ${
                                downloadedStatus === 'update-available'
                                  ? 'text-orange-500 dark:text-orange-400'
                                  : 'text-muted-foreground'
                              }`}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="flex items-start gap-2">
                                <span className="block min-w-0 flex-1 truncate">
                                  {f.name}
                                </span>
                                {isLoadedInHierarchy && (
                                  <span className="flex shrink-0 items-center gap-1">
                                    <span
                                      className="rounded border border-emerald-300 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:border-emerald-800 dark:text-emerald-300"
                                      title={
                                        loadedModelNames.length > 0
                                          ? `Loaded in hierarchy: ${loadedModelNames.join(', ')}`
                                          : 'Loaded in hierarchy'
                                      }
                                    >
                                      {loadedModelIds.length > 1 ? `${loadedModelIds.length} loaded` : 'Loaded'}
                                    </span>
                                    <button
                                      type="button"
                                      className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                                      aria-label={`Sync ${f.name} from source`}
                                      disabled={syncingFile}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void handleSyncLoadedFile(f);
                                      }}
                                    >
                                      <RefreshCw
                                        className={`h-3.5 w-3.5 ${syncingFile ? 'animate-spin' : ''}`}
                                      />
                                    </button>
                                  </span>
                                )}
                              </span>
                              <span
                                className={`mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs ${
                                  downloadedStatus === 'update-available'
                                    ? 'text-orange-500/90 dark:text-orange-300'
                                    : 'text-muted-foreground'
                                }`}
                              >
                                <span>v{f.revisions[0]?.version ?? 1}</span>
                                {f.sizeBytes != null && (
                                  <span>{formatBytes(f.sizeBytes)}</span>
                                )}
                                {downloadedStatus === 'update-available' && (
                                  <span className="rounded border border-orange-300 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-orange-600 dark:border-orange-700 dark:text-orange-300">
                                    New on Dalux
                                  </span>
                                )}
                              </span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                    {sortedFiles.length === 0 && (
                      <li className="px-3 py-4 text-center text-sm text-muted-foreground">
                        No IFC files found in this folder
                      </li>
                    )}
                  </ul>
                </> 
                )}
              </div>
            </div>
          </div>

          {selectedFiles.size > 0 && (
            <div className="shrink-0 border-t bg-background px-3 py-2">
              <Button className="w-full" onClick={handleLoad} disabled={busy}>
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
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatSyncTime(timestamp: number): string {
  const deltaMs = Math.max(0, Date.now() - timestamp);
  if (deltaMs < 60_000) return 'just now';
  if (deltaMs < 3_600_000) return `${Math.floor(deltaMs / 60_000)}m ago`;
  return `${Math.floor(deltaMs / 3_600_000)}h ago`;
}
