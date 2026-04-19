/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import React, { useRef, useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  FolderOpen,
  Download,
  MousePointer2,
  PersonStanding,
  Ruler,
  Scissors,
  Eye,
  EyeOff,
  Equal,
  Crosshair,
  Home,
  Maximize2,
  Grid3x3,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Box,
  HelpCircle,
  Loader2,
  Camera,
  Info,
  Layers,
  SquareX,
  Building2,
  Plus,
  MessageSquare,
  ClipboardCheck,
  Palette,
  Orbit,
  Layout,
  LayoutTemplate,
  FileCode2,
  CalendarClock,
  Globe2,
  Settings,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from '@/components/ui/dropdown-menu';
import { Progress } from '@/components/ui/progress';
import { useViewerStore, isIfcxDataStore } from '@/store';
import { goHomeFromStore, resetVisibilityForHomeFromStore } from '@/store/homeView';
import { executeBasketIsolate } from '@/store/basket/basketCommands';
import { useIfc } from '@/hooks/useIfc';
import { cn } from '@/lib/utils';
import { GLTFExporter, CSVExporter } from '@ifc-lite/export';
import { FileSpreadsheet, FileJson, FileText, Filter, Upload, Pencil } from 'lucide-react';
import { ExportDialog } from './ExportDialog';
import { BulkPropertyEditor } from './BulkPropertyEditor';
import { DataConnector } from './DataConnector';
import { ExportChangesButton } from './ExportChangesButton';
// CesiumSettingsDialog removed — settings now shown as overlay on Cesium viewer
import { useFloorplanView } from '@/hooks/useFloorplanView';
import { buildDesktopUpgradeUrl, hasDesktopFeatureAccess, type DesktopFeature } from '@/lib/desktop-product';
import { recordRecentFiles, cacheFileBlobs } from '@/lib/recent-files';
import { ThemeSwitch } from './ThemeSwitch';
import { toast } from '@/components/ui/toast';
import { navigateToPath } from '@/services/app-navigation';
import { getStartupHarnessRequest, setActiveHarnessRequest, tryClaimStartupHarnessRequest } from '@/services/desktop-harness';
import { logToDesktopTerminal } from '@/services/desktop-logger';
import { openIfcFileDialog, type NativeFileHandle } from '@/services/file-dialog';
import { isTauri } from '@/lib/platform';
import {
  closeActiveAnalysisExtension,
  getAnalysisExtensionsSnapshot,
  openAnalysisExtension,
  subscribeAnalysisExtensions,
} from '@/services/analysis-extensions';

type Tool = 'select' | 'walk' | 'measure' | 'section';
type WorkspacePanel = 'script' | 'list' | 'bcf' | 'ids' | 'lens' | string;

function isNativeFileHandle(file: File | NativeFileHandle): file is NativeFileHandle {
  return typeof (file as NativeFileHandle).path === 'string';
}

// #region FIX: Move ToolButton OUTSIDE MainToolbar to prevent recreation on every render
// This fixes Radix UI Tooltip's asChild prop becoming stale during re-renders
interface ToolButtonProps {
  tool: Tool;
  icon: React.ElementType;
  label: string;
  shortcut?: string;
  activeTool: string;
  onToolChange: (tool: Tool) => void;
}

function ToolButton({ tool, icon: Icon, label, shortcut, activeTool, onToolChange }: ToolButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={activeTool === tool ? 'default' : 'ghost'}
          size="icon-sm"
          onClick={(e) => {
            // Blur button to close tooltip after click
            (e.currentTarget as HTMLButtonElement).blur();
            onToolChange(tool);
          }}
          className={cn(activeTool === tool && 'bg-primary text-primary-foreground')}
        >
          <Icon className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label} {shortcut && <span className="ml-2 text-xs opacity-60">({shortcut})</span>}
      </TooltipContent>
    </Tooltip>
  );
}

// #region FIX: Move ActionButton OUTSIDE MainToolbar to prevent recreation on every render
interface ActionButtonProps {
  icon: React.ElementType;
  label: string;
  onClick: () => void;
  shortcut?: string;
  disabled?: boolean;
}

function ActionButton({ icon: Icon, label, onClick, shortcut, disabled }: ActionButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={(e) => {
            // Blur button to close tooltip after click
            (e.currentTarget as HTMLButtonElement).blur();
            onClick();
          }}
          disabled={disabled}
        >
          <Icon className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label} {shortcut && <span className="ml-2 text-xs opacity-60">({shortcut})</span>}
      </TooltipContent>
    </Tooltip>
  );
}
// #endregion

interface MainToolbarProps {
  onShowShortcuts?: () => void;
}

export function MainToolbar({ onShowShortcuts }: MainToolbarProps = {} as MainToolbarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addModelInputRef = useRef<HTMLInputElement>(null);
  const {
    loadFile,
    loading,
    progress,
    geometryProgress,
    metadataProgress,
    geometryResult,
    ifcDataStore,
    models,
    clearAllModels,
    loadFilesSequentially,
    loadFederatedIfcx,
    addIfcxOverlays,
    addModel,
  } = useIfc();

  // Listen for programmatic file-load requests (from command palette recent files)
  useEffect(() => {
    const handler = (e: Event) => {
      const file = (e as CustomEvent<File | NativeFileHandle>).detail;
      if (file) {
        recordRecentFiles([isNativeFileHandle(file)
          ? { name: file.name, size: file.size, path: file.path, modifiedMs: file.modifiedMs ?? null }
          : { name: file.name, size: file.size }]);
        void loadFile(file);
      }
    };
    window.addEventListener('ifc-lite:load-file', handler);
    return () => window.removeEventListener('ifc-lite:load-file', handler);
  }, [loadFile]);

  useEffect(() => {
    let cancelled = false;
    const sleep = (ms: number) => new Promise((resolve) => globalThis.setTimeout(resolve, ms));

    const waitForViewerToSettle = async (label: string) => {
      const timeoutMs = 120_000;
      const pollMs = 100;
      const start = performance.now();
      while (!cancelled) {
        const state = useViewerStore.getState();
        const meshCount = state.geometryResult?.meshes.length ?? 0;
        if (!state.loading && meshCount > 0) {
          void logToDesktopTerminal(
            'info',
            `[DesktopHarness] ${label} settled: loading=${state.loading} meshes=${meshCount} progress=${state.progress?.phase ?? 'none'}`
          );
          return;
        }
        if (performance.now() - start >= timeoutMs) {
          throw new Error(`[DesktopHarness] Timed out waiting for ${label} to settle`);
        }
        await sleep(pollMs);
      }
    };

    void (async () => {
      void logToDesktopTerminal('info', '[DesktopHarness] MainToolbar startup harness effect running');
      const request = await getStartupHarnessRequest();
      if (!request || cancelled) {
        void logToDesktopTerminal(
          'info',
          `[DesktopHarness] No startup harness request available (cancelled=${cancelled})`
        );
        return;
      }
      if (!tryClaimStartupHarnessRequest(request)) {
        void logToDesktopTerminal('info', `[DesktopHarness] Startup harness request already claimed for ${request.file.path}`);
        return;
      }
      void logToDesktopTerminal('info', `[DesktopHarness] Claimed startup harness request for ${request.file.path}`);
      console.log(`[DesktopHarness] Auto-loading startup file: ${request.file.path}`);
      if (!request.replaceFile) {
        void logToDesktopTerminal('info', `[DesktopHarness] Calling loadFile for ${request.file.path}`);
        await loadFile(request.file);
        return;
      }

      void logToDesktopTerminal(
        'info',
        `[DesktopHarness] Running replacement sequence first=${request.file.path} second=${request.replaceFile.path}`
      );
      setActiveHarnessRequest(null);
      await loadFile(request.file);
      await waitForViewerToSettle(`first load ${request.file.name}`);
      if (cancelled) {
        return;
      }

      setActiveHarnessRequest({
        ...request,
        file: request.replaceFile,
        replaceFile: undefined,
      });
      void logToDesktopTerminal('info', `[DesktopHarness] Calling replacement loadFile for ${request.replaceFile.path}`);
      await loadFile(request.replaceFile);
    })();

    return () => {
      cancelled = true;
    };
  }, [loadFile]);

  // Floorplan view
  const { availableStoreys, activateFloorplan } = useFloorplanView();

  // Check if we have models loaded (for showing add model button)
  const hasModelsLoaded = models.size > 0 || (geometryResult?.meshes && geometryResult.meshes.length > 0);
  const activeTool = useViewerStore((state) => state.activeTool);
  const setActiveTool = useViewerStore((state) => state.setActiveTool);
  const selectedEntityId = useViewerStore((state) => state.selectedEntityId);
  const hideEntities = useViewerStore((state) => state.hideEntities);
  const error = useViewerStore((state) => state.error);
  const cameraCallbacks = useViewerStore((state) => state.cameraCallbacks);
  const hoverTooltipsEnabled = useViewerStore((state) => state.hoverTooltipsEnabled);
  const toggleHoverTooltips = useViewerStore((state) => state.toggleHoverTooltips);
  const typeVisibility = useViewerStore((state) => state.typeVisibility);
  const toggleTypeVisibility = useViewerStore((state) => state.toggleTypeVisibility);
  const resetViewerState = useViewerStore((state) => state.resetViewerState);
  const bcfPanelVisible = useViewerStore((state) => state.bcfPanelVisible);
  const setBcfPanelVisible = useViewerStore((state) => state.setBcfPanelVisible);
  const idsPanelVisible = useViewerStore((state) => state.idsPanelVisible);
  const setIdsPanelVisible = useViewerStore((state) => state.setIdsPanelVisible);
  const listPanelVisible = useViewerStore((state) => state.listPanelVisible);
  const setListPanelVisible = useViewerStore((state) => state.setListPanelVisible);
  const setRightPanelCollapsed = useViewerStore((state) => state.setRightPanelCollapsed);
  const projectionMode = useViewerStore((state) => state.projectionMode);
  const toggleProjectionMode = useViewerStore((state) => state.toggleProjectionMode);
  // Basket presentation state
  const pinboardEntities = useViewerStore((state) => state.pinboardEntities);
  const basketViewCount = useViewerStore((state) => state.basketViews.length);
  const basketPresentationVisible = useViewerStore((state) => state.basketPresentationVisible);
  const toggleBasketPresentationVisible = useViewerStore((state) => state.toggleBasketPresentationVisible);
  // Lens state
  const lensPanelVisible = useViewerStore((state) => state.lensPanelVisible);
  const setLensPanelVisible = useViewerStore((state) => state.setLensPanelVisible);
  const scriptPanelVisible = useViewerStore((state) => state.scriptPanelVisible);
  const setScriptPanelVisible = useViewerStore((state) => state.setScriptPanelVisible);
  const ganttPanelVisible = useViewerStore((state) => state.ganttPanelVisible);
  const setGanttPanelVisible = useViewerStore((state) => state.setGanttPanelVisible);
  // Cesium 3D overlay state
  const cesiumAvailable = useViewerStore((state) => state.cesiumAvailable);
  const cesiumEnabled = useViewerStore((state) => state.cesiumEnabled);
  const toggleCesium = useViewerStore((state) => state.toggleCesium);
  const storeModels = useViewerStore((state) => state.models);
  const desktopEntitlement = useViewerStore((state) => state.desktopEntitlement);
  const analysisExtensionState = useSyncExternalStore(
    subscribeAnalysisExtensions,
    getAnalysisExtensionsSnapshot,
    getAnalysisExtensionsSnapshot,
  );
  const activeAnalysisExtension = useMemo(
    () => analysisExtensionState.extensions.find((extension) => extension.id === analysisExtensionState.activeId) ?? null,
    [analysisExtensionState.activeId, analysisExtensionState.extensions],
  );
  const rightAnalysisExtensions = useMemo(
    () => analysisExtensionState.extensions.filter((extension) => (extension.placement ?? 'right') === 'right'),
    [analysisExtensionState.extensions],
  );
  const bottomAnalysisExtensions = useMemo(
    () => analysisExtensionState.extensions.filter((extension) => (extension.placement ?? 'right') === 'bottom'),
    [analysisExtensionState.extensions],
  );
  const desktopShell = isTauri();

  // Check which type geometries exist across ALL loaded models (federation-aware).
  // PERF: Use meshes.length as dep proxy instead of full geometryResult, and
  // scan incrementally — once a type is found it stays found, so we only scan
  // NEW meshes since the last check. Per-model cursors ensure federated models
  // each track their own scan position independently.
  const typeGeomScanRef = useRef({
    spaces: false, openings: false, site: false,
    legacyLastLen: 0,
    modelLastLen: new Map<string | number, number>(),
  });
  const meshLen = geometryResult?.meshes.length ?? 0;
  const typeGeometryExists = useMemo(() => {
    const scan = typeGeomScanRef.current;

    // Reset if legacy meshes array shrunk (new file loaded)
    if (meshLen < scan.legacyLastLen) {
      scan.spaces = false;
      scan.openings = false;
      scan.site = false;
      scan.legacyLastLen = 0;
      scan.modelLastLen.clear();
    }

    // Already found all types — nothing to do
    if (scan.spaces && scan.openings && scan.site) {
      return { spaces: scan.spaces, openings: scan.openings, site: scan.site };
    }

    // Check federated models (scan only new meshes per model)
    if (models.size > 0) {
      for (const [modelId, model] of models) {
        const meshes = model.geometryResult?.meshes;
        if (!meshes) continue;
        const modelStart = scan.modelLastLen.get(modelId) ?? 0;
        // Reset cursor if model was reloaded (mesh array shrunk)
        const start = meshes.length < modelStart ? 0 : modelStart;
        for (let i = start; i < meshes.length; i++) {
          const t = meshes[i].ifcType;
          if (t === 'IfcSpace') scan.spaces = true;
          else if (t === 'IfcOpeningElement') scan.openings = true;
          else if (t === 'IfcSite') scan.site = true;
          if (scan.spaces && scan.openings && scan.site) break;
        }
        scan.modelLastLen.set(modelId, meshes.length);
        if (scan.spaces && scan.openings && scan.site) break;
      }
    }

    // Legacy single-model path (scan only new meshes)
    if (geometryResult?.meshes) {
      const meshes = geometryResult.meshes;
      for (let i = scan.legacyLastLen; i < meshes.length; i++) {
        const t = meshes[i].ifcType;
        if (t === 'IfcSpace') scan.spaces = true;
        else if (t === 'IfcOpeningElement') scan.openings = true;
        else if (t === 'IfcSite') scan.site = true;
        if (scan.spaces && scan.openings && scan.site) break;
      }
    }

    scan.legacyLastLen = meshLen;
    return { spaces: scan.spaces, openings: scan.openings, site: scan.site };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- meshLen is a stable proxy for geometryResult
  }, [models, meshLen]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    // Filter to supported files (IFC, IFCX, GLB)
    const supportedFiles = Array.from(files).filter(
      f => f.name.endsWith('.ifc') || f.name.endsWith('.ifcx') || f.name.endsWith('.glb')
    );

    if (supportedFiles.length === 0) return;

    // Track recently opened files (metadata + blob cache for instant reload)
    recordRecentFiles(supportedFiles.map(f => ({ name: f.name, size: f.size })));
    cacheFileBlobs(supportedFiles);

    if (supportedFiles.length === 1) {
      // Single file - use loadFile (simpler single-model path)
      loadFile(supportedFiles[0]);
    } else {
      // Multiple files - check if ALL are IFCX (use federated loading for layer composition)
      const allIfcx = supportedFiles.every(f => f.name.endsWith('.ifcx'));

      resetViewerState();
      clearAllModels();

      if (allIfcx) {
        // IFCX files use federated loading (layer composition - later files override earlier ones)
        // This handles overlay files that add properties without geometry
        console.log(`[MainToolbar] Loading ${supportedFiles.length} IFCX files with federated composition`);
        loadFederatedIfcx(supportedFiles);
      } else {
        // Mixed or all IFC4/GLB files - load sequentially as independent models
        loadFilesSequentially(supportedFiles);
      }
    }

    // Reset input so same files can be selected again
    e.target.value = '';
  }, [loadFile, loadFilesSequentially, loadFederatedIfcx, resetViewerState, clearAllModels]);

  const handleAddModelSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    // Filter to supported files (IFC, IFCX, GLB)
    const supportedFiles = Array.from(files).filter(
      f => f.name.endsWith('.ifc') || f.name.endsWith('.ifcx') || f.name.endsWith('.glb')
    );

    if (supportedFiles.length === 0) return;

    // Check if adding IFCX files
    const newFilesAreIfcx = supportedFiles.every(f => f.name.endsWith('.ifcx'));
    const existingIsIfcx = isIfcxDataStore(ifcDataStore);

    if (newFilesAreIfcx && existingIsIfcx) {
      // Adding IFCX overlay(s) to existing IFCX model - re-compose with new layers
      console.log(`[MainToolbar] Adding ${supportedFiles.length} IFCX overlay(s) to existing IFCX model - re-composing`);
      addIfcxOverlays(supportedFiles);
    } else if (newFilesAreIfcx && !existingIsIfcx && ifcDataStore) {
      // User trying to add IFCX to IFC4 model - won't work
      console.warn('[MainToolbar] Cannot add IFCX files to non-IFCX model');
      alert(`IFCX overlay files cannot be added to IFC4 models.\n\nPlease load IFCX files separately.`);
    } else {
      // Standard case - add as independent models (IFC4, GLB, or mixed)
      loadFilesSequentially(supportedFiles);
    }

    // Reset input so same files can be selected again
    e.target.value = '';
  }, [loadFilesSequentially, addIfcxOverlays, ifcDataStore]);

  const hasSelection = selectedEntityId !== null;

  const clearSelection = useViewerStore((state) => state.clearSelection);

  const handleHide = useCallback(() => {
    // Hide ALL selected entities (multi-select or single)
    const state = useViewerStore.getState();
    const ids: number[] = state.selectedEntityIds.size > 0
      ? Array.from(state.selectedEntityIds)
      : selectedEntityId !== null ? [selectedEntityId] : [];
    if (ids.length > 0) {
      hideEntities(ids);
      clearSelection();
    }
  }, [selectedEntityId, hideEntities, clearSelection]);

  const handleShowAll = useCallback(() => {
    resetVisibilityForHomeFromStore();
  }, []);

  const handleIsolate = useCallback(() => {
    executeBasketIsolate();
  }, []);

  const handleHome = useCallback(() => {
    goHomeFromStore();
  }, []);

  const promptDesktopUpgrade = useCallback((featureLabel: string) => {
    toast.info(`${featureLabel} is available with Desktop Pro`);
    navigateToPath(buildDesktopUpgradeUrl());
  }, []);

  const requireDesktopFeature = useCallback((feature: DesktopFeature, label: string) => {
    if (hasDesktopFeatureAccess(desktopEntitlement, feature)) {
      return true;
    }
    promptDesktopUpgrade(label);
    return false;
  }, [desktopEntitlement, promptDesktopUpgrade]);

  const handleToggleBottomPanel = useCallback((panel: 'script' | 'list' | 'gantt') => {
    if (activeAnalysisExtension?.placement === 'bottom') {
      closeActiveAnalysisExtension();
    }
    const nextScriptVisible = panel === 'script' ? !scriptPanelVisible : false;
    const nextListVisible = panel === 'list' ? !listPanelVisible : false;
    const nextGanttVisible = panel === 'gantt' ? !ganttPanelVisible : false;

    setScriptPanelVisible(nextScriptVisible);
    setListPanelVisible(nextListVisible);
    setGanttPanelVisible(nextGanttVisible);

    if (nextScriptVisible || nextListVisible || nextGanttVisible) {
      setRightPanelCollapsed(false);
    }
  }, [
    activeAnalysisExtension?.placement,
    ganttPanelVisible,
    listPanelVisible,
    scriptPanelVisible,
    setGanttPanelVisible,
    setListPanelVisible,
    setRightPanelCollapsed,
    setScriptPanelVisible,
  ]);

  const handleToggleRightPanel = useCallback((panel: 'bcf' | 'ids' | 'lens') => {
    if (activeAnalysisExtension?.placement !== 'bottom') {
      closeActiveAnalysisExtension();
    }
    if (panel === 'bcf' && !requireDesktopFeature('bcf_issue_management', 'BCF issue management')) {
      return;
    }
    if (panel === 'ids' && !requireDesktopFeature('ids_validation', 'IDS validation')) {
      return;
    }

    const nextBcfVisible = panel === 'bcf' ? !bcfPanelVisible : false;
    const nextIdsVisible = panel === 'ids' ? !idsPanelVisible : false;
    const nextLensVisible = panel === 'lens' ? !lensPanelVisible : false;

    setBcfPanelVisible(nextBcfVisible);
    setIdsPanelVisible(nextIdsVisible);
    setLensPanelVisible(nextLensVisible);

    if (nextBcfVisible || nextIdsVisible || nextLensVisible) {
      setRightPanelCollapsed(false);
    }
  }, [
    activeAnalysisExtension?.placement,
    bcfPanelVisible,
    idsPanelVisible,
    lensPanelVisible,
    requireDesktopFeature,
    setBcfPanelVisible,
    setIdsPanelVisible,
    setLensPanelVisible,
    setRightPanelCollapsed,
  ]);

  const handleToggleAnalysisExtension = useCallback((id: string) => {
    const extension = analysisExtensionState.extensions.find((candidate) => candidate.id === id);
    if (!extension) {
      return;
    }

    if (analysisExtensionState.activeId === id) {
      closeActiveAnalysisExtension();
      return;
    }

    const opened = openAnalysisExtension(id);
    if (!opened) {
      return;
    }

    if ((extension.placement ?? 'right') === 'bottom') {
      setScriptPanelVisible(false);
      setListPanelVisible(false);
      setGanttPanelVisible(false);
      setRightPanelCollapsed(false);
      return;
    }

    setBcfPanelVisible(false);
    setIdsPanelVisible(false);
    setLensPanelVisible(false);
    setRightPanelCollapsed(false);
  }, [
    analysisExtensionState.activeId,
    analysisExtensionState.extensions,
    setBcfPanelVisible,
    setGanttPanelVisible,
    setIdsPanelVisible,
    setLensPanelVisible,
    setListPanelVisible,
    setRightPanelCollapsed,
    setScriptPanelVisible,
  ]);

  const activeWorkspacePanels = useMemo(() => {
    const panels = new Set<WorkspacePanel>();
    if (scriptPanelVisible) panels.add('script');
    if (listPanelVisible) panels.add('list');
    if (ganttPanelVisible) panels.add('gantt');
    if (bcfPanelVisible) panels.add('bcf');
    if (idsPanelVisible) panels.add('ids');
    if (lensPanelVisible) panels.add('lens');
    if (analysisExtensionState.activeId) panels.add(analysisExtensionState.activeId);
    return panels;
  }, [
    analysisExtensionState.activeId,
    bcfPanelVisible,
    ganttPanelVisible,
    idsPanelVisible,
    lensPanelVisible,
    listPanelVisible,
    scriptPanelVisible,
  ]);

  const workspacePanelLabel = useMemo(() => {
    if (activeWorkspacePanels.size === 0) return null;
    if (activeWorkspacePanels.size > 1) return 'Multiple Panels';
    if (activeWorkspacePanels.has('script')) return 'Script Editor';
    if (activeWorkspacePanels.has('list')) return 'Lists';
    if (activeWorkspacePanels.has('gantt')) return 'Schedule';
    if (activeWorkspacePanels.has('bcf')) return 'BCF Issues';
    if (activeWorkspacePanels.has('ids')) return 'IDS Validation';
    if (activeWorkspacePanels.has('lens')) return 'Lens Rules';
    return activeAnalysisExtension?.label ?? 'Analysis';
  }, [activeAnalysisExtension?.label, activeWorkspacePanels]);

  const handleExportGLB = useCallback(() => {
    if (!requireDesktopFeature('exports', 'Exports')) return;
    if (!geometryResult) return;
    try {
      const exporter = new GLTFExporter(geometryResult);
      const glb = exporter.exportGLB({ includeMetadata: true });
      const blob = new Blob([new Uint8Array(glb)], { type: 'model/gltf-binary' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'model.glb';
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported GLB (${(blob.size / 1024).toFixed(0)} KB)`);
    } catch (err) {
      console.error('Export failed:', err);
      toast.error(`GLB export failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, [geometryResult, requireDesktopFeature]);

  const handleScreenshot = useCallback(() => {
    if (!requireDesktopFeature('exports', 'Exports')) return;
    const canvas = document.querySelector('canvas');
    if (!canvas) return;
    try {
      const dataUrl = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = 'screenshot.png';
      a.click();
      toast.success('Screenshot saved');
    } catch (err) {
      console.error('Screenshot failed:', err);
      toast.error('Screenshot failed');
    }
  }, [requireDesktopFeature]);

  const handleExportCSV = useCallback((type: 'entities' | 'properties' | 'quantities' | 'spatial') => {
    if (!requireDesktopFeature('exports', 'Exports')) return;
    if (!ifcDataStore) return;
    try {
      const exporter = new CSVExporter(ifcDataStore);
      let csv: string;
      let filename: string;

      switch (type) {
        case 'entities':
          csv = exporter.exportEntities(undefined, { includeProperties: true, flattenProperties: true });
          filename = 'entities.csv';
          break;
        case 'properties':
          csv = exporter.exportProperties();
          filename = 'properties.csv';
          break;
        case 'quantities':
          csv = exporter.exportQuantities();
          filename = 'quantities.csv';
          break;
        case 'spatial':
          csv = exporter.exportSpatialHierarchy();
          filename = 'spatial-hierarchy.csv';
          break;
      }

      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${type} CSV`);
    } catch (err) {
      console.error('CSV export failed:', err);
      toast.error(`CSV export failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, [ifcDataStore, requireDesktopFeature]);

  const handleExportJSON = useCallback(() => {
    if (!requireDesktopFeature('exports', 'Exports')) return;
    if (!ifcDataStore) return;
    try {
      const entities: Record<string, unknown>[] = [];
      for (let i = 0; i < ifcDataStore.entities.count; i++) {
        const id = ifcDataStore.entities.expressId[i];
        entities.push({
          expressId: id,
          globalId: ifcDataStore.entities.getGlobalId(id),
          name: ifcDataStore.entities.getName(id),
          type: ifcDataStore.entities.getTypeName(id),
          properties: ifcDataStore.properties.getForEntity(id),
        });
      }

      const json = JSON.stringify({ entities }, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'model-data.json';
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${entities.length} entities as JSON`);
    } catch (err) {
      console.error('JSON export failed:', err);
      toast.error(`JSON export failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, [ifcDataStore, requireDesktopFeature]);

  return (
    <div className="flex items-center gap-1 px-2 h-12 border-b bg-white dark:bg-black border-zinc-200 dark:border-zinc-800 relative z-50">
      {/* ── File Operations ── */}
      <input
        id="file-input-open"
        ref={fileInputRef}
        type="file"
        accept=".ifc,.ifcx,.glb"
        multiple
        onChange={handleFileSelect}
        className="hidden"
      />
      <input
        ref={addModelInputRef}
        type="file"
        accept=".ifc,.ifcx,.glb"
        multiple
        onChange={handleAddModelSelect}
        className="hidden"
      />

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={async (e) => {
              // Blur button to close tooltip before opening file dialog
              (e.currentTarget as HTMLButtonElement).blur();

              void logToDesktopTerminal('info', '[MainToolbar] Open file button clicked');
              const file = await openIfcFileDialog();
              if (file) {
                void logToDesktopTerminal('info', `[MainToolbar] Native dialog selected ${file.path}`);
                recordRecentFiles([{
                  name: file.name,
                  size: file.size,
                  path: file.path,
                  modifiedMs: file.modifiedMs ?? null,
                }]);
                void loadFile(file);
                return;
              }

              void logToDesktopTerminal('info', '[MainToolbar] Falling back to browser file input');
              fileInputRef.current?.click();
            }}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FolderOpen className="h-4 w-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>Open IFC File</TooltipContent>
      </Tooltip>

      {/* Add Model button - only shown when models are loaded */}
      {hasModelsLoaded && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={(e) => {
                (e.currentTarget as HTMLButtonElement).blur();
                addModelInputRef.current?.click();
              }}
              disabled={loading}
              className="text-[#9ece6a] hover:text-[#9ece6a] hover:bg-[#9ece6a]/10"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Add Model to Scene (Multi-select supported)</TooltipContent>
        </Tooltip>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" disabled={!geometryResult}>
            <Download className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {hasDesktopFeatureAccess(desktopEntitlement, 'exports') ? (
            <ExportDialog
              trigger={
                <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                  <FileText className="h-4 w-4 mr-2" />
                  Export IFC (with changes)
                </DropdownMenuItem>
              }
            />
          ) : (
            <DropdownMenuItem onClick={() => promptDesktopUpgrade('Exports')}>
              <FileText className="h-4 w-4 mr-2" />
              Export IFC (with changes)
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleExportGLB}>
            <Download className="h-4 w-4 mr-2" />
            Export GLB (3D Model)
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={!ifcDataStore}>
              <FileSpreadsheet className="h-4 w-4 mr-2" />
              Export CSV
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onClick={() => handleExportCSV('entities')}>
                <FileSpreadsheet className="h-4 w-4 mr-2" />
                Entities
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExportCSV('properties')}>
                <FileSpreadsheet className="h-4 w-4 mr-2" />
                Properties
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExportCSV('quantities')}>
                <FileSpreadsheet className="h-4 w-4 mr-2" />
                Quantities
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => handleExportCSV('spatial')}>
                <FileSpreadsheet className="h-4 w-4 mr-2" />
                Spatial Hierarchy
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem onClick={handleExportJSON} disabled={!ifcDataStore}>
            <FileJson className="h-4 w-4 mr-2" />
            Export JSON (All Data)
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleScreenshot}>
            <Camera className="h-4 w-4 mr-2" />
            Screenshot
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Edit Menu - Bulk editing and data import */}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" disabled={!ifcDataStore}>
                <Pencil className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>Edit Properties</TooltipContent>
        </Tooltip>
        <DropdownMenuContent>
          <BulkPropertyEditor
            trigger={
              <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                <Filter className="h-4 w-4 mr-2" />
                Bulk Property Editor
              </DropdownMenuItem>
            }
          />
          <DataConnector
            trigger={
              <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                <Upload className="h-4 w-4 mr-2" />
                Import Data (CSV)
              </DropdownMenuItem>
            }
          />
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Export Changes Button - shows when there are pending mutations */}
      {hasDesktopFeatureAccess(desktopEntitlement, 'exports') ? (
        <ExportChangesButton />
      ) : null}

      {/* ── Panels ── */}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant={activeWorkspacePanels.size > 0 ? 'default' : 'ghost'}
                size="icon-sm"
                aria-label={workspacePanelLabel ? `Panels: ${workspacePanelLabel}` : 'Panels'}
                className={cn(activeWorkspacePanels.size > 0 && 'bg-primary text-primary-foreground')}
              >
                <Layout className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{workspacePanelLabel ? `Panels: ${workspacePanelLabel}` : 'Panels'}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuCheckboxItem
            checked={activeWorkspacePanels.has('script')}
            onCheckedChange={() => handleToggleBottomPanel('script')}
          >
            <FileCode2 className="h-4 w-4 mr-2" />
            Script Editor
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={activeWorkspacePanels.has('list')}
            onCheckedChange={() => handleToggleBottomPanel('list')}
          >
            <FileSpreadsheet className="h-4 w-4 mr-2" />
            Lists
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={activeWorkspacePanels.has('gantt')}
            onCheckedChange={() => handleToggleBottomPanel('gantt')}
          >
            <CalendarClock className="h-4 w-4 mr-2" />
            Schedule (Gantt)
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            checked={activeWorkspacePanels.has('bcf')}
            onCheckedChange={() => handleToggleRightPanel('bcf')}
          >
            <MessageSquare className="h-4 w-4 mr-2" />
            BCF Issues
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={activeWorkspacePanels.has('ids')}
            onCheckedChange={() => handleToggleRightPanel('ids')}
          >
            <ClipboardCheck className="h-4 w-4 mr-2" />
            IDS Validation
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={activeWorkspacePanels.has('lens')}
            onCheckedChange={() => handleToggleRightPanel('lens')}
          >
            <Palette className="h-4 w-4 mr-2" />
            Lens Rules
          </DropdownMenuCheckboxItem>
          {rightAnalysisExtensions.length > 0 && (
            <>
              <DropdownMenuSeparator />
              {rightAnalysisExtensions.map((extension) => {
                const Icon = extension.icon;
                return (
                  <DropdownMenuCheckboxItem
                    key={extension.id}
                    checked={activeWorkspacePanels.has(extension.id)}
                    onCheckedChange={() => handleToggleAnalysisExtension(extension.id)}
                  >
                    <Icon className="h-4 w-4 mr-2" />
                    {extension.label}
                  </DropdownMenuCheckboxItem>
                );
              })}
            </>
          )}
          {bottomAnalysisExtensions.length > 0 && (
            <>
              <DropdownMenuSeparator />
              {bottomAnalysisExtensions.map((extension) => {
                const Icon = extension.icon;
                return (
                  <DropdownMenuCheckboxItem
                    key={extension.id}
                    checked={activeWorkspacePanels.has(extension.id)}
                    onCheckedChange={() => handleToggleAnalysisExtension(extension.id)}
                  >
                    <Icon className="h-4 w-4 mr-2" />
                    {extension.label}
                  </DropdownMenuCheckboxItem>
                );
              })}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Separator orientation="vertical" className="h-6 mx-1" />

      {/* ── Navigation Tools ── */}
      <ToolButton tool="select" icon={MousePointer2} label="Select" shortcut="V" activeTool={activeTool} onToolChange={setActiveTool} />
      <ToolButton tool="walk" icon={PersonStanding} label="Walk Mode" shortcut="C" activeTool={activeTool} onToolChange={setActiveTool} />

      <Separator orientation="vertical" className="h-6 mx-1" />

      {/* ── Measurement & Section ── */}
      <ToolButton tool="measure" icon={Ruler} label="Measure" shortcut="M" activeTool={activeTool} onToolChange={setActiveTool} />
      <ToolButton tool="section" icon={Scissors} label="Section" shortcut="X" activeTool={activeTool} onToolChange={setActiveTool} />

      {/* Floorplan dropdown */}
      {availableStoreys.length > 0 && (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm">
                  <Building2 className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Quick Floorplan</TooltipContent>
          </Tooltip>
          <DropdownMenuContent>
            {availableStoreys.map((storey) => (
              <DropdownMenuItem
                key={`${storey.modelId}-${storey.expressId}`}
                onClick={() => activateFloorplan(storey)}
              >
                <Building2 className="h-4 w-4 mr-2" />
                {storey.name}
                <span className="ml-auto text-xs opacity-60">{storey.elevation.toFixed(1)}m</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <Separator orientation="vertical" className="h-6 mx-1" />

      {/* ── Basket Presentation ── */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={basketPresentationVisible ? 'default' : 'ghost'}
            size="icon-sm"
            onClick={(e) => {
              (e.currentTarget as HTMLButtonElement).blur();
              toggleBasketPresentationVisible();
            }}
            disabled={models.size === 0 && !geometryResult}
            className={cn(
              (basketPresentationVisible || pinboardEntities.size > 0) && 'relative',
            )}
          >
            <LayoutTemplate className="h-4 w-4" />
            {(basketViewCount > 0 || pinboardEntities.size > 0) && (
              <span className="absolute -top-1 -right-1 bg-primary text-primary-foreground text-[9px] font-bold rounded-full min-w-[14px] h-[14px] flex items-center justify-center px-0.5 border border-background">
                {basketViewCount > 0 ? `${basketViewCount}/${pinboardEntities.size}` : pinboardEntities.size}
              </span>
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          Basket Presentation Dock (Views: {basketViewCount}, Entities: {pinboardEntities.size})
        </TooltipContent>
      </Tooltip>

      <ActionButton icon={Equal} label="Isolate (Set Basket)" onClick={handleIsolate} shortcut="I / =" />
      <ActionButton icon={EyeOff} label="Hide Selection" onClick={handleHide} shortcut="Del / Space" disabled={!hasSelection} />
      <ActionButton icon={Eye} label="Show All (Reset Filters)" onClick={handleShowAll} shortcut="A" />
      <ActionButton icon={Maximize2} label="Fit All" onClick={() => cameraCallbacks.fitAll?.()} shortcut="Z" />
      <ActionButton
        icon={Crosshair}
        label="Frame Selection"
        onClick={() => cameraCallbacks.frameSelection?.()}
        shortcut="F"
        disabled={!hasSelection}
      />

      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" disabled={!geometryResult && models.size === 0}>
                <Layers className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>Class Visibility</TooltipContent>
        </Tooltip>
        <DropdownMenuContent>
          {typeGeometryExists.spaces && (
            <DropdownMenuCheckboxItem
              checked={typeVisibility.spaces}
              onCheckedChange={() => toggleTypeVisibility('spaces')}
            >
              <Box className="h-4 w-4 mr-2" style={{ color: '#33d9ff' }} />
              Show Spaces
            </DropdownMenuCheckboxItem>
          )}
          {typeGeometryExists.openings && (
            <DropdownMenuCheckboxItem
              checked={typeVisibility.openings}
              onCheckedChange={() => toggleTypeVisibility('openings')}
            >
              <SquareX className="h-4 w-4 mr-2" style={{ color: '#ff6b4a' }} />
              Show Openings
            </DropdownMenuCheckboxItem>
          )}
          {typeGeometryExists.site && (
            <DropdownMenuCheckboxItem
              checked={typeVisibility.site}
              onCheckedChange={() => toggleTypeVisibility('site')}
            >
              <Building2 className="h-4 w-4 mr-2" style={{ color: '#66cc4d' }} />
              Show Site
            </DropdownMenuCheckboxItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Separator orientation="vertical" className="h-6 mx-1" />

      {/* ── Camera & View ── */}
      <ActionButton icon={Home} label="Home (Isometric + Reset Visibility)" onClick={handleHome} shortcut="H" />

      {/* Orthographic / Perspective toggle */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={projectionMode === 'orthographic' ? 'default' : 'ghost'}
            size="icon-sm"
            onClick={(e) => {
              (e.currentTarget as HTMLButtonElement).blur();
              toggleProjectionMode();
            }}
            className={cn(projectionMode === 'orthographic' && 'bg-primary text-primary-foreground')}
          >
            <Orbit className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {projectionMode === 'orthographic' ? 'Switch to Perspective' : 'Switch to Orthographic'}
        </TooltipContent>
      </Tooltip>

      {/* Cesium 3D Context toggle + settings — web only, only when model has georeferencing */}
      {cesiumAvailable && !desktopShell && (
        <div className="flex items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={cesiumEnabled ? 'default' : 'ghost'}
                size="icon-sm"
                aria-label={cesiumEnabled ? 'Hide 3D World Context (Cesium)' : 'Show 3D World Context (Cesium)'}
                aria-pressed={cesiumEnabled}
                onClick={(e) => {
                  (e.currentTarget as HTMLButtonElement).blur();
                  toggleCesium();
                }}
                className={cn(cesiumEnabled && 'bg-teal-600 text-white hover:bg-teal-700')}
              >
                <Globe2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {cesiumEnabled ? 'Hide' : 'Show'} 3D World Context (Cesium)
            </TooltipContent>
          </Tooltip>
        </div>
      )}

      {/* Hover Tooltips toggle */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={hoverTooltipsEnabled ? 'default' : 'ghost'}
            size="icon-sm"
            onClick={(e) => {
              (e.currentTarget as HTMLButtonElement).blur();
              toggleHoverTooltips();
            }}
            className={cn(hoverTooltipsEnabled && 'bg-primary text-primary-foreground')}
          >
            <Info className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {hoverTooltipsEnabled ? 'Disable' : 'Enable'} Hover Tooltips
        </TooltipContent>
      </Tooltip>

      {/* Preset Views dropdown */}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm">
                <Grid3x3 className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>Preset Views</TooltipContent>
        </Tooltip>
        <DropdownMenuContent>
          <DropdownMenuItem onClick={handleHome}>
            <Box className="h-4 w-4 mr-2" /> Isometric <span className="ml-auto text-xs opacity-60">H</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => cameraCallbacks.setPresetView?.('top')}>
            <ArrowUp className="h-4 w-4 mr-2" /> Top <span className="ml-auto text-xs opacity-60">1</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => cameraCallbacks.setPresetView?.('bottom')}>
            <ArrowDown className="h-4 w-4 mr-2" /> Bottom <span className="ml-auto text-xs opacity-60">2</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => cameraCallbacks.setPresetView?.('front')}>
            <ArrowRight className="h-4 w-4 mr-2" /> Front <span className="ml-auto text-xs opacity-60">3</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => cameraCallbacks.setPresetView?.('back')}>
            <ArrowLeft className="h-4 w-4 mr-2" /> Back <span className="ml-auto text-xs opacity-60">4</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => cameraCallbacks.setPresetView?.('left')}>
            <ArrowLeft className="h-4 w-4 mr-2" /> Left <span className="ml-auto text-xs opacity-60">5</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => cameraCallbacks.setPresetView?.('right')}>
            <ArrowRight className="h-4 w-4 mr-2" /> Right <span className="ml-auto text-xs opacity-60">6</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Loading Progress */}
      {loading && (geometryProgress || metadataProgress || progress) && (
        <div className="flex items-center gap-2 mr-4">
          <span className="text-xs text-muted-foreground">
            {(geometryProgress ?? metadataProgress ?? progress)?.phase}
            {geometryProgress && metadataProgress ? ` | ${metadataProgress.phase}` : ''}
          </span>
          {(geometryProgress ?? metadataProgress ?? progress)?.indeterminate ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          ) : (
            <>
              <Progress value={(geometryProgress ?? metadataProgress ?? progress)?.percent ?? 0} className="w-32 h-2" />
              <span className="text-xs text-muted-foreground">
                {Math.round((geometryProgress ?? metadataProgress ?? progress)?.percent ?? 0)}%
              </span>
            </>
          )}
        </div>
      )}

      {/* Error Display */}
      {error && (
        <span className="text-xs text-destructive mr-4">{error}</span>
      )}

      {/* Right Side Actions */}
      <div className="flex items-center gap-2 ml-2 pl-2 border-l border-zinc-200 dark:border-zinc-700/60">
        {desktopShell ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="rounded-full"
                onClick={() => navigateToPath('/settings')}
              >
                <Settings className="!h-[20px] !w-[20px]" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Settings</TooltipContent>
          </Tooltip>
        ) : null}

        <Tooltip>
          <TooltipTrigger asChild>
            <div>
              <ThemeSwitch />
            </div>
          </TooltipTrigger>
          <TooltipContent>Toggle theme (Shift+click for secret mode)</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="rounded-full"
              onClick={() => onShowShortcuts?.()}
            >
              <HelpCircle className="!h-[22px] !w-[22px]" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Info (?)</TooltipContent>
        </Tooltip>
      </div>

    </div>
  );
}
