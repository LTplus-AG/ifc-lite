/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import React, { useCallback, useMemo } from 'react';
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
  Plus,
  PackagePlus,
  MessageSquare,
  ClipboardCheck,
  Puzzle,
  Palette,
  Orbit,
  Layout,
  Layers,
  LayoutTemplate,
  FileCode2,
  CalendarClock,
  Globe2,
  Sun,
  Move,
  Move3d,
  PenLine,
  PanelTop,
  Undo2,
  Redo2,
  RefreshCw,
  Share2,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
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
import { useViewerStore } from '@/store';
import { goHomeFromStore, resetVisibilityForHomeFromStore } from '@/store/homeView';
import { executeBasketIsolate } from '@/store/basket/basketCommands';
import { useIfc } from '@/hooks/useIfc';
import { cn } from '@/lib/utils';
import { FileSpreadsheet, FileJson, FileText, Filter, Upload, Pencil, DraftingCompass } from 'lucide-react';
import { ExportDialog } from './ExportDialog';
import { GLBExportDialog } from './GLBExportDialog';
import { KmzExportDialog } from './KmzExportDialog';
import { HbjsonExportDialog } from './HbjsonExportDialog';
import { BulkPropertyEditor } from './BulkPropertyEditor';
import { DataConnector } from './DataConnector';
import { ExportChangesButton } from './ExportChangesButton';
import { isCollabEnabled } from '@/lib/collab/config';
import { SearchInline } from './SearchInline';
import { ThemeSwitch } from './ThemeSwitch';
import { ExtensionToolbarSlot } from '@/components/extensions/ExtensionToolbarSlot';
import { tourAnchor, toolAnchor } from '@/lib/tours/anchors';
import { useFileCommands } from './toolbar/useFileCommands';
import { useExportCommands } from './toolbar/useExportCommands';
import { useWorkspacePanelControls } from './toolbar/useWorkspacePanelControls';
import { ClassVisibilityMenuContent } from './toolbar/ClassVisibilityMenu';

type Tool = 'select' | 'walk' | 'measure' | 'section' | 'annotate' | 'addElement' | 'split' | 'spaceSketch';

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
  // Undo/redo replay authoring mutations, so they honour the same collab
  // role gate as edit mode (null role = single-user, always editable).
  const collabRole = useViewerStore((s) => s.collabRole);
  const canEditInSession = collabRole === null || collabRole === 'editor' || collabRole === 'admin';

  const canUndo = canEditInSession && activeModelId !== null && (undoStacks.get(activeModelId)?.length ?? 0) > 0;
  const canRedo = canEditInSession && activeModelId !== null && (redoStacks.get(activeModelId)?.length ?? 0) > 0;

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

interface MainToolbarProps {
  onShowShortcuts?: () => void;
}

export function MainToolbar({ onShowShortcuts }: MainToolbarProps = {} as MainToolbarProps) {
  // Collaboration: the Share button is gated behind the collab feature flag.
  // The ShareDialog + its `ifc-lite:open-share-dialog` listener live in
  // useFileCommands (always mounted for the active toolbar style).
  const collabEnabled = useMemo(() => isCollabEnabled(), []);
  const collabPeerCount = useViewerStore((s) => s.collabPeers.length);
  const collabRoomId = useViewerStore((s) => s.collabRoomId);
  const collabPanelVisible = useViewerStore((s) => s.collabPanelVisible);
  const {
    loading,
    progress,
    geometryProgress,
    metadataProgress,
    geometryResult,
    ifcDataStore,
    models,
  } = useIfc();

  // Shared command surfaces (also drive the ribbon toolbar): file
  // open/add/refresh incl. the global `ifc-lite:*` load listeners and
  // hidden inputs, data exports, and the workspace-panel dock rules.
  const {
    fileInputs,
    openShareDialog,
    handleOpenClick,
    handleAddModelClick,
    handleRefresh,
    canRefresh,
    hasModelsLoaded,
  } = useFileCommands();
  const { handleExportCSV, handleExportJSON, handleScreenshot } = useExportCommands();
  const {
    activeWorkspacePanels,
    workspacePanelLabel,
    handleToggleBottomPanel,
    handleToggleRightPanel,
    handleToggleAnalysisExtension,
    rightAnalysisExtensions,
    bottomAnalysisExtensions,
  } = useWorkspacePanelControls();

  const activeTool = useViewerStore((state) => state.activeTool);
  const setActiveTool = useViewerStore((state) => state.setActiveTool);
  const editEnabled = useViewerStore((state) => state.editEnabled);
  const toggleEditEnabled = useViewerStore((state) => state.toggleEditEnabled);
  // Collab role: editing (gizmo, geometry card, add-element, inline property
  // editors) is reserved for editor/admin. Derive from the reactive role so
  // the Edit pill enables/disables live when the role changes. null role
  // = single-user, always editable.
  const collabEditRole = useViewerStore((state) => state.collabRole);
  const canEditInSession =
    collabEditRole === null || collabEditRole === 'editor' || collabEditRole === 'admin';
  const selectedEntityId = useViewerStore((state) => state.selectedEntityId);
  const selectedEntityIds = useViewerStore((state) => state.selectedEntityIds);
  const hideEntities = useViewerStore((state) => state.hideEntities);
  const error = useViewerStore((state) => state.error);
  const cameraCallbacks = useViewerStore((state) => state.cameraCallbacks);
  const hoverTooltipsEnabled = useViewerStore((state) => state.hoverTooltipsEnabled);
  const toggleHoverTooltips = useViewerStore((state) => state.toggleHoverTooltips);
  // Issue #540: the merge-multilayer-walls load-time toggle lives in the
  // shared Class Visibility menu; the trigger only needs the flag for
  // its non-default-setting accent dot.
  const mergeLayers = useViewerStore((state) => state.mergeLayers);
  // Toolbar style switch (issue #1686): the View options menu offers the
  // jump to the tabbed ribbon; the ribbon's View tab offers the way back.
  const setToolbarStyle = useViewerStore((state) => state.setToolbarStyle);
  const projectionMode = useViewerStore((state) => state.projectionMode);
  const toggleProjectionMode = useViewerStore((state) => state.toggleProjectionMode);
  // Basket presentation state
  const pinboardEntities = useViewerStore((state) => state.pinboardEntities);
  const basketViewCount = useViewerStore((state) => state.basketViews.length);
  const basketPresentationVisible = useViewerStore((state) => state.basketPresentationVisible);
  const toggleBasketPresentationVisible = useViewerStore((state) => state.toggleBasketPresentationVisible);
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
  // SpaceMouse panel state (3D mouse navigation, #1677)
  const spaceMousePanelOpen = useViewerStore((state) => state.spaceMousePanelOpen);
  const toggleSpaceMousePanel = useViewerStore((state) => state.toggleSpaceMousePanel);
  const spaceMouseConnected = useViewerStore((state) => state.spaceMouseConnected);

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

  return (
    <div className="flex items-center gap-1 px-2 h-12 border-b bg-white dark:bg-black border-zinc-200 dark:border-zinc-800 relative z-50">
      {/* ── File Operations (hidden <input> fallbacks live in the shared hook) ── */}
      {fileInputs}

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

      {/* Share — link-based multiuser collaboration (behind the collab flag) */}
      {collabEnabled && (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={!hasModelsLoaded}
                onClick={openShareDialog}
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
          {/* Room panel toggle — live presence + management, only while in a room. */}
          {collabRoomId && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={collabPanelVisible ? 'secondary' : 'ghost'}
                  size="icon-sm"
                  onClick={() => useViewerStore.getState().toggleWorkspacePanel('collab')}
                  className="relative"
                  aria-label="Room"
                  aria-pressed={collabPanelVisible}
                >
                  <Users className="h-4 w-4" />
                  {collabPeerCount > 0 && (
                    <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-emerald-500 px-1 text-[9px] font-medium text-white">
                      {collabPeerCount + 1}
                    </span>
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Room</TooltipContent>
            </Tooltip>
          )}
        </>
      )}

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
          <DropdownMenuCheckboxItem
            checked={activeWorkspacePanels.has('layers')}
            onCheckedChange={() => useViewerStore.getState().toggleWorkspacePanel('layers')}
          >
            <Layers className="h-4 w-4 mr-2" />
            Layer Stack
          </DropdownMenuCheckboxItem>
          {collabEnabled && (
            <DropdownMenuCheckboxItem
              checked={activeWorkspacePanels.has('collab')}
              onCheckedChange={() => useViewerStore.getState().toggleWorkspacePanel('collab')}
            >
              <Users className="h-4 w-4 mr-2" />
              Collaboration Room
            </DropdownMenuCheckboxItem>
          )}
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
            disabled={!canEditInSession}
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
          {canEditInSession ? (
            <>
              {editEnabled ? 'Exit Edit Mode' : 'Edit Mode'} <span className="opacity-50">E</span>
            </>
          ) : (
            'Editing requires editor access in this shared session'
          )}
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
        {/* Body shared with the ribbon's View tab — class toggles,
            Model/Types switch, and load-time geometry settings. */}
        <ClassVisibilityMenuContent align="start" />
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

      {/* SpaceMouse panel — connect a 3Dconnexion 3D mouse over WebHID and
          tune its sensitivity (#1677). */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={spaceMousePanelOpen ? 'default' : 'ghost'}
            size="icon-sm"
            aria-label={spaceMousePanelOpen ? 'Close SpaceMouse panel' : 'Open SpaceMouse panel'}
            aria-pressed={spaceMousePanelOpen}
            onClick={(e) => {
              (e.currentTarget as HTMLButtonElement).blur();
              toggleSpaceMousePanel();
            }}
            className={cn(
              (spaceMousePanelOpen || spaceMouseConnected)
                && 'bg-teal-600 text-white hover:bg-teal-500',
            )}
          >
            <Move3d className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>SpaceMouse</TooltipContent>
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
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Toolbar
          </DropdownMenuLabel>
          {/* Issue #1686: jump to the tabbed, IFCFlux-style ribbon. This
              menu only renders in the classic style, so the box is never
              checked here — the ribbon's View tab has the way back. */}
          <DropdownMenuCheckboxItem
            checked={false}
            onCheckedChange={() => setToolbarStyle('ribbon')}
          >
            <PanelTop className="h-4 w-4 mr-2" />
            Ribbon toolbar
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
