/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import React, { useRef, useState, useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  FolderOpen,
  Download,
  MousePointer2,
  PersonStanding,
  Ruler,
  Scissors,
  MapPin,
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
  Layers2,
  SquareX,
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
  Move,
  Settings,
  PenLine,
  Layers3,
  SquareStack,
  ChevronsUpDown,
  Undo2,
  Redo2,
  Share2,
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
import { useViewerStore, isIfcxDataStore } from '@/store';
import { goHomeFromStore, resetVisibilityForHomeFromStore } from '@/store/homeView';
import { executeBasketIsolate } from '@/store/basket/basketCommands';
import { useIfc } from '@/hooks/useIfc';
import { cn } from '@/lib/utils';
import { CSVExporter } from '@ifc-lite/export';
import { FileSpreadsheet, FileJson, FileText, Filter, Upload, Pencil } from 'lucide-react';
import { ExportDialog } from './ExportDialog';
import { GLBExportDialog } from './GLBExportDialog';
import { ShareDialog } from './ShareDialog';
import { isCollabEnabled } from '@/lib/collab/config';
import { BulkPropertyEditor } from './BulkPropertyEditor';
import { DataConnector } from './DataConnector';
import { ExportChangesButton } from './ExportChangesButton';
import { SearchInline } from './SearchInline';
import { useFloorplanView } from '@/hooks/useFloorplanView';
import { buildDesktopUpgradeUrl, hasDesktopFeatureAccess, type DesktopFeature } from '@/lib/desktop-product';
import { recordRecentFiles, cacheFileBlobs } from '@/lib/recent-files';
import { ThemeSwitch } from './ThemeSwitch';
import { ExtensionToolbarSlot } from '@/components/extensions/ExtensionToolbarSlot';
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

type Tool = 'select' | 'walk' | 'measure' | 'section' | 'annotate' | 'addElement' | 'split';
type WorkspacePanel = 'script' | 'list' | 'bcf' | 'ids' | 'lens' | 'addElement' | string;

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
          onClick={(e) => {
            // Blur button to close tooltip after click
            (e.currentTarget as HTMLButtonElement).blur();
            onToolChange(tool);
          }}
          className={cn(
            isActive && (activeAccentClass ?? 'bg-primary text-primary-foreground'),
          )}
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
 * Stacked / Exploded / Solo level display dropdown. Pinned next
 * to the Quick Floorplan dropdown so storey-related controls
 * cluster visually. Shows a small purple dot on the trigger when
 * mode is not Stacked, so the user can tell at a glance that an
 * Exploded / Solo view is active.
 *
 * Gating: parent renders this only when there are ≥ 2 storeys
 * — single-storey models have no use for level display modes.
 */
interface LevelDisplayDropdownProps {
  availableStoreys: Array<{ modelId: string; expressId: number; name: string; elevation: number }>;
}

function LevelDisplayDropdown({ availableStoreys }: LevelDisplayDropdownProps) {
  const levelDisplayMode = useViewerStore((s) => s.levelDisplayMode);
  const setLevelDisplayMode = useViewerStore((s) => s.setLevelDisplayMode);
  const explodedGap = useViewerStore((s) => s.explodedGap);
  const setExplodedGap = useViewerStore((s) => s.setExplodedGap);
  const soloStorey = useViewerStore((s) => s.soloStorey);
  const setSoloStorey = useViewerStore((s) => s.setSoloStorey);

  const dirty = levelDisplayMode !== 'stacked';
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Level display mode"
              className="relative"
            >
              {levelDisplayMode === 'exploded' ? (
                <ChevronsUpDown className="h-4 w-4" />
              ) : levelDisplayMode === 'solo' ? (
                <SquareStack className="h-4 w-4" />
              ) : (
                <Layers3 className="h-4 w-4" />
              )}
              {dirty && (
                <span
                  aria-hidden="true"
                  className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-purple-500 ring-1 ring-background"
                />
              )}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Level display ({levelDisplayMode})</TooltipContent>
      </Tooltip>
      <DropdownMenuContent className="w-72">
        <DropdownMenuLabel>Level display</DropdownMenuLabel>
        <DropdownMenuCheckboxItem
          checked={levelDisplayMode === 'stacked'}
          onCheckedChange={() => setLevelDisplayMode('stacked')}
        >
          <Layers3 className="h-4 w-4 mr-2" /> Stacked
          <span className="ml-auto text-[10px] opacity-50">default</span>
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={levelDisplayMode === 'exploded'}
          onCheckedChange={() => setLevelDisplayMode('exploded')}
        >
          <ChevronsUpDown className="h-4 w-4 mr-2" /> Exploded
        </DropdownMenuCheckboxItem>
        {levelDisplayMode === 'exploded' && (
          <div className="px-2 pb-1.5 pt-1 flex items-center gap-2 text-xs">
            <span className="text-zinc-500">Gap (m)</span>
            <input
              type="number"
              min={0}
              max={100}
              step={0.5}
              value={explodedGap}
              onChange={(e) => {
                // Guard non-finite — clearing the field or typing
                // a stray "e" would yield NaN, which the offset
                // math would silently propagate. The slice setter
                // also clamps to [0, 100] for the range guard.
                const next = e.currentTarget.valueAsNumber;
                if (Number.isFinite(next)) setExplodedGap(next);
              }}
              className="w-16 px-1.5 py-0.5 border border-zinc-300 dark:border-zinc-700
                bg-white dark:bg-zinc-950 text-xs font-mono rounded
                focus:outline-none focus:ring-1 focus:ring-purple-500"
            />
          </div>
        )}
        <DropdownMenuCheckboxItem
          checked={levelDisplayMode === 'solo'}
          onCheckedChange={() => setLevelDisplayMode('solo')}
        >
          <SquareStack className="h-4 w-4 mr-2" /> Solo
        </DropdownMenuCheckboxItem>
        {levelDisplayMode === 'solo' && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wide">Storey</DropdownMenuLabel>
            {availableStoreys.map((storey) => (
              <DropdownMenuItem
                key={`${storey.modelId}-${storey.expressId}`}
                onClick={() => setSoloStorey({ modelId: storey.modelId, expressId: storey.expressId })}
                className={cn(
                  soloStorey?.modelId === storey.modelId &&
                    soloStorey?.expressId === storey.expressId &&
                    'bg-purple-100 dark:bg-purple-950/40',
                )}
              >
                <Building2 className="h-4 w-4 mr-2" />
                {storey.name}
                <span className="ml-auto text-[10px] opacity-60">{storey.elevation.toFixed(1)}m</span>
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
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
  // Collaboration (M1): Share button is gated behind the collab feature flag.
  const collabEnabled = useMemo(() => isCollabEnabled(), []);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const collabPeerCount = useViewerStore((s) => s.collabPeers.length);
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
  // How many of the five class toggles are on — surfaced in the menu
  // header so the user sees scene state at a glance.
  const visibleClassCount = [
    typeVisibility.spaces,
    typeVisibility.openings,
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

  // NOTE: The Class Visibility dropdown used to gate each toggle on whether
  // the loaded model actually contained that class (scanning meshes for
  // Spaces/Openings/Site and probing the entity table for Annotations/Grids).
  // That gating was removed: the toggles are persisted user preferences, so
  // they now render unconditionally and stay sticky across models and reloads.

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    // Filter to supported files (IFC, IFCX, GLB)
    const supportedFiles = Array.from(files).filter(
      f => f.name.endsWith('.ifc') || f.name.endsWith('.ifcx') || f.name.endsWith('.glb')
        || f.name.toLowerCase().endsWith('.las') || f.name.toLowerCase().endsWith('.laz') || f.name.toLowerCase().endsWith('.ply') || f.name.toLowerCase().endsWith('.pcd') || f.name.toLowerCase().endsWith('.e57') || f.name.toLowerCase().endsWith('.pts') || f.name.toLowerCase().endsWith('.xyz')
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
        || f.name.toLowerCase().endsWith('.las') || f.name.toLowerCase().endsWith('.laz') || f.name.toLowerCase().endsWith('.ply') || f.name.toLowerCase().endsWith('.pcd') || f.name.toLowerCase().endsWith('.e57') || f.name.toLowerCase().endsWith('.pts') || f.name.toLowerCase().endsWith('.xyz')
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

  const handleToggleRightPanel = useCallback((panel: 'bcf' | 'ids' | 'lens' | 'addElement' | 'extensions') => {
    if (activeAnalysisExtension?.placement !== 'bottom') {
      closeActiveAnalysisExtension();
    }
    if (panel === 'bcf' && !requireDesktopFeature('bcf_issue_management', 'BCF issue management')) {
      return;
    }
    if (panel === 'ids' && !requireDesktopFeature('ids_validation', 'IDS validation')) {
      return;
    }
    if (panel === 'extensions' && !requireDesktopFeature('extensions', 'Extensions')) {
      return;
    }

    const nextBcfVisible = panel === 'bcf' ? !bcfPanelVisible : false;
    const nextIdsVisible = panel === 'ids' ? !idsPanelVisible : false;
    const nextLensVisible = panel === 'lens' ? !lensPanelVisible : false;
    const nextExtensionsVisible = panel === 'extensions' ? !extensionsPanelVisible : false;
    const isAddElementActive = activeTool === 'addElement';
    const nextAddElementActive = panel === 'addElement' ? !isAddElementActive : false;

    setBcfPanelVisible(nextBcfVisible);
    setIdsPanelVisible(nextIdsVisible);
    setLensPanelVisible(nextLensVisible);
    setExtensionsPanelVisible(nextExtensionsVisible);

    if (panel === 'addElement') {
      setActiveTool(nextAddElementActive ? 'addElement' : 'select');
    } else if (isAddElementActive) {
      setActiveTool('select');
    }

    if (nextBcfVisible || nextIdsVisible || nextLensVisible || nextExtensionsVisible || nextAddElementActive) {
      setRightPanelCollapsed(false);
    }
  }, [
    activeAnalysisExtension?.placement,
    activeTool,
    bcfPanelVisible,
    extensionsPanelVisible,
    idsPanelVisible,
    lensPanelVisible,
    requireDesktopFeature,
    setActiveTool,
    setBcfPanelVisible,
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
    if (extensionsPanelVisible) panels.add('extensions');
    if (activeTool === 'addElement') panels.add('addElement');
    if (analysisExtensionState.activeId) panels.add(analysisExtensionState.activeId);
    return panels;
  }, [
    activeTool,
    analysisExtensionState.activeId,
    bcfPanelVisible,
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
    if (activeWorkspacePanels.has('extensions')) return 'Extensions';
    if (activeWorkspacePanels.has('addElement')) return 'Add Element';
    return activeAnalysisExtension?.label ?? 'Analysis';
  }, [activeAnalysisExtension?.label, activeWorkspacePanels]);

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
        accept=".ifc,.ifcx,.glb,.las,.laz,.ply,.pcd,.e57,.pts,.xyz"
        multiple
        onChange={handleFileSelect}
        className="hidden"
      />
      <input
        ref={addModelInputRef}
        type="file"
        accept=".ifc,.ifcx,.glb,.las,.laz,.ply,.pcd,.e57,.pts,.xyz"
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
          {hasDesktopFeatureAccess(desktopEntitlement, 'exports') ? (
            <GLBExportDialog
              trigger={
                <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                  <Download className="h-4 w-4 mr-2" />
                  Export GLB (3D Model)
                </DropdownMenuItem>
              }
            />
          ) : (
            <DropdownMenuItem onClick={() => promptDesktopUpgrade('Exports')}>
              <Download className="h-4 w-4 mr-2" />
              Export GLB (3D Model)
            </DropdownMenuItem>
          )}
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

      {/* Share - link-based multiuser collaboration (M1, behind collab.enabled) */}
      {collabEnabled && (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={!geometryResult}
                onClick={() => setShareDialogOpen(true)}
                className="relative"
                aria-label="Share"
              >
                <Share2 className="h-4 w-4" />
                {collabPeerCount > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-medium text-primary-foreground">
                    {collabPeerCount + 1}
                  </span>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Share</TooltipContent>
          </Tooltip>
          <ShareDialog open={shareDialogOpen} onOpenChange={setShareDialogOpen} />
        </>
      )}

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
        icon={MapPin}
        label="Annotate"
        shortcut="P"
        activeTool={activeTool}
        onToolChange={setActiveTool}
        activeAccentClass="bg-amber-500 text-white hover:bg-amber-500/90"
      />

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

      {/* Level display mode (Stacked / Exploded / Solo). Only
          surfaces when the active model has at least 2 storeys —
          single-storey models have nothing useful to show. */}
      {availableStoreys.length >= 2 && <LevelDisplayDropdown availableStoreys={availableStoreys} />}

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
            description="Room & zone volumes"
            checked={typeVisibility.spaces}
            onChange={() => toggleTypeVisibility('spaces')}
          />
          <ClassVisibilityRow
            icon={<SquareX className="h-4 w-4 shrink-0" style={{ color: '#ff6b4a' }} />}
            label="Openings"
            description="Door & window voids"
            checked={typeVisibility.openings}
            onChange={() => toggleTypeVisibility('openings')}
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
      {cesiumAvailable && !desktopShell && (
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
