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
  StickyNote,
  Eye,
  EyeOff,
  Equal,
  Crosshair,
  GitCompareArrows,
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
  Layers2,
  Zap,
  SquareX,
  BoxSelect,
  Building2,
  Plus,
  PackagePlus,
  MessageSquare,
  ClipboardCheck,
  Puzzle,
  Palette,
  Orbit,
  Layout,
  LayoutTemplate,
  FileCode2,
  CalendarClock,
  Globe2,
  Sun,
  Move,
  PenLine,
  Undo2,
  Redo2,
  Boxes,
  Shapes,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from '@/components/ui/dropdown-menu';
import { Progress } from '@/components/ui/progress';
import { useViewerStore, isIfcxDataStore, type FederatedModel } from '@/store';
import { goHomeFromStore, resetVisibilityForHomeFromStore } from '@/store/homeView';
import { executeBasketIsolate } from '@/store/basket/basketCommands';
import { useIfc } from '@/hooks/useIfc';
import { cn } from '@/lib/utils';
import { exportCsvFromBytes } from '@/lib/export/csv';
import { downloadFile, downloadDataUrl } from '@/lib/export/download';
import { FileSpreadsheet, FileJson, FileText, Filter, Upload, Pencil, DraftingCompass } from 'lucide-react';
import { ExportDialog } from './ExportDialog';
import { GLBExportDialog } from './GLBExportDialog';
import { KmzExportDialog } from './KmzExportDialog';
import { HbjsonExportDialog } from './HbjsonExportDialog';
import { BulkPropertyEditor } from './BulkPropertyEditor';
import { DataConnector } from './DataConnector';
import { ExportChangesButton } from './ExportChangesButton';
import { SearchInline } from './SearchInline';
import { recordRecentFiles, cacheFileBlobs } from '@/lib/recent-files';
import {
  supportsFileSystemAccess,
  openIfcFilesWithHandles,
  readFreshFile,
} from '@/services/file-system-access';
import { ThemeSwitch } from './ThemeSwitch';
import { ExtensionToolbarSlot } from '@/components/extensions/ExtensionToolbarSlot';
import { toast } from '@/components/ui/toast';
import {
  closeActiveAnalysisExtension,
  getAnalysisExtensionsSnapshot,
  openAnalysisExtension,
  subscribeAnalysisExtensions,
} from '@/services/analysis-extensions';
import { closePanelWindow } from '@/services/panel-windows';
import { tourAnchor, toolAnchor } from '@/lib/tours/anchors';

type Tool = 'select' | 'walk' | 'measure' | 'section' | 'annotate' | 'addElement' | 'split' | 'spaceSketch';
type WorkspacePanel = 'script' | 'list' | 'bcf' | 'ids' | 'lens' | 'addElement' | string;

// #region FIX: Move ToolButton OUTSIDE MainToolbar to prevent recreation on every render
// This fixes Radix UI Tooltip's asChild prop becoming stale during re-renders
interface ToolButtonProps {
  tool: Tool;
  icon: React.ElementType;
  label: string;
  shortcut?: string;
  activeTool: string;
  onToolChange: (tool: Tool) => void;
  /**
   * Tailwind classes applied when this tool is active. Defaults to the
   * shared `bg-primary text-primary-foreground` shape; pass a per-tool
   * accent (e.g. amber for Annotate) to set tools apart visually
   * without breaking the toolbar's tool-button rhythm.
   */
  activeAccentClass?: string;
}

function ToolButton({
  tool,
  icon: Icon,
  label,
  shortcut,
  activeTool,
  onToolChange,
  activeAccentClass,
}: ToolButtonProps) {
  const isActive = activeTool === tool;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={isActive ? 'default' : 'ghost'}
          size="icon-sm"
          aria-label={label}
          aria-pressed={isActive}
          onClick={(e) => {
            // Blur button to close tooltip after click
            (e.currentTarget as HTMLButtonElement).blur();
            onToolChange(tool);
          }}
          className={cn(
            isActive && (activeAccentClass ?? 'bg-primary text-primary-foreground'),
          )}
          {...tourAnchor(toolAnchor(tool))}
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

interface ClassVisibilityRowProps {
  /** Colored class glyph (caller sets the tint). */
  icon: React.ReactNode;
  label: string;
  /** One-line plain-language hint about what the IFC class covers. */
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}

/**
 * One row of the Visibility panel: colored class icon + label/description
 * on the left, a Switch on the right. The whole row is a <label>, so a
 * click anywhere toggles the switch and — because it isn't a menu item —
 * the dropdown stays open for flipping several classes in a row. The left
 * cluster dims when off so on/off reads from saturation as well as the
 * switch position.
 */
function ClassVisibilityRow({ icon, label, description, checked, onChange }: ClassVisibilityRowProps) {
  return (
    <label className="group flex items-center justify-between gap-3 rounded-md px-2 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors">
      <span className={cn('flex items-center gap-2.5 min-w-0 transition-opacity', !checked && 'opacity-50')}>
        {icon}
        <span className="grid gap-0.5 min-w-0">
          <span className="text-sm leading-tight truncate">{label}</span>
          <span className="text-[10px] leading-tight text-muted-foreground truncate">{description}</span>
        </span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

/**
 * Toolbar pair for Undo / Redo. Drives `MutationSlice.undo` /
 * `redo` for the active model (the active model is the only one
 * the user is actively editing; multi-model undo would need a
 * separate UX). Disabled when the active model's stack is empty.
 *
 * Keyboard shortcuts (Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z) are wired
 * in `useKeyboardShortcuts`.
 */
function UndoRedoButtons() {
  const activeModelId = useViewerStore((s) => s.activeModelId);
  const undoStacks = useViewerStore((s) => s.undoStacks);
  const redoStacks = useViewerStore((s) => s.redoStacks);
  const undo = useViewerStore((s) => s.undo);
  const redo = useViewerStore((s) => s.redo);

  const canUndo = activeModelId !== null && (undoStacks.get(activeModelId)?.length ?? 0) > 0;
  const canRedo = activeModelId !== null && (redoStacks.get(activeModelId)?.length ?? 0) > 0;

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={!canUndo}
            onClick={(e) => {
              (e.currentTarget as HTMLButtonElement).blur();
              if (activeModelId) undo(activeModelId);
            }}
            aria-label="Undo"
          >
            <Undo2 className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          Undo <span className="ml-2 text-xs opacity-60">⌘Z</span>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={!canRedo}
            onClick={(e) => {
              (e.currentTarget as HTMLButtonElement).blur();
              if (activeModelId) redo(activeModelId);
            }}
            aria-label="Redo"
          >
            <Redo2 className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          Redo <span className="ml-2 text-xs opacity-60">⌘⇧Z</span>
        </TooltipContent>
      </Tooltip>
    </>
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
          aria-label={label}
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

/** Extensions the viewer can ingest (IFC / IFCX / GLB / point clouds). */
function isSupportedModelFile(f: File): boolean {
  const n = f.name.toLowerCase();
  return n.endsWith('.ifc') || n.endsWith('.ifcx') || n.endsWith('.ifczip') || n.endsWith('.glb')
    || n.endsWith('.las') || n.endsWith('.laz') || n.endsWith('.ply') || n.endsWith('.pcd')
    || n.endsWith('.e57') || n.endsWith('.pts') || n.endsWith('.xyz');
}

/** Case-insensitive IFCX check (filenames are accepted case-insensitively). */
function isIfcxModelFile(f: File): boolean {
  return f.name.toLowerCase().endsWith('.ifcx');
}

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
      const file = (e as CustomEvent<File>).detail;
      if (file) {
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
    window.addEventListener('ifc-lite:load-file', handler);
    window.addEventListener('ifc-lite:add-model', addHandler);
    return () => {
      window.removeEventListener('ifc-lite:load-file', handler);
      window.removeEventListener('ifc-lite:add-model', addHandler);
    };
  }, [loadFile, addModel]);

  // Check if we have models loaded (for showing add model button)
  const hasModelsLoaded = models.size > 0 || (geometryResult?.meshes && geometryResult.meshes.length > 0);
  const activeTool = useViewerStore((state) => state.activeTool);
  const setActiveTool = useViewerStore((state) => state.setActiveTool);
  const editEnabled = useViewerStore((state) => state.editEnabled);
  const toggleEditEnabled = useViewerStore((state) => state.toggleEditEnabled);
  const selectedEntityId = useViewerStore((state) => state.selectedEntityId);
  const selectedEntityIds = useViewerStore((state) => state.selectedEntityIds);
  const hideEntities = useViewerStore((state) => state.hideEntities);
  const error = useViewerStore((state) => state.error);
  const cameraCallbacks = useViewerStore((state) => state.cameraCallbacks);
  const hoverTooltipsEnabled = useViewerStore((state) => state.hoverTooltipsEnabled);
  const toggleHoverTooltips = useViewerStore((state) => state.toggleHoverTooltips);
  const typeVisibility = useViewerStore((state) => state.typeVisibility);
  const toggleTypeVisibility = useViewerStore((state) => state.toggleTypeVisibility);
  const resetTypeVisibility = useViewerStore((state) => state.resetTypeVisibility);
  // #957 follow-up: Model/Types 3D view switch — 'model' shows placed
  // occurrences (default), 'types' shows the type-library shapes.
  const typeViewMode = useViewerStore((state) => state.typeViewMode);
  const setTypeViewMode = useViewerStore((state) => state.setTypeViewMode);
  // Only models with type-library geometry (RepresentationMap shapes) can show
  // anything in "Types" mode, so the switch is hidden for the common
  // occurrence-only model. Derived in ViewportContainer from the merged meshes.
  const hasTypeGeometry = useViewerStore((state) => state.hasTypeGeometry);
  // How many of the class toggles are on — surfaced in the menu
  // header so the user sees scene state at a glance.
  const visibleClassCount = [
    typeVisibility.spaces,
    typeVisibility.spatialZones,
    typeVisibility.openings,
    typeVisibility.virtualElements,
    typeVisibility.site,
    typeVisibility.ifcAnnotations,
    typeVisibility.ifcGrid,
  ].filter(Boolean).length;
  // Issue #540: load-time toggle that asks the WASM bridge to merge
  // Revit-style multilayer walls. We surface this in the Class
  // Visibility dropdown so users discover it next to the other
  // "what shows in the scene" controls.
  const mergeLayers = useViewerStore((state) => state.mergeLayers);
  const setMergeLayers = useViewerStore((state) => state.setMergeLayers);
  const geometryMode = useViewerStore((state) => state.geometryMode);
  const setGeometryMode = useViewerStore((state) => state.setGeometryMode);
  const resetViewerState = useViewerStore((state) => state.resetViewerState);
  const bcfPanelVisible = useViewerStore((state) => state.bcfPanelVisible);
  const setBcfPanelVisible = useViewerStore((state) => state.setBcfPanelVisible);
  const idsPanelVisible = useViewerStore((state) => state.idsPanelVisible);
  const setIdsPanelVisible = useViewerStore((state) => state.setIdsPanelVisible);
  const clashPanelVisible = useViewerStore((state) => state.clashPanelVisible);
  const setClashPanelVisible = useViewerStore((state) => state.setClashPanelVisible);
  const comparePanelVisible = useViewerStore((state) => state.comparePanelVisible);
  const setComparePanelVisible = useViewerStore((state) => state.setComparePanelVisible);
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
  const extensionsPanelVisible = useViewerStore((state) => state.extensionsPanelVisible);
  const setExtensionsPanelVisible = useViewerStore((state) => state.setExtensionsPanelVisible);
  const scriptPanelVisible = useViewerStore((state) => state.scriptPanelVisible);
  const setScriptPanelVisible = useViewerStore((state) => state.setScriptPanelVisible);
  const ganttPanelVisible = useViewerStore((state) => state.ganttPanelVisible);
  const setGanttPanelVisible = useViewerStore((state) => state.setGanttPanelVisible);
  // Cesium 3D overlay state
  const cesiumAvailable = useViewerStore((state) => state.cesiumAvailable);
  const cesiumEnabled = useViewerStore((state) => state.cesiumEnabled);
  const toggleCesium = useViewerStore((state) => state.toggleCesium);
  const cesiumPlacementEditMode = useViewerStore((state) => state.cesiumPlacementEditMode);
  const setCesiumPlacementEditMode = useViewerStore((state) => state.setCesiumPlacementEditMode);
  // Sun & Sky panel state (sky, lighting presets, sun-path study)
  const solarEnabled = useViewerStore((state) => state.solarEnabled);
  const envPanelOpen = useViewerStore((state) => state.envPanelOpen);
  const toggleEnvPanel = useViewerStore((state) => state.toggleEnvPanel);
  const envSkyEnabled = useViewerStore((state) => state.envSkyEnabled);
  const envPreset = useViewerStore((state) => state.envPreset);
  const storeModels = useViewerStore((state) => state.models);
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

  // NOTE: The Class Visibility dropdown used to gate each toggle on whether
  // the loaded model actually contained that class (scanning meshes for
  // Spaces/Openings/Site and probing the entity table for Annotations/Grids).
  // That gating was removed: the toggles are persisted user preferences, so
  // they now render unconditionally and stay sticky across models and reloads.

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    // Filter to supported files (IFC, IFCX, GLB, point clouds)
    const supportedFiles = Array.from(files).filter(isSupportedModelFile);

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
      console.log(`[MainToolbar] Adding ${supportedFiles.length} IFCX overlay(s) to existing IFCX model - re-composing`);
      void addIfcxOverlays(supportedFiles);
    } else if (newFilesAreIfcx && !existingIsIfcx && ifcDataStore) {
      // User trying to add IFCX to IFC4 model - won't work
      console.warn('[MainToolbar] Cannot add IFCX files to non-IFCX model');
      alert(`IFCX overlay files cannot be added to IFC4 models.\n\nPlease load IFCX files separately.`);
    } else {
      // Standard case - add as independent models (IFC4, GLB, or mixed)
      void loadFilesSequentially(supportedFiles, handles);
    }
  }, [loadFilesSequentially, addIfcxOverlays, ifcDataStore]);

  const handleAddModelSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    // <input> yields no live handle, so models added this way aren't refreshable.
    const supportedFiles = Array.from(files).filter(isSupportedModelFile);
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

    if (failedNames.length > 0) {
      toast.error(`Refreshed ${ok.length}; couldn't re-read ${failedNames.join(', ')}.`);
    } else {
      toast.success(ok.length === 1 ? `Refreshed "${ok[0].fresh.name}"` : `Refreshed ${ok.length} models`);
    }
  }, [loadFile, addModel, clearAllModels]);

  // The command palette dispatches this (synchronously, inside the click) so the
  // toolbar's handle-capturing open path runs while user activation is still
  // live — required for the file dialog to actually open on Chrome.
  useEffect(() => {
    const handler = () => { void handleOpenClick(); };
    window.addEventListener('ifc-lite:open-files', handler);
    return () => window.removeEventListener('ifc-lite:open-files', handler);
  }, [handleOpenClick]);

  const hasSelection = selectedEntityId !== null;
  // Selection chip uses the multi-select size when present; falls back
  // to the single legacy `selectedEntityId` so the chip still says
  // "1 selected" for the click-to-pick flow that hasn't migrated.
  const selectionCount = selectedEntityIds.size > 0
    ? selectedEntityIds.size
    : (selectedEntityId !== null ? 1 : 0);

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

  const handleToggleRightPanel = useCallback((panel: 'bcf' | 'ids' | 'lens' | 'clash' | 'compare' | 'addElement' | 'extensions') => {
    if (activeAnalysisExtension?.placement !== 'bottom') {
      closeActiveAnalysisExtension();
    }

    const nextBcfVisible = panel === 'bcf' ? !bcfPanelVisible : false;
    const nextIdsVisible = panel === 'ids' ? !idsPanelVisible : false;
    const nextLensVisible = panel === 'lens' ? !lensPanelVisible : false;
    const nextClashVisible = panel === 'clash' ? !clashPanelVisible : false;
    const nextCompareVisible = panel === 'compare' ? !comparePanelVisible : false;
    const nextExtensionsVisible = panel === 'extensions' ? !extensionsPanelVisible : false;
    const isAddElementActive = activeTool === 'addElement';
    const nextAddElementActive = panel === 'addElement' ? !isAddElementActive : false;

    setBcfPanelVisible(nextBcfVisible);
    setIdsPanelVisible(nextIdsVisible);
    setLensPanelVisible(nextLensVisible);
    setClashPanelVisible(nextClashVisible);
    setComparePanelVisible(nextCompareVisible);
    setExtensionsPanelVisible(nextExtensionsVisible);
    // Keep the float + window channels in sync (#1200/#1201/#1208): toggling a
    // workspace panel from the toolbar re-docks it if it was floating or popped
    // out, instead of leaving an orphaned floating panel or OS window.
    if (panel !== 'addElement') {
      useViewerStore.getState().closeFloatingPanel(panel);
      closePanelWindow(panel);
    }

    if (panel === 'addElement') {
      setActiveTool(nextAddElementActive ? 'addElement' : 'select');
    } else if (isAddElementActive) {
      setActiveTool('select');
    }

    if (nextBcfVisible || nextIdsVisible || nextLensVisible || nextClashVisible || nextCompareVisible || nextExtensionsVisible || nextAddElementActive) {
      setRightPanelCollapsed(false);
    }
  }, [
    activeAnalysisExtension?.placement,
    activeTool,
    bcfPanelVisible,
    clashPanelVisible,
    comparePanelVisible,
    extensionsPanelVisible,
    idsPanelVisible,
    lensPanelVisible,
    setActiveTool,
    setBcfPanelVisible,
    setClashPanelVisible,
    setComparePanelVisible,
    setExtensionsPanelVisible,
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
    setClashPanelVisible(false);
    setExtensionsPanelVisible(false);
    // The right slot is single-tenant: when an analysis extension takes
    // it over, the AddElement tool must release it too, otherwise its 3D
    // click handler keeps placing elements behind the extension panel.
    if (activeTool === 'addElement') {
      setActiveTool('select');
    }
    setRightPanelCollapsed(false);
  }, [
    activeTool,
    analysisExtensionState.activeId,
    analysisExtensionState.extensions,
    setActiveTool,
    setBcfPanelVisible,
    setClashPanelVisible,
    setExtensionsPanelVisible,
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
    if (clashPanelVisible) panels.add('clash');
    if (comparePanelVisible) panels.add('compare');
    if (extensionsPanelVisible) panels.add('extensions');
    if (activeTool === 'addElement') panels.add('addElement');
    if (analysisExtensionState.activeId) panels.add(analysisExtensionState.activeId);
    return panels;
  }, [
    activeTool,
    analysisExtensionState.activeId,
    bcfPanelVisible,
    clashPanelVisible,
    comparePanelVisible,
    extensionsPanelVisible,
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
    if (activeWorkspacePanels.has('clash')) return 'Clash Detection';
    if (activeWorkspacePanels.has('compare')) return 'Compare Models';
    if (activeWorkspacePanels.has('extensions')) return 'Extensions';
    if (activeWorkspacePanels.has('addElement')) return 'Add Element';
    return activeAnalysisExtension?.label ?? 'Analysis';
  }, [activeAnalysisExtension?.label, activeWorkspacePanels]);

  const handleScreenshot = useCallback(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return;
    try {
      downloadDataUrl(canvas.toDataURL('image/png'), 'screenshot.png');
      toast.success('Screenshot saved');
    } catch (err) {
      console.error('Screenshot failed:', err);
      toast.error('Screenshot failed');
    }
  }, []);

  const handleExportCSV = useCallback(async (type: 'entities' | 'properties' | 'quantities' | 'spatial') => {
    if (!ifcDataStore?.source) return;
    try {
      const csv = await exportCsvFromBytes(ifcDataStore.source, type, { includeProperties: type === 'entities' });
      const filename = type === 'spatial' ? 'spatial-hierarchy.csv' : `${type}.csv`;
      downloadFile(csv, filename, 'text/csv');
      toast.success(`Exported ${type} CSV`);
    } catch (err) {
      console.error('CSV export failed:', err);
      toast.error(`CSV export failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, [ifcDataStore]);

  const handleExportJSON = useCallback(() => {
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
      downloadFile(json, 'model-data.json', 'application/json');
      toast.success(`Exported ${entities.length} entities as JSON`);
    } catch (err) {
      console.error('JSON export failed:', err);
      toast.error(`JSON export failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, [ifcDataStore]);

  return (
    <div className="flex items-center gap-1 px-2 h-12 border-b bg-white dark:bg-black border-zinc-200 dark:border-zinc-800 relative z-50">
      {/* ── File Operations ── */}
      <input
        id="file-input-open"
        ref={fileInputRef}
        type="file"
        accept=".ifc,.ifcx,.ifczip,.glb,.las,.laz,.ply,.pcd,.e57,.pts,.xyz"
        multiple
        onChange={handleFileSelect}
        className="hidden"
      />
      <input
        ref={addModelInputRef}
        type="file"
        accept=".ifc,.ifcx,.ifczip,.glb,.las,.laz,.ply,.pcd,.e57,.pts,.xyz"
        multiple
        onChange={handleAddModelSelect}
        className="hidden"
      />

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Open IFC file"
            onClick={(e) => {
              // Blur button to close tooltip before opening file dialog
              (e.currentTarget as HTMLButtonElement).blur();
              void handleOpenClick();
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

      {canRefresh && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={(e) => {
                (e.currentTarget as HTMLButtonElement).blur();
                void handleRefresh();
              }}
              disabled={loading}
              aria-label={models.size > 1 ? 'Refresh models from disk' : 'Refresh model from disk'}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{models.size > 1 ? 'Refresh models from disk' : 'Refresh model from disk'}</TooltipContent>
        </Tooltip>
      )}

      {/* Add Model button - only shown when models are loaded */}
      {hasModelsLoaded && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Add model to scene"
              onClick={(e) => {
                (e.currentTarget as HTMLButtonElement).blur();
                void handleAddModelClick();
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
          {/* Gate on any loaded model, not the legacy single-model geometryResult:
              federated / multi-model sessions populate `models` but leave
              geometryResult null, which would hide the whole export menu (incl. KMZ). */}
          <Button variant="ghost" size="icon-sm" aria-label="Export and download" disabled={!hasModelsLoaded && !ifcDataStore}>
            <Download className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <ExportDialog
            trigger={
              <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                <FileText className="h-4 w-4 mr-2" />
                Export IFC (with changes)
              </DropdownMenuItem>
            }
          />
          <DropdownMenuSeparator />
          <GLBExportDialog
            trigger={
              <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                <Download className="h-4 w-4 mr-2" />
                Export GLB (3D Model)
              </DropdownMenuItem>
            }
          />
          <KmzExportDialog
            trigger={
              <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                <Globe2 className="h-4 w-4 mr-2" />
                Export KMZ (Google Earth Pro)
              </DropdownMenuItem>
            }
          />
          <DropdownMenuSeparator />
          <HbjsonExportDialog
            trigger={
              <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                <Download className="h-4 w-4 mr-2" />
                Export HBJSON (Energy Model)
              </DropdownMenuItem>
            }
          />
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
              <Button variant="ghost" size="icon-sm" aria-label="Edit properties" disabled={!ifcDataStore}>
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
      <ExportChangesButton />

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
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Workspace
          </DropdownMenuLabel>
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
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Inspect & validate
          </DropdownMenuLabel>
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
          <DropdownMenuCheckboxItem
            checked={activeWorkspacePanels.has('clash')}
            onCheckedChange={() => handleToggleRightPanel('clash')}
          >
            <Crosshair className="h-4 w-4 mr-2" />
            Clash Detection
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={activeWorkspacePanels.has('compare')}
            onCheckedChange={() => handleToggleRightPanel('compare')}
          >
            <GitCompareArrows className="h-4 w-4 mr-2" />
            Compare Models
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Author
          </DropdownMenuLabel>
          <DropdownMenuCheckboxItem
            checked={activeWorkspacePanels.has('addElement')}
            onCheckedChange={() => handleToggleRightPanel('addElement')}
          >
            <PackagePlus className="h-4 w-4 mr-2" />
            Add Element
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={activeWorkspacePanels.has('extensions')}
            onCheckedChange={() => handleToggleRightPanel('extensions')}
          >
            <Puzzle className="h-4 w-4 mr-2" />
            Extensions
          </DropdownMenuCheckboxItem>
          {(rightAnalysisExtensions.length > 0 || bottomAnalysisExtensions.length > 0) && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Analysis extensions
              </DropdownMenuLabel>
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

      {/* ── Search (Tier-0 inline; ⌘F or / to focus) ── */}
      <SearchInline />

      <Separator orientation="vertical" className="h-6 mx-1" />

      {/* ── Navigation Tools ── */}
      <ToolButton tool="select" icon={MousePointer2} label="Select" shortcut="V" activeTool={activeTool} onToolChange={setActiveTool} />
      <ToolButton tool="walk" icon={PersonStanding} label="Walk Mode" shortcut="C" activeTool={activeTool} onToolChange={setActiveTool} />

      {/* ── Edit Mode pill ──
          Single global switch that unlocks every authoring affordance
          (inline property/attribute editors in the Properties panel,
          the add-element draw tools, georeference placement, and
          future geometry manipulators). Off by default — viewer-only
          users never see edit chrome. Press E to toggle.
          See `uiSlice.editEnabled`. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={editEnabled ? 'default' : 'ghost'}
            size="icon-sm"
            aria-label={editEnabled ? 'Exit edit mode' : 'Enter edit mode'}
            aria-pressed={editEnabled}
            onClick={(e) => {
              (e.currentTarget as HTMLButtonElement).blur();
              toggleEditEnabled();
            }}
            className={cn(editEnabled && 'bg-purple-600 text-white hover:bg-purple-700')}
          >
            <PenLine className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {editEnabled ? 'Exit Edit Mode' : 'Edit Mode'} <span className="opacity-50">E</span>
        </TooltipContent>
      </Tooltip>

      {/* Undo / Redo — always visible (any authoring op pushes a
          mutation; the buttons read disabled when the active
          model's undo stack is empty). Pinned next to Edit so the
          user has a one-click recovery for any change. */}
      <UndoRedoButtons />

      {/* Space Sketch is authoring chrome (it bakes IfcSpace
          entities), so like every other authoring affordance it only
          surfaces in edit mode — keeping the default toolbar lean.
          It lives next to the Edit pill that reveals it, with the
          same purple accent, and a drafting icon distinct from the
          square/grid icons (Panels, Basket, View options). */}
      {editEnabled && (
        <ToolButton
          tool="spaceSketch"
          icon={DraftingCompass}
          label="Space Sketch"
          activeTool={activeTool}
          onToolChange={setActiveTool}
          activeAccentClass="bg-purple-600 text-white hover:bg-purple-700"
        />
      )}

      {/* Draw / modify gestures live in the existing Add Element
          panel (right-side `AddElementPanel`, opened via the Add
          Element button) and in the contextual Geometry edit card
          inside the Properties panel — splitting a selected wall,
          duplicating, rotating, etc. all happen there. Keeping the
          toolbar minimal: just the Edit mode switch + the
          navigation tools. Per-element-type draw pills duplicated
          the AddElement panel and added clutter. */}
      {/* (no draw pills here — by design) */}

      <Separator orientation="vertical" className="h-6 mx-1" />

      {/* ── Measurement & Section ── */}
      <ToolButton tool="measure" icon={Ruler} label="Measure" shortcut="M" activeTool={activeTool} onToolChange={setActiveTool} />
      <ToolButton tool="section" icon={Scissors} label="Section" shortcut="X" activeTool={activeTool} onToolChange={setActiveTool} />
      <ToolButton
        tool="annotate"
        icon={StickyNote}
        label="Annotate"
        shortcut="P"
        activeTool={activeTool}
        onToolChange={setActiveTool}
        activeAccentClass="bg-amber-500 text-white hover:bg-amber-500/90"
      />

      {/* Storey navigation + level display (Stacked / Exploded / Solo) moved
          into the Hierarchy panel's Building Storeys section so every "level"
          concept lives in one place — see `StoreyDisplayControls`. The two
          adjacent storey buttons that used to sit here (Quick Floorplan +
          Level display) were retired to fix the duplicate-button confusion. */}

      <Separator orientation="vertical" className="h-6 mx-1" />

      {/* ── Basket Presentation ── */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={basketPresentationVisible ? 'default' : 'ghost'}
            size="icon-sm"
            aria-label={basketPresentationVisible ? 'Hide Presentation dock' : 'Show Presentation dock'}
            aria-pressed={basketPresentationVisible}
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

      {/*
        Selection action cluster — Hide / Frame / Isolate only make
        sense with a selection, so they don't get to live in the
        toolbar chrome at rest. When a user selects anything, the
        slot opens with a "N selected" pill + the three actions next
        to it. Hotkeys (Del / F / I / =) keep working regardless of
        whether the chip is rendered, so power users feel no change.

        The chip lives in the same separator zone the buttons used to
        occupy so the spatial location is familiar to muscle memory.
      */}
      {selectionCount > 0 && (
        <div
          className="flex items-center gap-0.5 pl-1.5 pr-0.5 rounded-md border border-primary/30 bg-primary/5 transition-opacity duration-150"
          role="group"
          aria-label={`Selection actions — ${selectionCount} selected`}
        >
          <span
            className="text-[10px] font-semibold tabular-nums text-primary uppercase tracking-wide whitespace-nowrap pr-1.5"
            aria-hidden="true"
          >
            {selectionCount} sel
          </span>
          <ActionButton icon={Equal} label="Isolate Selection (Set Basket)" onClick={handleIsolate} shortcut="I / =" />
          <ActionButton icon={EyeOff} label="Hide Selection" onClick={handleHide} shortcut="Del / Space" />
          <ActionButton
            icon={Crosshair}
            label="Frame Selection"
            onClick={() => cameraCallbacks.frameSelection?.()}
            shortcut="F"
          />
        </div>
      )}

      <ActionButton icon={Eye} label="Show All (Reset Filters)" onClick={handleShowAll} shortcut="A" />
      <ActionButton icon={Maximize2} label="Fit All" onClick={() => cameraCallbacks.fitAll?.()} shortcut="Z" />

      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                // Stay enabled even with no model loaded — the dropdown
                // also exposes load-time settings (Merge Multilayer
                // Walls) that the user should be able to set BEFORE
                // opening a file. The class toggles are persisted
                // preferences, so they always render too.
                aria-label={mergeLayers ? 'Visibility (Merge Multilayer Walls is on)' : 'Visibility'}
                className="relative"
              >
                <Filter className="h-4 w-4" />
                {mergeLayers && (
                  // Tiny accent dot announcing that a non-default load
                  // setting is active. Decorative — semantics live on
                  // the button's aria-label and the tooltip.
                  <span
                    aria-hidden="true"
                    className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-primary ring-1 ring-background"
                  />
                )}
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>
            {mergeLayers ? 'Visibility · Merge Multilayer Walls is on' : 'Visibility'}
          </TooltipContent>
        </Tooltip>
        {/*
          Settings-style panel (not a list of menu-items): each row is a
          plain <label> wrapping a right-aligned Switch, so toggling does
          NOT close the menu — users routinely flip several classes in one
          pass. State reads two ways: the switch position and the row
          dimming when off. All five render unconditionally (persisted
          preferences, sticky across models/reloads); toggling a class the
          model lacks is a no-op.
        */}
        <DropdownMenuContent align="start" className="w-[300px] p-1.5">
          {/* Model / Types 3D view switch (#957 follow-up). A type carries a
              RepresentationMap whose shape is drawn at its MappingOrigin; "Types"
              shows that type library, "Model" shows the placed occurrences. The
              two are mutually exclusive — toggling re-filters the cached mesh set
              instantly (no reload). Only rendered when the model actually has
              type-library geometry — most carry only occurrence geometry, where
              "Types" would be empty, so the switch would just be a dead control. */}
          {hasTypeGeometry && (
            <>
              <div className="px-1.5 pb-1 pt-0.5">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  3D View
                </span>
              </div>
              <div className="flex gap-1 px-1.5 pb-1.5" role="radiogroup" aria-label="3D view mode">
                <button
                  type="button"
                  role="radio"
                  aria-checked={typeViewMode === 'model'}
                  onClick={() => setTypeViewMode('model')}
                  className={cn(
                    'flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors',
                    typeViewMode === 'model'
                      ? 'border-primary/40 bg-primary/10 text-foreground'
                      : 'border-transparent text-muted-foreground hover:bg-muted/50',
                  )}
                >
                  <Boxes className="h-3.5 w-3.5 shrink-0" />
                  Model
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={typeViewMode === 'types'}
                  onClick={() => setTypeViewMode('types')}
                  className={cn(
                    'flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors',
                    typeViewMode === 'types'
                      ? 'border-primary/40 bg-primary/10 text-foreground'
                      : 'border-transparent text-muted-foreground hover:bg-muted/50',
                  )}
                >
                  <Shapes className="h-3.5 w-3.5 shrink-0" />
                  Types
                </button>
              </div>

              <DropdownMenuSeparator className="my-1" />
            </>
          )}

          <div className="flex items-center justify-between gap-2 px-1.5 pb-1 pt-0.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Visibility
            </span>
            <div className="flex items-center gap-1">
              <span className="text-[11px] tabular-nums text-muted-foreground/80">
                {visibleClassCount}/5
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                onClick={resetTypeVisibility}
              >
                Reset
              </Button>
            </div>
          </div>

          <ClassVisibilityRow
            icon={<Box className="h-4 w-4 shrink-0" style={{ color: '#33d9ff' }} />}
            label="Spaces"
            description="Room volumes (IfcSpace)"
            checked={typeVisibility.spaces}
            onChange={() => toggleTypeVisibility('spaces')}
          />
          <ClassVisibilityRow
            icon={<Box className="h-4 w-4 shrink-0" style={{ color: '#b85af2' }} />}
            label="Spatial Zones"
            description="Gross-area volumes (IfcSpatialZone)"
            checked={typeVisibility.spatialZones}
            onChange={() => toggleTypeVisibility('spatialZones')}
          />
          <ClassVisibilityRow
            icon={<SquareX className="h-4 w-4 shrink-0" style={{ color: '#ff6b4a' }} />}
            label="Openings"
            description="Door & window voids"
            checked={typeVisibility.openings}
            onChange={() => toggleTypeVisibility('openings')}
          />
          <ClassVisibilityRow
            icon={<BoxSelect className="h-4 w-4 shrink-0" style={{ color: '#9aa0a6' }} />}
            label="Virtual Elements"
            description="Non-physical boundaries & clearance volumes"
            checked={typeVisibility.virtualElements}
            onChange={() => toggleTypeVisibility('virtualElements')}
          />
          <ClassVisibilityRow
            icon={<Building2 className="h-4 w-4 shrink-0" style={{ color: '#66cc4d' }} />}
            label="Site"
            description="Terrain & context"
            checked={typeVisibility.site}
            onChange={() => toggleTypeVisibility('site')}
          />
          <ClassVisibilityRow
            icon={<Pencil className="h-4 w-4 shrink-0" style={{ color: '#e4b400' }} />}
            label="Annotations"
            description="Text, dimensions, leaders"
            checked={typeVisibility.ifcAnnotations}
            onChange={() => toggleTypeVisibility('ifcAnnotations')}
          />
          <ClassVisibilityRow
            icon={<Grid3x3 className="h-4 w-4 shrink-0" style={{ color: '#e4b400' }} />}
            label="Grids"
            description="Structural axes"
            checked={typeVisibility.ifcGrid}
            onChange={() => toggleTypeVisibility('ifcGrid')}
          />

          <DropdownMenuSeparator className="my-1" />

          {/* Merge multilayer walls rebuilds geometry, so unlike the live
              toggles above it only takes effect on the next model load.
              The "· on reload" suffix carries that nuance inline — keeps
              the row identical in shape to the others (no header, no chip
              crowding the long label). */}
          <label className="group flex items-center justify-between gap-3 rounded-md px-2 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors">
            <span className={cn('flex items-center gap-2.5 min-w-0 transition-opacity', !mergeLayers && 'opacity-50')}>
              <Layers2 className="h-4 w-4 shrink-0 text-primary" />
              <span className="grid gap-0.5 min-w-0">
                <span className="text-sm leading-tight truncate">Merge multilayer walls</span>
                <span className="text-[10px] leading-tight text-muted-foreground truncate">
                  Render walls as one solid · on reload
                </span>
              </span>
            </span>
            <Switch checked={mergeLayers} onCheckedChange={(next) => setMergeLayers(next === true)} />
          </label>

          {/* Fast vs Exact geometry — like merge-layers, a load-time geometry
              input that only takes effect on the next model load ("· on reload").
              Fast skips sub-10% detail cuts + auto-lowers density on heavy models
              for quick first paint; Exact keeps every cut at full density for
              display/measure/export fidelity. */}
          <label className="group flex items-center justify-between gap-3 rounded-md px-2 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors">
            <span className={cn('flex items-center gap-2.5 min-w-0 transition-opacity', geometryMode !== 'fast' && 'opacity-50')}>
              <Zap className="h-4 w-4 shrink-0 text-primary" />
              <span className="grid gap-0.5 min-w-0">
                <span className="text-sm leading-tight truncate">Fast geometry</span>
                <span className="text-[10px] leading-tight text-muted-foreground truncate">
                  {geometryMode === 'fast'
                    ? 'Skip tiny cuts, auto-detail · on reload'
                    : 'Exact: full cuts + density · on reload'}
                </span>
              </span>
            </span>
            <Switch
              checked={geometryMode === 'fast'}
              onCheckedChange={(next) => setGeometryMode(next === true ? 'fast' : 'exact')}
            />
          </label>
        </DropdownMenuContent>
      </DropdownMenu>

      <Separator orientation="vertical" className="h-6 mx-1" />

      {/* ── Camera & View ── */}
      <ActionButton icon={Home} label="Home (Isometric + Reset Visibility)" onClick={handleHome} shortcut="H" />

      {/*
        Cesium 3D World Context — sits next to Home as a raw button so
        the world-context affordance is one click away when a model has
        georeferencing. When active, the "Move georeference" sub-toggle
        appears beside it (its amber tint signals a modal pose whose
        exit affordance must stay visible).
      */}
      {cesiumAvailable && (
        <>
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
                  if (cesiumEnabled) {
                    setCesiumPlacementEditMode(false);
                    if (activeTool === 'cesium-placement') setActiveTool('select');
                  }
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
          {cesiumEnabled && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={cesiumPlacementEditMode ? 'default' : 'ghost'}
                  size="icon-sm"
                  aria-label={cesiumPlacementEditMode ? 'Stop moving georeference' : 'Move georeference in Cesium'}
                  aria-pressed={cesiumPlacementEditMode}
                  onClick={(e) => {
                    (e.currentTarget as HTMLButtonElement).blur();
                    const next = !cesiumPlacementEditMode;
                    setCesiumPlacementEditMode(next);
                    setActiveTool(next ? 'cesium-placement' : 'select');
                  }}
                  className={cn(cesiumPlacementEditMode && 'bg-amber-500 text-zinc-950 hover:bg-amber-400')}
                >
                  <Move className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {cesiumPlacementEditMode ? 'Stop moving georeference' : 'Move georeference'}
              </TooltipContent>
            </Tooltip>
          )}
        </>
      )}

      {/* Sun & Sky panel — sky, lighting presets and the sun-path study.
          Available for every model, georeferenced or not. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={envPanelOpen ? 'default' : 'ghost'}
            size="icon-sm"
            aria-label={envPanelOpen ? 'Close Sun & Sky panel' : 'Open Sun & Sky panel'}
            aria-pressed={envPanelOpen}
            onClick={(e) => {
              (e.currentTarget as HTMLButtonElement).blur();
              toggleEnvPanel();
            }}
            className={cn(
              (envPanelOpen || solarEnabled || envSkyEnabled || envPreset !== 'default')
                && 'bg-amber-500 text-zinc-950 hover:bg-amber-400',
            )}
          >
            <Sun className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Sun &amp; sky</TooltipContent>
      </Tooltip>

      {/*
        Consolidated View dropdown — holds projection toggle, preset
        views, and hover tooltips. These are "view options" the user
        reaches for occasionally, and rendering each as a raw icon
        button used to dominate the toolbar's right half. Cesium stayed
        inline (above) because the world-context overlay is a primary
        affordance, not a tucked-away view setting.
      */}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant={(projectionMode === 'orthographic' || hoverTooltipsEnabled) ? 'default' : 'ghost'}
                size="icon-sm"
                aria-label="View options"
                className={cn((projectionMode === 'orthographic' || hoverTooltipsEnabled) && 'bg-primary text-primary-foreground')}
              >
                <Grid3x3 className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>View options</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Preset views
          </DropdownMenuLabel>
          <DropdownMenuItem onClick={handleHome}>
            <Box className="h-4 w-4 mr-2" /> Isometric <span className="ml-auto text-xs opacity-60">H</span>
          </DropdownMenuItem>
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
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Projection
          </DropdownMenuLabel>
          <DropdownMenuCheckboxItem
            checked={projectionMode === 'orthographic'}
            onCheckedChange={() => toggleProjectionMode()}
          >
            <Orbit className="h-4 w-4 mr-2" />
            Orthographic
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Helpers
          </DropdownMenuLabel>
          <DropdownMenuCheckboxItem
            checked={hoverTooltipsEnabled}
            onCheckedChange={() => toggleHoverTooltips()}
          >
            <Info className="h-4 w-4 mr-2" />
            Hover tooltips
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Extension toolbar contributions (right-aligned) */}
      <ExtensionToolbarSlot slot="toolbar.right" />

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

      {/* Right Side Actions — /mcp moved to the Info dialog header so
          the toolbar's meta cluster stays focused on shell chrome
          (Settings · Theme · Help). */}
      <div className="flex items-center gap-2 ml-2 pl-2 border-l border-zinc-200 dark:border-zinc-700/60">
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
              aria-label="Info and keyboard shortcuts"
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
