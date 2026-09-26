/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { hasWorkspaceHistory, replayWorkspaceHistory } from '@/lib/model-placement/history';

import { AuthorPanelMenuItems } from './toolbar/AuthorPanelMenuItems.js';
import { BottomPanelMenuItems } from './toolbar/BottomPanelMenuItems.js';
import React, { useCallback, useMemo } from 'react';
import { FolderOpen, Download, MousePointer2, PersonStanding, Ruler, Scissors, StickyNote, Eye, EyeOff, Equal, Crosshair, GitCompareArrows, Home, Maximize2, Grid3x3, HelpCircle, Info, Plus, MessageSquare, ClipboardCheck, Palette, Orbit, Layout, Layers, LayoutTemplate, Globe2, Sun, Move, Move3d, PenLine, PanelTop, Undo2, Redo2, RefreshCw, Share2, Users } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
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
} from '@/components/ui/dropdown-menu';
import { Progress } from '@/components/ui/progress';
import { selectActiveLoadProgress } from '@/store/slices/loadingSlice';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { useEffectiveSkyEnabled } from '@/hooks/useEffectiveSkyEnabled';
import { goHomeFromStore, resetVisibilityForHomeFromStore } from '@/store/homeView';
import { hideSelectionFromStore } from '@/store/hideSelection';
import { executeBasketIsolate } from '@/store/basket/basketCommands';
import { useIfc } from '@/hooks/useIfc';
import { cn } from '@/lib/utils';
import { Filter, Upload, Pencil, DraftingCompass, Box, Cloud, FileWarning, Coins, Settings } from 'lucide-react';
import { BulkPropertyEditor } from './BulkPropertyEditor';
import { DataConnector } from './DataConnector';
import { ExportChangesButton } from './ExportChangesButton';
import { isCollabEnabled } from '@/lib/collab/config';
import { SearchInline } from './SearchInline';
import { ThemeSwitch } from './ThemeSwitch';
import { ExtensionToolbarSlot } from '@/components/extensions/ExtensionToolbarSlot';
import { tourAnchor, toolAnchor } from '@/lib/tours/anchors';
import { openSettings } from '@/lib/settings/open-settings';
import { useFileCommands } from './toolbar/useFileCommands';
import { ClassicExportMenuItems } from './toolbar/ClassicExportMenuItems';
import { useWorkspacePanelControls } from './toolbar/useWorkspacePanelControls';
import { ClassVisibilityMenuContent } from './toolbar/ClassVisibilityMenu';
import { CameraCommandMenuItems } from './toolbar/CameraCommands';

type Tool = 'select' | 'walk' | 'measure' | 'section' | 'annotate' | 'addElement' | 'split' | 'spaceSketch';

/** Edit mode's latched state: the interaction accent, never a mode-specific hue (#5489). */
const EDIT_ACTIVE_CLASS = 'bg-overlay-accent text-overlay-halo hover:bg-overlay-accent/90';

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
  const { t } = useTranslation();
  // Undo/redo replay authoring mutations, so they honour the same collab
  // role gate as edit mode (null role = single-user, always editable).
  const collabRole = useViewerStore((s) => s.collabRole);
  const canEditInSession = collabRole === null || collabRole === 'editor' || collabRole === 'admin';

  const hasUndo = useViewerStore(state => hasWorkspaceHistory(state, 'undo'));
  const canUndo = canEditInSession && hasUndo;
  const hasRedo = useViewerStore(state => hasWorkspaceHistory(state, 'redo'));
  const canRedo = canEditInSession && hasRedo;

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
              replayWorkspaceHistory(useViewerStore.getState(), 'undo');
            }}
            aria-label={t('mainToolbar.undo')}
          >
            <Undo2 className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {t('mainToolbar.undo')} <span className="ml-2 text-xs opacity-60">⌘Z</span>
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
              replayWorkspaceHistory(useViewerStore.getState(), 'redo');
            }}
            aria-label={t('mainToolbar.redo')}
          >
            <Redo2 className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {t('mainToolbar.redo')} <span className="ml-2 text-xs opacity-60">⌘⇧Z</span>
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
  const { t } = useTranslation();
  // Collaboration: the Share button is gated behind the collab feature flag.
  // The ShareDialog + its `ifc-lite:open-share-dialog` listener live in
  // useFileCommands (always mounted for the active toolbar style).
  const collabEnabled = useMemo(() => isCollabEnabled(), []);
  const collabPeerCount = useViewerStore((s) => s.collabPeers.length);
  const collabRoomId = useViewerStore((s) => s.collabRoomId);
  const collabPanelVisible = useViewerStore((s) => s.collabPanelVisible);
  const {
    loading,
    geometryProgress,
    metadataProgress,
    geometryResult,
    ifcDataStore,
    models,
  } = useIfc();
  const activeProgress = useViewerStore(selectActiveLoadProgress);

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
  const {
    activeWorkspacePanels,
    workspacePanelLabel,
    handleToggleBottomPanel,
    handleToggleRightPanel,
    handleToggleAnalysisExtension,
    rightAnalysisExtensions,
    bottomAnalysisExtensions,
  } = useWorkspacePanelControls('classic');

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
  const presentationOpen = activeWorkspacePanels.has('presentation'); // same source as the ribbon's Present button (#5508)
  // Cesium 3D overlay state
  const cesiumAvailable = useViewerStore((state) => state.cesiumAvailable);
  const cesiumEnabled = useViewerStore((state) => state.cesiumEnabled);
  const toggleCesium = useViewerStore((state) => state.toggleCesium);
  const cesiumPlacementEditMode = useViewerStore((state) => state.cesiumPlacementEditMode);
  const setCesiumPlacementEditMode = useViewerStore((state) => state.setCesiumPlacementEditMode);
  // Environment panel state (sky, lighting presets, sun-path study, #5506)
  const solarEnabled = useViewerStore((state) => state.solarEnabled);
  // Effective, not raw: the Cesium world context defaults this on (#4771).
  const envSkyEnabled = useEffectiveSkyEnabled();
  const envPreset = useViewerStore((state) => state.envPreset);
  // SpaceMouse connection state (3D mouse navigation, #1677); its settings
  // moved to Preferences → Navigation (#5509).
  const spaceMouseConnected = useViewerStore((state) => state.spaceMouseConnected);

  // Selection chip uses the multi-select size when present; falls back
  // to the single legacy `selectedEntityId` so the chip still says
  // "1 selected" for the click-to-pick flow that hasn't migrated.
  const selectionCount = selectedEntityIds.size > 0
    ? selectedEntityIds.size
    : (selectedEntityId !== null ? 1 : 0);


  const handleShowAll = useCallback(() => {
    resetVisibilityForHomeFromStore('show_all');
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
            aria-label={t('mainToolbar.openAriaLabel')}
            onClick={(e) => {
              // Blur button to close tooltip before opening file dialog
              (e.currentTarget as HTMLButtonElement).blur();
              void handleOpenClick();
            }}
            disabled={loading}
          >
            {loading ? (
              <Spinner size="md" />
            ) : (
              <FolderOpen className="h-4 w-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('mainToolbar.openTooltip')}</TooltipContent>
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
              aria-label={models.size > 1 ? t('mainToolbar.refreshModels') : t('mainToolbar.refreshModel')}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{models.size > 1 ? t('mainToolbar.refreshModels') : t('mainToolbar.refreshModel')}</TooltipContent>
        </Tooltip>
      )}

      {/* Add Model button - only shown when models are loaded */}
      {hasModelsLoaded && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('mainToolbar.addModelAriaLabel')}
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
          <TooltipContent>{t('mainToolbar.addModelTooltip')}</TooltipContent>
        </Tooltip>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {/* Gate on any loaded model, not the legacy single-model geometryResult:
              federated / multi-model sessions populate `models` but leave
              geometryResult null, which would hide the whole export menu (incl. KMZ). */}
          <Button variant="ghost" size="icon-sm" aria-label={t('mainToolbar.exportAriaLabel')} disabled={!hasModelsLoaded && !ifcDataStore}>
            <Download className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <ClassicExportMenuItems />
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Edit Menu - Bulk editing and data import */}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('mainToolbar.editPropertiesAriaLabel')} disabled={!ifcDataStore}>
                <Pencil className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{t('mainToolbar.editPropertiesTooltip')}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent>
          <BulkPropertyEditor
            trigger={
              <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                <Filter className="h-4 w-4 mr-2" />
                {t('mainToolbar.bulkPropertyEditor')}
              </DropdownMenuItem>
            }
          />
          <DataConnector
            trigger={
              <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                <Upload className="h-4 w-4 mr-2" />
                {t('mainToolbar.importDataCsv')}
              </DropdownMenuItem>
            }
          />
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Export modified IFC… Button - shows when there are pending mutations */}
      <ExportChangesButton surface="classic" />

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
                aria-label={t('mainToolbar.share')}
              >
                <Share2 className="h-4 w-4" />
                {collabPeerCount > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-medium text-primary-foreground">
                    {collabPeerCount + 1}
                  </span>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('mainToolbar.share')}</TooltipContent>
          </Tooltip>
          {/* Room panel toggle — live presence + management, only while in a room. */}
          {collabRoomId && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={collabPanelVisible ? 'secondary' : 'ghost'}
                  size="icon-sm"
                  onClick={() => useViewerStore.getState().toggleWorkspacePanel('collab', 'classic')}
                  className="relative"
                  aria-label={t('mainToolbar.room')}
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
              <TooltipContent>{t('mainToolbar.room')}</TooltipContent>
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
                aria-label={workspacePanelLabel ? t('mainToolbar.panelsWithLabel', { label: workspacePanelLabel }) : t('mainToolbar.panels')}
                className={cn(activeWorkspacePanels.size > 0 && 'bg-primary text-primary-foreground')}
              >
                <Layout className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{workspacePanelLabel ? t('mainToolbar.panelsWithLabel', { label: workspacePanelLabel }) : t('mainToolbar.panels')}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="start" className="w-56">
          <BottomPanelMenuItems active={activeWorkspacePanels} onToggle={handleToggleBottomPanel} />
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {t('mainToolbar.inspectValidate')}
          </DropdownMenuLabel>
          <DropdownMenuCheckboxItem
            checked={activeWorkspacePanels.has('bcf')}
            onCheckedChange={() => handleToggleRightPanel('bcf')}
          >
            <MessageSquare className="h-4 w-4 mr-2" />
            {t('mainToolbar.bcfTopics')}
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={activeWorkspacePanels.has('validation')}
            onCheckedChange={() => handleToggleRightPanel('validation')}
          >
            <ClipboardCheck className="h-4 w-4 mr-2" />
            {t('mainToolbar.idsValidation')}
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={activeWorkspacePanels.has('lens')}
            onCheckedChange={() => handleToggleRightPanel('lens')}
          >
            <Palette className="h-4 w-4 mr-2" />
            {t('mainToolbar.lensRules')}
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={activeWorkspacePanels.has('clash')}
            onCheckedChange={() => handleToggleRightPanel('clash')}
          >
            <Crosshair className="h-4 w-4 mr-2" />
            {t('mainToolbar.clashDetection')}
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={activeWorkspacePanels.has('compare')}
            onCheckedChange={() => handleToggleRightPanel('compare')}
          >
            <GitCompareArrows className="h-4 w-4 mr-2" />
            {t('mainToolbar.compareModels')}
          </DropdownMenuCheckboxItem>
          {/* Cloud sources (CDE integrations): the ActivityBar rail was its
              only entry point, exactly as Location Zones was before #2508.
              The ribbon files it under File, where models come from. */}
          <DropdownMenuCheckboxItem
            checked={activeWorkspacePanels.has('sources')}
            onCheckedChange={() => handleToggleRightPanel('sources')}
          >
            <Cloud className="h-4 w-4 mr-2" />
            {t('mainToolbar.cloudSources')}
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={activeWorkspacePanels.has('layers')}
            onCheckedChange={() => useViewerStore.getState().toggleWorkspacePanel('layers', 'classic')}
          >
            <Layers className="h-4 w-4 mr-2" />
            {t('mainToolbar.layerStack')}
          </DropdownMenuCheckboxItem>
          {/* Location zones (#1810), reachable from a toolbar for the first
              time (#2508): the ActivityBar rail was its only entry point. */}
          <DropdownMenuCheckboxItem
            checked={activeWorkspacePanels.has('zones')}
            onCheckedChange={() => useViewerStore.getState().toggleWorkspacePanel('zones', 'classic')}
          >
            <Box className="h-4 w-4 mr-2" />
            {t('mainToolbar.locationZones')}
          </DropdownMenuCheckboxItem>
          {/* Per-model load report (#3927): reachable from a toolbar for the
              first time — it shipped ribbon-only, the ActivityBar rail was
              classic's only entry point. */}
          <DropdownMenuCheckboxItem
            checked={activeWorkspacePanels.has('loadReport')}
            onCheckedChange={() => useViewerStore.getState().toggleWorkspacePanel('loadReport', 'classic')}
          >
            <FileWarning className="h-4 w-4 mr-2" />
            {t('mainToolbar.loadReport')}
          </DropdownMenuCheckboxItem>
          {/* IFC 5D cost inspector (#4858): reachable from a toolbar for the
              first time — the ActivityBar rail was its only entry point. */}
          <DropdownMenuCheckboxItem
            checked={activeWorkspacePanels.has('cost')}
            onCheckedChange={() => useViewerStore.getState().toggleWorkspacePanel('cost', 'classic')}
          >
            <Coins className="h-4 w-4 mr-2" />
            {t('mainToolbar.cost')}
          </DropdownMenuCheckboxItem>
          {collabEnabled && (
            <DropdownMenuCheckboxItem
              checked={activeWorkspacePanels.has('collab')}
              onCheckedChange={() => useViewerStore.getState().toggleWorkspacePanel('collab', 'classic')}
            >
              <Users className="h-4 w-4 mr-2" />
              {t('mainToolbar.collaborationRoom')}
            </DropdownMenuCheckboxItem>
          )}
          <DropdownMenuSeparator />
          <AuthorPanelMenuItems active={activeWorkspacePanels} canEdit={canEditInSession} onToggle={handleToggleRightPanel} />
          {(rightAnalysisExtensions.length > 0 || bottomAnalysisExtensions.length > 0) && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {t('mainToolbar.analysisExtensions')}
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
      <ToolButton tool="select" icon={MousePointer2} label={t('mainToolbar.toolSelect')} shortcut="V" activeTool={activeTool} onToolChange={setActiveTool} />
      <ToolButton tool="walk" icon={PersonStanding} label={t('mainToolbar.toolWalk')} shortcut="C" activeTool={activeTool} onToolChange={setActiveTool} />

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
            aria-label={editEnabled ? t('mainToolbar.editModeExitAriaLabel') : t('mainToolbar.editModeEnterAriaLabel')}
            aria-pressed={editEnabled}
            onClick={(e) => {
              (e.currentTarget as HTMLButtonElement).blur();
              toggleEditEnabled();
            }}
            className={cn(editEnabled && EDIT_ACTIVE_CLASS)}
          >
            <PenLine className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {canEditInSession ? (
            <>
              {editEnabled ? t('mainToolbar.editModeExitTooltip') : t('mainToolbar.editModeEnterTooltip')} <span className="opacity-50">{t('mainToolbar.editModeShortcutHint')}</span>
            </>
          ) : (
            t('mainToolbar.editModeLocked')
          )}
        </TooltipContent>
      </Tooltip>

      {/* Undo / Redo — always visible (any authoring op pushes a
          mutation; the buttons read disabled when the active
          model's undo stack is empty). Pinned next to Edit so the
          user has a one-click recovery for any change. */}
      <UndoRedoButtons />

      {/* Space Sketch is authoring chrome (it bakes IfcSpace entities), so
          it only surfaces in edit mode, next to the Edit pill with the same
          accent and a drafting icon distinct from Panels/Basket/View. */}
      {editEnabled && (
        <ToolButton
          tool="spaceSketch"
          icon={DraftingCompass}
          label={t('mainToolbar.spaceSketch')}
          activeTool={activeTool}
          onToolChange={setActiveTool}
          activeAccentClass={EDIT_ACTIVE_CLASS}
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
      <ToolButton tool="measure" icon={Ruler} label={t('mainToolbar.toolMeasure')} shortcut="M" activeTool={activeTool} onToolChange={setActiveTool} />
      <ToolButton tool="section" icon={Scissors} label={t('mainToolbar.toolSection')} shortcut="X" activeTool={activeTool} onToolChange={setActiveTool} />
      <ToolButton
        tool="annotate"
        icon={StickyNote}
        label={t('mainToolbar.toolAnnotate')}
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
            variant={presentationOpen ? 'default' : 'ghost'}
            size="icon-sm"
            aria-label={presentationOpen ? t('mainToolbar.presentationHide') : t('mainToolbar.presentationShow')}
            aria-pressed={presentationOpen}
            onClick={(e) => {
              (e.currentTarget as HTMLButtonElement).blur();
              handleToggleBottomPanel('presentation'); // bottom-panel table (#5508), not the raw flag toggle
            }}
            disabled={models.size === 0 && !geometryResult}
            className={cn(
              (presentationOpen || pinboardEntities.size > 0) && 'relative',
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
          {t('mainToolbar.presentationTooltip', { views: basketViewCount, entities: pinboardEntities.size })}
        </TooltipContent>
      </Tooltip>

      {/*
        Selection action cluster — Hide / Frame / Isolate only make
        sense with a selection, so they don't get to live in the
        toolbar chrome at rest. When a user selects anything, the
        slot opens with a "N selected" pill + the three actions next
        to it. Hotkeys (Del / F / I) keep working regardless of
        whether the chip is rendered, so power users feel no change.

        The chip lives in the same separator zone the buttons used to
        occupy so the spatial location is familiar to muscle memory.
      */}
      {selectionCount > 0 && (
        <div
          className="flex items-center gap-0.5 pl-1.5 pr-0.5 rounded-md border border-primary/30 bg-primary/5 transition-opacity duration-150"
          role="group"
          aria-label={t('mainToolbar.selectionActionsAriaLabel', { count: selectionCount })}
        >
          <span
            className="text-[10px] font-semibold tabular-nums text-primary uppercase tracking-wide whitespace-nowrap pr-1.5"
            aria-hidden="true"
          >
            {t('mainToolbar.selectionCountBadge', { count: selectionCount })}
          </span>
          <ActionButton icon={Equal} label={t('mainToolbar.isolateSelection')} onClick={handleIsolate} shortcut="I" />
          <ActionButton icon={EyeOff} label={t('mainToolbar.hideSelection')} onClick={hideSelectionFromStore} shortcut="Del / Space" />
          <ActionButton
            icon={Crosshair}
            label={t('mainToolbar.frameSelection')}
            onClick={() => cameraCallbacks.frameSelection?.()}
            shortcut="F"
          />
        </div>
      )}

      <ActionButton icon={Eye} label={t('mainToolbar.showAll')} onClick={handleShowAll} shortcut="A" />
      <ActionButton icon={Maximize2} label={t('mainToolbar.fitAll')} onClick={() => cameraCallbacks.fitAll?.()} shortcut="Z" />

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
                aria-label={mergeLayers ? t('mainToolbar.visibilityMerged') : t('mainToolbar.visibility')}
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
            {mergeLayers ? t('mainToolbar.visibilityMergedTooltip') : t('mainToolbar.visibility')}
          </TooltipContent>
        </Tooltip>
        {/* Body shared with the ribbon's View tab — class toggles,
            Model/Types switch, and load-time geometry settings. */}
        <ClassVisibilityMenuContent align="start" />
      </DropdownMenu>

      <Separator orientation="vertical" className="h-6 mx-1" />

      {/* ── Camera & View ── */}
      <ActionButton icon={Home} label={t('mainToolbar.home')} onClick={handleHome} shortcut="H" />

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
                aria-label={cesiumEnabled ? t('mainToolbar.cesiumHide') : t('mainToolbar.cesiumShow')}
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
              {cesiumEnabled ? t('mainToolbar.cesiumHide') : t('mainToolbar.cesiumShow')}
            </TooltipContent>
          </Tooltip>
          {cesiumEnabled && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={cesiumPlacementEditMode ? 'default' : 'ghost'}
                  size="icon-sm"
                  aria-label={cesiumPlacementEditMode ? t('mainToolbar.moveGeorefStop') : t('mainToolbar.moveGeorefAriaLabel')}
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
                {cesiumPlacementEditMode ? t('mainToolbar.moveGeorefStop') : t('mainToolbar.moveGeorefTooltip')}
              </TooltipContent>
            </Tooltip>
          )}
        </>
      )}

      {/* Environment panel — sky, lighting presets and the sun-path study
          (#5506: a docked side panel, not a floating one). Available for
          every model, georeferenced or not. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={activeWorkspacePanels.has('environment') ? 'default' : 'ghost'}
            size="icon-sm"
            aria-label={activeWorkspacePanels.has('environment') ? t('mainToolbar.sunSkyClose') : t('mainToolbar.sunSkyOpen')}
            aria-pressed={activeWorkspacePanels.has('environment')}
            onClick={(e) => {
              (e.currentTarget as HTMLButtonElement).blur();
              useViewerStore.getState().toggleWorkspacePanel('environment', 'classic');
            }}
            className={cn(
              (activeWorkspacePanels.has('environment') || solarEnabled || envSkyEnabled || envPreset !== 'default')
                && 'bg-amber-500 text-zinc-950 hover:bg-amber-400',
            )}
          >
            <Sun className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('mainToolbar.sunSkyTooltip')}</TooltipContent>
      </Tooltip>

      {/* SpaceMouse (#1677): its controls live in Settings → Display →
          Navigation (#5509, #5857); this opens Settings there. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={spaceMouseConnected ? 'default' : 'ghost'}
            size="icon-sm"
            aria-label={t('mainToolbar.spaceMouseOpen')}
            onClick={(e) => {
              (e.currentTarget as HTMLButtonElement).blur();
              openSettings('display');
            }}
            className={cn(spaceMouseConnected && 'bg-primary text-primary-foreground hover:bg-primary/90')}
          >
            <Move3d className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('mainToolbar.spaceMouseTooltip')}</TooltipContent>
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
                aria-label={t('mainToolbar.viewOptions')}
                className={cn((projectionMode === 'orthographic' || hoverTooltipsEnabled) && 'bg-primary text-primary-foreground')}
              >
                <Grid3x3 className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{t('mainToolbar.viewOptions')}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-56">
          {/* Camera, preset views and the 90° rotations — rendered from the
              shared command list so this menu can't fall behind the ribbon's
              View tab (it did: rotate was ribbon-only, see CameraCommands). */}
          <CameraCommandMenuItems />
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {t('mainToolbar.projection')}
          </DropdownMenuLabel>
          <DropdownMenuCheckboxItem
            checked={projectionMode === 'orthographic'}
            onCheckedChange={() => toggleProjectionMode()}
          >
            <Orbit className="h-4 w-4 mr-2" />
            {t('mainToolbar.orthographic')}
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {t('mainToolbar.helpers')}
          </DropdownMenuLabel>
          <DropdownMenuCheckboxItem
            checked={hoverTooltipsEnabled}
            onCheckedChange={() => toggleHoverTooltips()}
          >
            <Info className="h-4 w-4 mr-2" />
            {t('mainToolbar.hoverTooltips')}
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => openSettings()}><Settings className="h-4 w-4 mr-2" />{t('mainToolbar.openSettings')}</DropdownMenuItem>
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {t('mainToolbar.toolbarLabel')}
          </DropdownMenuLabel>
          {/* Issue #1686: jump to the tabbed, IFCFlux-style ribbon. This
              menu only renders in the classic style, so the box is never
              checked here — the ribbon's View tab has the way back. */}
          <DropdownMenuCheckboxItem
            checked={false}
            onCheckedChange={() => setToolbarStyle('ribbon')}
          >
            <PanelTop className="h-4 w-4 mr-2" />
            {t('mainToolbar.ribbonToolbarMenuItem')}
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Extension toolbar contributions (right-aligned) */}
      <ExtensionToolbarSlot slot="toolbar.right" />

      {/* Loading Progress */}
      {loading && activeProgress && (
        <div className="flex items-center gap-2 mr-4">
          <span className="text-xs text-muted-foreground">
            {activeProgress.phase}
            {geometryProgress && metadataProgress ? ` | ${metadataProgress.phase}` : ''}
          </span>
          {activeProgress.indeterminate ? (
            <Spinner size="sm" className="text-muted-foreground" />
          ) : (
            <>
              <Progress value={activeProgress.percent} className="w-32 h-2" />
              <span className="text-xs text-muted-foreground">{Math.round(activeProgress.percent)}%</span>
            </>
          )}
        </div>
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
          <TooltipContent>{t('mainToolbar.themeTooltip')}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="rounded-full"
              aria-label={t('mainToolbar.infoAriaLabel')}
              onClick={() => onShowShortcuts?.()}
            >
              <HelpCircle className="!h-[22px] !w-[22px]" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('mainToolbar.infoTooltip')}</TooltipContent>
        </Tooltip>
      </div>

    </div>
  );
}
