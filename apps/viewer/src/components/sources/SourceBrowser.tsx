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
import { SourceEntityList } from './SourceEntityList';
import { SourceFolderStep } from './SourceFolderStep';
import { SourceBrowserHeader } from './SourceBrowserHeader';
import { Folder, FolderOpen, AlertCircle } from 'lucide-react';

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
  const { models, activeModelId, addModel, removeModel, setActiveModel, setModelCollapsed } = useIfc();
  const sourceTags = useViewerStore((s) => s.sourceTags);
  const setSourceTag = useViewerStore((s) => s.setSourceTag);
  const [step, setStep] = useState<Step>('projects');
  const [projects, setProjects] = useState<SourceProject[]>([]);
  const [selectedProject, setSelectedProject] = useState<SourceProject | null>(null);
  const [fileAreas, setFileAreas] = useState<SourceContainer[]>([]);
  const [selectedFileArea, setSelectedFileArea] = useState<SourceContainer | null>(null);
  const [selectedContainer, setSelectedContainer] = useState<SourceContainer | null>(null);
  const [files, setFiles] = useState<SourceFile[]>([]);
  // Selections persist across folders within a file area, so files picked
  // from several folders can be loaded together as one federated model.
  const [selectedFiles, setSelectedFiles] = useState<Map<string, SourceFile>>(new Map());
  const [downloadedRecords, setDownloadedRecords] = useState(() => loadDownloadedSourceFileRecords());

  const [loadingProjects, setLoadingProjects] = useState(false);
  const [loadingFileAreas, setLoadingFileAreas] = useState(false);
  const [syncingFileIds, setSyncingFileIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const refreshDownloadedRecords = useCallback(() => {
    setDownloadedRecords(loadDownloadedSourceFileRecords());
  }, []);

  const {
    folders,
    allFiles,
    loadingFolders,
    loadingFiles,
    syncing,
    catalogUpdatedAt,
    openFileArea: openFileAreaCatalog,
    syncFileArea,
    resetCatalog,
  } = useSourceCatalogSync({ provider, ctx, setError, onSynced: refreshDownloadedRecords });

  // Guards against a slow, stale fetch overwriting a newer one if the user
  // backs out and re-enters a project quickly.
  const fileAreasRequestRef = useRef(0);

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
      setSelectedContainer(null);
      setFiles([]);
      setSelectedFiles(new Map());
      resetCatalog();
      setLoadingFileAreas(true);
      setError(null);
      void (async () => {
        try {
          const result = await provider.listContainers(ctx, p.id);
          if (fileAreasRequestRef.current !== requestId) return;
          setFileAreas(result);
        } catch (err) {
          if (fileAreasRequestRef.current !== requestId) return;
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          if (fileAreasRequestRef.current === requestId) setLoadingFileAreas(false);
        }
      })();
    },
    [provider, ctx, resetCatalog],
  );

  const openFileArea = useCallback(
    (c: SourceContainer) => {
      if (!selectedProject) return;
      setSelectedFileArea(c);
      setStep('folders');
      setSelectedFiles(new Map());
      setSelectedContainer(c);
      openFileAreaCatalog(selectedProject.id, c.id);
    },
    [openFileAreaCatalog, selectedProject],
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
    if (!loadedModelIds || loadedModelIds.length === 0) return;

    setSyncingFileIds((previous) => new Set(previous).add(file.id));
    try {
      let synced = 0;
      let lastLatestFileName: string | undefined;
      let lastProviderName: string | undefined;
      for (const modelId of loadedModelIds) {
        const model = models.get(modelId);
        const tag = sourceTags.get(modelId);
        if (!model || !tag) continue;

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
        synced += 1;
        lastLatestFileName = latestFile.name;
        lastProviderName = tag.provider;
      }
      refreshDownloadedRecords();
      if (synced > 0 && lastLatestFileName && lastProviderName) {
        toast.success(
          synced === 1
            ? `Synced ${lastLatestFileName} from ${lastProviderName}`
            : `Synced ${synced} models from ${lastProviderName}`,
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
      setSelectedContainer(null);
      setFiles([]);
      setSelectedFiles(new Map());
      resetCatalog();
    } else if (step === 'file-areas') {
      fileAreasRequestRef.current++;
      setStep('projects');
      setSelectedProject(null);
      setFileAreas([]);
    } else {
      onBack();
    }
  }, [step, onBack, resetCatalog]);

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
      <SourceBrowserHeader
        step={step}
        providerTitle={provider.manifest.title}
        selectedProject={selectedProject}
        selectedFileArea={selectedFileArea}
        catalogUpdatedAt={catalogUpdatedAt}
        syncing={syncing}
        busy={busy}
        onBack={goBack}
        onSync={handleSync}
      />

      {error && (
        <div className="flex items-center gap-2 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {step === 'projects' && !error && (
        <div className="flex-1 overflow-y-auto">
          <SourceEntityList
            items={projects}
            loading={loadingProjects}
            icon={Folder}
            emptyLabel="No projects found"
            onSelect={openProject}
          />
        </div>
      )}

      {step === 'file-areas' && !error && (
        <div className="flex-1 overflow-y-auto">
          <SourceEntityList
            items={fileAreas}
            loading={loadingFileAreas}
            icon={FolderOpen}
            emptyLabel="No file areas found"
            onSelect={openFileArea}
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
          loadingFolders={loadingFolders}
          loadingFiles={loadingFiles}
          sortedFiles={sortedFiles}
          selectedFiles={selectedFiles}
          onToggleFile={toggleFile}
          downloadedRecords={downloadedRecords}
          loadedModelNamesByFileId={loadedModelNamesByFileId}
          syncingFileIds={syncingFileIds}
          onSyncLoadedFile={(file) => void handleSyncLoadedFile(file)}
          busy={busy}
          onLoad={handleLoad}
        />
      )}
    </div>
  );
}
