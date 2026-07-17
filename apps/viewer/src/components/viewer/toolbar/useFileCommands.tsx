/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * File-command surface shared by every desktop toolbar style (classic
 * `MainToolbar` and the ribbon). Owns the Open / Add Model / Refresh
 * flows, the hidden file inputs, and the global `ifc-lite:*` load
 * events, so both toolbars drive the exact same load pipeline and the
 * logic lives once. Exactly one toolbar mounts at a time, so the
 * window listeners registered here never double-fire.
 */

import React, { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { useViewerStore, isIfcxDataStore, type FederatedModel } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import { recordRecentFiles, cacheFileBlobs } from '@/lib/recent-files';
import {
  supportsFileSystemAccess,
  openIfcFilesWithHandles,
  readFreshFile,
} from '@/services/file-system-access';
import { toast } from '@/components/ui/toast';
import { isCollabEnabled } from '@/lib/collab/config';
import { ingestDxfFiles, splitDxfFiles } from '@/hooks/ingest/dxfIngest';
import { ShareDialog } from '../ShareDialog';

/** Extensions the viewer can ingest (IFC / IFCX / GLB / point clouds). */
export function isSupportedModelFile(f: File): boolean {
  const n = f.name.toLowerCase();
  return n.endsWith('.ifc') || n.endsWith('.ifcx') || n.endsWith('.ifczip') || n.endsWith('.glb')
    || n.endsWith('.las') || n.endsWith('.laz') || n.endsWith('.ply') || n.endsWith('.pcd')
    || n.endsWith('.e57') || n.endsWith('.pts') || n.endsWith('.xyz');
}

/** Case-insensitive IFCX check (filenames are accepted case-insensitively). */
function isIfcxModelFile(f: File): boolean {
  return f.name.toLowerCase().endsWith('.ifcx');
}

// `.dxf` files are 2D reference underlays, not models: they split off to
// the DXF ingest path (issue #1782) before model routing.
const FILE_ACCEPT = '.ifc,.ifcx,.ifczip,.glb,.las,.laz,.ply,.pcd,.e57,.pts,.xyz,.dxf';

export interface FileCommands {
  /**
   * Render once inside the toolbar: the two hidden `<input type="file">`
   * fallbacks plus the Share dialog (when collab is enabled). The dialog
   * lives here — not in a tab panel — so `ifc-lite:open-share-dialog`
   * always has a mounted receiver regardless of the active ribbon tab or
   * collapse state.
   */
  fileInputs: React.ReactNode;
  /** Open the Share dialog (same path the `ifc-lite:open-share-dialog` event takes). */
  openShareDialog: () => void;
  /** Open file(s), replacing the current session (FS Access picker when available). */
  handleOpenClick: () => Promise<void>;
  /** Add model(s) to the current federation (FS Access picker when available). */
  handleAddModelClick: () => Promise<void>;
  /** Re-read every loaded model from disk. Only meaningful when `canRefresh`. */
  handleRefresh: () => Promise<void>;
  /** True when every loaded model has a live FS Access handle. */
  canRefresh: boolean;
  /** True when any model (federated map or legacy single result) is loaded. */
  hasModelsLoaded: boolean;
}

export function useFileCommands(): FileCommands {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addModelInputRef = useRef<HTMLInputElement>(null);
  const {
    loadFile,
    loading,
    geometryResult,
    ifcDataStore,
    models,
    clearAllModels,
    loadFilesSequentially,
    loadFederatedIfcx,
    addIfcxOverlays,
    addModel,
  } = useIfc();
  const resetViewerState = useViewerStore((state) => state.resetViewerState);

  // Share dialog host. Owned here (not by a toolbar or tab panel) because
  // this hook is mounted by whichever toolbar style is active for the whole
  // session, while ribbon tab panels unmount on tab switch/collapse — the
  // `ifc-lite:open-share-dialog` event (RoomPanel's "Create a room") must
  // always find a live listener.
  const collabEnabled = useMemo(() => isCollabEnabled(), []);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const openShareDialog = useCallback(() => setShareDialogOpen(true), []);
  useEffect(() => {
    if (!collabEnabled) return;
    const shareHandler = () => setShareDialogOpen(true);
    window.addEventListener('ifc-lite:open-share-dialog', shareHandler);
    return () => window.removeEventListener('ifc-lite:open-share-dialog', shareHandler);
  }, [collabEnabled]);

  // Listen for programmatic file-load requests (from command palette recent files)
  useEffect(() => {
    const handler = (e: Event) => {
      const file = (e as CustomEvent<File>).detail;
      if (file) {
        // Belt-and-suspenders: don't kick off a second primary load while one
        // is in flight. The definitive fix lives in useIfcLoader's
        // stale-session guard, but starting a superseded load at all is
        // wasteful, so skip it here. Read live from the store (not the effect
        // closure) to avoid a stale `loading` value.
        if (useViewerStore.getState().loading) {
          console.warn('[useFileCommands] ifc-lite:load-file ignored - a load is already in progress');
          return;
        }
        recordRecentFiles([{ name: file.name, size: file.size }]);
        void loadFile(file);
      }
    };
    // Federation variant: ADD the file to the current set instead of
    // replacing it (the compare tour loads demo revision B this way).
    const addHandler = (e: Event) => {
      const file = (e as CustomEvent<unknown>).detail;
      if (file instanceof File) void addModel(file);
    };
    // Layer-stack variant: load a File[] as a composed .ifcx federation
    // (the Layers panel demo + tour dispatch this, see lib/layers/demo-stack).
    const stackHandler = (e: Event) => {
      const files = (e as CustomEvent<unknown>).detail;
      if (Array.isArray(files) && files.every((f) => f instanceof File) && files.length > 0) {
        void loadFederatedIfcx(files as File[]);
      }
    };
    window.addEventListener('ifc-lite:load-file', handler);
    window.addEventListener('ifc-lite:add-model', addHandler);
    window.addEventListener('ifc-lite:load-layer-stack', stackHandler);
    return () => {
      window.removeEventListener('ifc-lite:load-file', handler);
      window.removeEventListener('ifc-lite:add-model', addHandler);
      window.removeEventListener('ifc-lite:load-layer-stack', stackHandler);
    };
  }, [loadFile, addModel, loadFederatedIfcx]);

  const hasModelsLoaded = models.size > 0 || Boolean(geometryResult?.meshes && geometryResult.meshes.length > 0);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    // DXF reference underlays split off before model routing (issue #1782).
    const { dxfFiles, modelFiles } = splitDxfFiles(Array.from(files));
    if (dxfFiles.length > 0) void ingestDxfFiles(dxfFiles);

    // Filter to supported files (IFC, IFCX, GLB, point clouds)
    const supportedFiles = modelFiles.filter(isSupportedModelFile);

    if (supportedFiles.length === 0) {
      e.target.value = '';
      return;
    }

    // Track recently opened files (metadata + blob cache for instant reload)
    recordRecentFiles(supportedFiles.map(f => ({ name: f.name, size: f.size })));
    cacheFileBlobs(supportedFiles);

    if (supportedFiles.length === 1) {
      // Single file - use loadFile (simpler single-model path)
      loadFile(supportedFiles[0]);
    } else {
      // Multiple files - check if ALL are IFCX (use federated loading for layer composition)
      const allIfcx = supportedFiles.every(isIfcxModelFile);

      resetViewerState();
      clearAllModels();

      if (allIfcx) {
        // IFCX files use federated loading (layer composition - later files override earlier ones)
        // This handles overlay files that add properties without geometry
        console.log(`[toolbar] Loading ${supportedFiles.length} IFCX files with federated composition`);
        loadFederatedIfcx(supportedFiles);
      } else {
        // Mixed or all IFC4/GLB files - load sequentially as independent models
        loadFilesSequentially(supportedFiles);
      }
    }

    // Reset input so same files can be selected again
    e.target.value = '';
  }, [loadFile, loadFilesSequentially, loadFederatedIfcx, resetViewerState, clearAllModels]);

  // Shared Add-Model routing. `handles` is positionally aligned with
  // `supportedFiles`, carrying a live FS Access handle per file (Chromium) so
  // each added model stays part of a refreshable federation.
  const addSupportedFiles = useCallback((
    supportedFiles: File[],
    handles?: (FileSystemFileHandle | undefined)[],
  ) => {
    if (supportedFiles.length === 0) return;
    const newFilesAreIfcx = supportedFiles.every(isIfcxModelFile);
    const existingIsIfcx = isIfcxDataStore(ifcDataStore);

    if (newFilesAreIfcx && existingIsIfcx) {
      // Adding IFCX overlay(s) to existing IFCX model - re-compose with new layers
      console.log(`[toolbar] Adding ${supportedFiles.length} IFCX overlay(s) to existing IFCX model - re-composing`);
      void addIfcxOverlays(supportedFiles);
    } else if (newFilesAreIfcx && !existingIsIfcx && ifcDataStore) {
      // User trying to add IFCX to IFC4 model - won't work
      console.warn('[toolbar] Cannot add IFCX files to non-IFCX model');
      alert(`IFCX overlay files cannot be added to IFC4 models.\n\nPlease load IFCX files separately.`);
    } else {
      // Standard case - add as independent models (IFC4, GLB, or mixed)
      void loadFilesSequentially(supportedFiles, handles);
    }
  }, [loadFilesSequentially, addIfcxOverlays, ifcDataStore]);

  const handleAddModelSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    // DXF reference underlays split off before model routing (issue #1782).
    const { dxfFiles, modelFiles } = splitDxfFiles(Array.from(files));
    if (dxfFiles.length > 0) void ingestDxfFiles(dxfFiles);
    // <input> yields no live handle, so models added this way aren't refreshable.
    const supportedFiles = modelFiles.filter(isSupportedModelFile);
    addSupportedFiles(supportedFiles);
    // Reset input so same files can be selected again
    e.target.value = '';
  }, [addSupportedFiles]);

  // Preferred Add-Model path: the picker captures a handle per file so the
  // resulting federation can be refreshed. Falls back to the hidden <input>.
  const handleAddModelClick = useCallback(async () => {
    if (!supportsFileSystemAccess()) {
      addModelInputRef.current?.click();
      return;
    }
    const opened = await openIfcFilesWithHandles();
    if (!opened) return;
    // DXF reference underlays split off before model routing (issue #1782).
    const dxfPicked = opened.filter(o => o.file.name.toLowerCase().endsWith('.dxf'));
    if (dxfPicked.length > 0) void ingestDxfFiles(dxfPicked.map(o => o.file));
    const supported = opened.filter(o => isSupportedModelFile(o.file));
    addSupportedFiles(supported.map(o => o.file), supported.map(o => o.handle));
  }, [addSupportedFiles]);

  // Open via the File System Access API when available (Chromium) so we capture
  // a live FileSystemFileHandle for each file — that handle is what lets the
  // Refresh button re-read the same file from disk later (issue #1345). Browsers
  // without the API fall back to the hidden <input type="file">.
  const handleOpenClick = useCallback(async () => {
    if (!supportsFileSystemAccess()) {
      fileInputRef.current?.click();
      return;
    }
    const picked = await openIfcFilesWithHandles();
    if (!picked) return; // cancelled, unavailable, or picker failed
    // DXF reference underlays split off before model routing (issue #1782).
    const dxfPicked = picked.filter(o => o.file.name.toLowerCase().endsWith('.dxf'));
    if (dxfPicked.length > 0) void ingestDxfFiles(dxfPicked.map(o => o.file));
    // The picker keeps an "all files" option, so drop anything unsupported
    // before it reaches the load pipeline (matches the <input> + Add Model paths).
    const opened = picked.filter(o => isSupportedModelFile(o.file));
    if (opened.length === 0) return;

    const files = opened.map(o => o.file);
    recordRecentFiles(files.map(f => ({ name: f.name, size: f.size })));
    void cacheFileBlobs(files);

    if (opened.length === 1) {
      // Single model: keep the handle so Refresh can re-read it from disk.
      void loadFile(opened[0].file, { kind: 'primary' }, { sourceHandle: opened[0].handle });
    } else {
      // Multiple files mirror handleFileSelect's branching.
      const allIfcx = files.every(isIfcxModelFile);
      resetViewerState();
      clearAllModels();
      if (allIfcx) {
        // IFCX layers compose into one shared store — no per-file handle.
        void loadFederatedIfcx(files);
      } else {
        // Carry each file's handle so the whole federation stays refreshable.
        void loadFilesSequentially(files, opened.map(o => o.handle));
      }
    }
  }, [loadFile, loadFilesSequentially, loadFederatedIfcx, resetViewerState, clearAllModels]);

  // Refresh re-reads files from disk and re-parses them. Offered when EVERY
  // loaded model has a live FS Access handle (a single model, or a federation
  // fully opened via the picker/drag this session). Drag-drop on non-Chromium,
  // <input type="file">, cache-restored, and IFCX-composed models have no
  // handle, so a mixed session hides the button rather than risk dropping the
  // handle-less models during the rebuild.
  const canRefresh = useMemo(() => {
    if (loading || models.size === 0) return false;
    return Array.from(models.values()).every(m => m.sourceHandle);
  }, [models, loading]);

  const handleRefresh = useCallback(async () => {
    const targets = (Array.from(useViewerStore.getState().models.values()) as FederatedModel[])
      .filter((m): m is FederatedModel & { sourceHandle: FileSystemFileHandle } => Boolean(m.sourceHandle))
      .sort((a, b) => (a.loadedAt ?? 0) - (b.loadedAt ?? 0));
    if (targets.length === 0) return;

    // Re-read every handle BEFORE clearing anything, so a failed read never
    // leaves the viewer empty.
    const reads = await Promise.all(
      targets.map(async (m) => ({ model: m, fresh: await readFreshFile(m.sourceHandle) })),
    );
    const ok = reads.filter((r) => r.fresh) as { model: typeof targets[number]; fresh: File }[];
    const failedNames = reads.filter((r) => !r.fresh).map((r) => `"${r.model.name}"`);

    if (ok.length === 0) {
      toast.error(`Couldn't re-read ${failedNames.join(', ')}. Files may have moved, been deleted, or access was denied.`);
      return;
    }

    // A federation rebuild starts with clearAllModels(), so a partial read
    // would silently drop every failed model from the scene. Refuse instead:
    // the user keeps the loaded (stale) federation and gets told why.
    if (targets.length > 1 && failedNames.length > 0) {
      toast.error(`Refresh cancelled: couldn't re-read ${failedNames.join(', ')}. Keeping the loaded models.`);
      return;
    }

    recordRecentFiles(ok.map((r) => ({ name: r.fresh.name, size: r.fresh.size })));
    void cacheFileBlobs(ok.map((r) => r.fresh));

    if (targets.length === 1) {
      // Await so the success toast only fires once the reload has completed.
      await loadFile(ok[0].fresh, { kind: 'primary' }, { sourceHandle: ok[0].model.sourceHandle });
    } else {
      // Rebuild the federation from fresh bytes, preserving id + order + state.
      clearAllModels();
      for (const r of ok) {
        const reloadedId = await addModel(r.fresh, {
          name: r.model.name,
          modelId: r.model.id,
          loadedAt: r.model.loadedAt,
          visible: r.model.visible,
          collapsed: r.model.collapsed,
          sourceHandle: r.model.sourceHandle,
        });
        if (reloadedId && r.model.visible === false) {
          useViewerStore.getState().setModelVisibility(r.model.id, false);
        }
      }
    }

    // Any failed read returned early above, so reaching here means every
    // targeted model was re-read and reloaded.
    toast.success(ok.length === 1 ? `Refreshed "${ok[0].fresh.name}"` : `Refreshed ${ok.length} models`);
  }, [loadFile, addModel, clearAllModels]);

  // The command palette dispatches this (synchronously, inside the click) so the
  // toolbar's handle-capturing open path runs while user activation is still
  // live — required for the file dialog to actually open on Chrome.
  useEffect(() => {
    const handler = () => { void handleOpenClick(); };
    window.addEventListener('ifc-lite:open-files', handler);
    return () => window.removeEventListener('ifc-lite:open-files', handler);
  }, [handleOpenClick]);

  const fileInputs = (
    <>
      <input
        id="file-input-open"
        ref={fileInputRef}
        type="file"
        accept={FILE_ACCEPT}
        multiple
        onChange={handleFileSelect}
        className="hidden"
      />
      <input
        ref={addModelInputRef}
        type="file"
        accept={FILE_ACCEPT}
        multiple
        onChange={handleAddModelSelect}
        className="hidden"
      />
      {collabEnabled && <ShareDialog open={shareDialogOpen} onOpenChange={setShareDialogOpen} />}
    </>
  );

  return {
    fileInputs,
    openShareDialog,
    handleOpenClick,
    handleAddModelClick,
    handleRefresh,
    canRefresh,
    hasModelsLoaded,
  };
}
