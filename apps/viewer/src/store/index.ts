/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Combined Zustand store for viewer state
 *
 * This file combines all domain-specific slices into a single store.
 * Each slice manages a specific domain of state (loading, selection, etc.)
 */

import { create } from 'zustand';

// Import slices
import { createLoadingSlice, type LoadingSlice } from './slices/loadingSlice.js';
import { createSelectionSlice, type SelectionSlice } from './slices/selectionSlice.js';
import { createVisibilitySlice, type VisibilitySlice } from './slices/visibilitySlice.js';
import { createUISlice, type UISlice } from './slices/uiSlice.js';
import { createHoverSlice, type HoverSlice } from './slices/hoverSlice.js';
import { createCameraSlice, type CameraSlice } from './slices/cameraSlice.js';
import { createSectionSlice, type SectionSlice } from './slices/sectionSlice.js';
export { customPlaneCenter, loadLastSectionMode } from './slices/sectionSlice.js';
export type { LastSectionMode } from './slices/sectionSlice.js';
import { createMeasurementSlice, type MeasurementSlice } from './slices/measurementSlice.js';
import { createDataSlice, type DataSlice } from './slices/dataSlice.js';
import { createModelSlice, type ModelSlice } from './slices/modelSlice.js';
import { createMutationSlice, type MutationSlice } from './slices/mutationSlice.js';
import { createDrawing2DSlice, type Drawing2DSlice } from './slices/drawing2DSlice.js';
import { createSheetSlice, type SheetSlice } from './slices/sheetSlice.js';
import { createBcfSlice, type BCFSlice } from './slices/bcfSlice.js';
import { createIdsSlice, type IDSSlice } from './slices/idsSlice.js';
import { createExtensionsSlice, type ExtensionsSlice } from './slices/extensionsSlice.js';
import { createListSlice, type ListSlice } from './slices/listSlice.js';
import { createPinboardSlice, type PinboardSlice } from './slices/pinboardSlice.js';
import { createLensSlice, type LensSlice } from './slices/lensSlice.js';
import { createClashSlice, type ClashSlice } from './slices/clashSlice.js';
import { createCompareSlice, type CompareSlice } from './slices/compareSlice.js';
import { createDockSlice, type DockSlice } from './slices/dockSlice.js';
import { createSidebarSlice, type SidebarSlice } from './slices/sidebarSlice.js';
import { isBottomPanel, type WorkspacePanelId, type BottomPanelId } from '@/lib/panels/registry';
import { createScriptSlice, type ScriptSlice } from './slices/scriptSlice.js';
import { createChatSlice, type ChatSlice } from './slices/chatSlice.js';
import { createCesiumSlice, type CesiumSlice } from './slices/cesiumSlice.js';
import { createSolarSlice, type SolarSlice } from './slices/solarSlice.js';
import { createEnvironmentSlice, type EnvironmentSlice } from './slices/environmentSlice.js';
import { createScheduleSlice, type ScheduleSlice } from './slices/scheduleSlice.js';
import { createPlaybackSlice, type PlaybackSlice } from './slices/playbackSlice.js';
import { createOverlaySlice, type OverlaySlice } from './slices/overlaySlice.js';
import { createSearchSlice, type SearchSlice } from './slices/searchSlice.js';
import { createAnnotationsSlice, type AnnotationsSlice } from './slices/annotationsSlice.js';
import { createCollabSlice, type CollabSlice } from './slices/collabSlice.js';
import { createAddElementSlice, type AddElementSlice } from './slices/addElementSlice.js';
import { createSplitToolSlice, type SplitToolSlice } from './slices/splitToolSlice.js';
import { createLevelDisplaySlice, type LevelDisplaySlice } from './slices/levelDisplaySlice.js';
import { createPointCloudSlice, type PointCloudSlice, POINT_CLOUD_DEFAULTS } from './slices/pointCloudSlice.js';
import { createUnitDisplaySlice, type UnitDisplaySlice } from './slices/unitDisplaySlice.js';
import { createSpaceMouseSlice, type SpaceMouseSlice } from './slices/spaceMouseSlice.js';
import { createLayerStackSlice, type LayerStackSlice } from './slices/layerStackSlice.js';
import { invalidateVisibleBasketCache } from './basketVisibleSet.js';

// Import constants for reset function
import { CAMERA_DEFAULTS, SECTION_PLANE_DEFAULTS, UI_DEFAULTS, getPersistedTypeVisibility, getPersistedTypeViewMode } from './constants.js';

// Re-export types for consumers
export type * from './types.js';

// Explicitly re-export multi-model types that need to be imported by name
export type { EntityRef, SchemaVersion, FederatedModel, MeasurementConstraintEdge, OrthogonalAxis, SectionCapStyle, SectionCapHatchId, SectionPlane, SectionPlaneAxis } from './types.js';

// Re-export utility functions for entity references
export { entityRefToString, stringToEntityRef, entityRefEquals, isIfcxDataStore } from './types.js';

// Re-export single source of truth for globalId → EntityRef resolution
export { resolveEntityRef } from './resolveEntityRef.js';
export { fromGlobalIdFromModels, toGlobalIdFromModels, toGlobalIdForRef } from './globalId.js';
export type { ForwardModelMapLike } from './globalId.js';

// Re-export Drawing2D types
export type { Drawing2DState, Drawing2DStatus, Annotation2DTool, PolygonArea2DResult, TextAnnotation2D, CloudAnnotation2D, SelectedAnnotation2D } from './slices/drawing2DSlice.js';

// Re-export Sheet types
export type { SheetState } from './slices/sheetSlice.js';

// Re-export Collab types
export type { CollabSlice, CollabRole, CollabStatus, StartCollabOptions } from './slices/collabSlice.js';

// Re-export BCF types
export type { BCFSlice, BCFSliceState } from './slices/bcfSlice.js';

// Re-export IDS types
export type { IDSSlice, IDSSliceState, IDSDisplayOptions, IDSFilterMode } from './slices/idsSlice.js';

// Re-export List types
export type { ListSlice } from './slices/listSlice.js';

// Re-export Pinboard types
export type { PinboardSlice } from './slices/pinboardSlice.js';

// Re-export Lens types
export type { LensSlice, Lens, LensRule, LensCriteria } from './slices/lensSlice.js';
export type { CompareSlice, CompareResult } from './slices/compareSlice.js';
export type { LayerStackSlice, LayerStackEntry, LayerStackDiffResult, LayerAuthorKind } from './slices/layerStackSlice.js';
export type { DockSlice, FloatingPanelState, SnapZone } from './slices/dockSlice.js';
export type { SidebarSlice, SidebarMode, SidebarLayoutSnapshot } from './slices/sidebarSlice.js';

// Re-export Script types
export type { ScriptSlice } from './slices/scriptSlice.js';

// Re-export Chat types
export type { ChatSlice } from './slices/chatSlice.js';

// Re-export Cesium types
export type { CesiumSlice, CesiumDataSource, CesiumPlacementDraft } from './slices/cesiumSlice.js';

// Re-export Schedule (4D) types + selectors
export type { ScheduleSlice, ScheduleTimeRange, GanttTimeScale } from './slices/scheduleSlice.js';
export type { PlaybackSlice } from './slices/playbackSlice.js';
export type { OverlaySlice, OverlayLayer, RGBA as OverlayRGBA } from './slices/overlaySlice.js';
export { composeLayers as composeOverlayLayers } from './slices/overlaySlice.js';
export {
  computeScheduleRange,
  computeHiddenProductIds,
  computeActiveProductIds,
  countGeneratedTasks,
  taskStartEpoch,
  taskFinishEpoch,
  parseIsoDate,
} from './slices/scheduleSlice.js';
export { resolveScheduleSourceModelId } from './slices/schedule-edit-helpers.js';

// Combined store type
export type ViewerState = LoadingSlice &
  SelectionSlice &
  VisibilitySlice &
  UISlice &
  HoverSlice &
  CameraSlice &
  SectionSlice &
  MeasurementSlice &
  DataSlice &
  ModelSlice &
  MutationSlice &
  Drawing2DSlice &
  SheetSlice &
  BCFSlice &
  IDSSlice &
  ListSlice &
  PinboardSlice &
  LensSlice &
  ClashSlice &
  CompareSlice &
  LayerStackSlice &
  DockSlice &
  SidebarSlice &
  ScriptSlice &
  ChatSlice &
  CesiumSlice &
  SolarSlice &
  EnvironmentSlice &
  ScheduleSlice &
  PlaybackSlice &
  OverlaySlice &
  SearchSlice &
  AnnotationsSlice &
  CollabSlice &
  AddElementSlice &
  SplitToolSlice &
  LevelDisplaySlice &
  PointCloudSlice &
  UnitDisplaySlice &
  SpaceMouseSlice &
  ExtensionsSlice & {
    resetViewerState: () => void;
    /**
     * Open one right-side analysis panel and close the others, so the chosen
     * panel is always the topmost/active one. The right panel renders a single
     * mutually-exclusive chain (lens → clash → ids → bcf → extensions), so
     * leaving a sibling flag set would keep the higher-precedence panel on top
     * (the cause of "I have to close clash before I see BCF"). Also un-collapses
     * the right panel. Routed through by the toolbar, command palette, and the
     * BCF overlay so every entry point behaves identically.
     */
    openWorkspacePanel: (panel: Exclude<WorkspacePanelId, 'properties'>) => void;
    /**
     * Show a workspace panel docked in the sidebar, un-floating / re-docking it
     * first if it was popped out (#1200/#1201/#1208). Accepts `properties` (the
     * Information fallback, shown by closing every other panel) on top of the
     * analysis + tool panels `openWorkspacePanel` handles. Shared by the
     * activity bar, the Alt+N shortcuts, the command palette and the
     * floating / window hosts' re-dock action.
     */
    showWorkspacePanel: (panel: WorkspacePanelId) => void;
    /**
     * Toggle a sidebar panel: if it is the active docked panel, close it back
     * to Information; otherwise open it. The single entry point the activity
     * bar, toolbar and command palette use so a second click always closes.
     */
    toggleWorkspacePanel: (panel: WorkspacePanelId) => void;
    /**
     * Toggle a bottom-strip panel (Script / Schedule / Lists). These are
     * launched from the same sidebar rail but open in the BOTTOM panel —
     * mutually exclusive among themselves, independent of the single-tenant
     * right pane (so a side panel + a bottom panel can be open at once).
     */
    toggleBottomPanel: (panel: BottomPanelId) => void;
    /**
     * Open a panel in its home region: side panels dock in the right pane,
     * Script / Schedule / Lists open in the bottom strip. The rail and Alt+N
     * route through here so each panel lands where it belongs.
     */
    openPanelInHome: (panel: WorkspacePanelId) => void;
  };

/**
 * Main viewer store combining all slices
 */
const createViewerStore = () => create<ViewerState>()((...args) => ({
  // Spread all slices
  ...createLoadingSlice(...args),
  ...createSelectionSlice(...args),
  ...createVisibilitySlice(...args),
  ...createUISlice(...args),
  ...createHoverSlice(...args),
  ...createCameraSlice(...args),
  ...createSectionSlice(...args),
  ...createMeasurementSlice(...args),
  ...createDataSlice(...args),
  ...createModelSlice(...args),
  ...createMutationSlice(...args),
  ...createDrawing2DSlice(...args),
  ...createSheetSlice(...args),
  ...createBcfSlice(...args),
  ...createIdsSlice(...args),
  ...createListSlice(...args),
  ...createPinboardSlice(...args),
  ...createLensSlice(...args),
  ...createClashSlice(...args),
  ...createCompareSlice(...args),
  ...createLayerStackSlice(...args),
  ...createDockSlice(...args),
  ...createSidebarSlice(...args),
  ...createScriptSlice(...args),
  ...createChatSlice(...args),
  ...createCesiumSlice(...args),
  ...createSolarSlice(...args),
  ...createEnvironmentSlice(...args),
  ...createScheduleSlice(...args),
  ...createPlaybackSlice(...args),
  ...createOverlaySlice(...args),
  ...createSearchSlice(...args),
  ...createAnnotationsSlice(...args),
  ...createCollabSlice(...args),
  ...createAddElementSlice(...args),
  ...createSplitToolSlice(...args),
  ...createLevelDisplaySlice(...args),
  ...createPointCloudSlice(...args),
  ...createUnitDisplaySlice(...args),
  ...createSpaceMouseSlice(...args),
  ...createExtensionsSlice(...args),

  // Reset all viewer state when loading new file
  // Note: Does NOT clear models - use clearAllModels() for that
  resetViewerState: () => {
    invalidateVisibleBasketCache();
    const [set, get] = args;
    set({
      // Selection (legacy)
      selectedEntityId: null,
      selectedEntityIds: new Set(),
      selectedStoreys: new Set(),
      // Drop the shared active storey — it references the outgoing model, so a
      // new file must not inherit a stale storey for Solo / Space Sketch.
      activeStorey: null,

      // Selection (multi-model)
      selectedEntity: null,
      selectedEntitiesSet: new Set(),
      selectedEntities: [],
      selectedModelId: null,

      // Visibility (legacy)
      hiddenEntities: new Set(),
      isolatedEntities: null,
      ghostExceptEntities: null,
      classFilter: null,
      // Re-read persisted toggles on every file load so a new model never
      // reverts the user's visibility choices (e.g. "Show Annotations").
      typeVisibility: getPersistedTypeVisibility(),
      typeViewMode: getPersistedTypeViewMode(),

      // Visibility (multi-model)
      hiddenEntitiesByModel: new Map(),
      isolatedEntitiesByModel: new Map(),

      // Data
      loading: false,
      geometryStreamingActive: false,
      geometryUpdateTick: 0,
      progress: null,
      geometryProgress: null,
      metadataProgress: null,
      error: null,
      pendingColorUpdates: null,
      pendingMeshColorUpdates: null,
      // Drop any undrained GPU-instancing shards from the previous model so they
      // can't be uploaded into the new scene under a rapid model switch.
      pendingInstancedShards: null,

      // Compare (#924): drop any stale diff result — it references models by
      // id and the loaded set is changing. Keep panel visibility + A/B/scope
      // choices (UI prefs); the user re-runs against the new set.
      compareResult: null,
      compareSelectedKey: null,
      compareRunning: false,
      compareError: null,

      // Hover/Context
      hoverState: { entityId: null, screenX: 0, screenY: 0 },
      contextMenu: { isOpen: false, entityId: null, screenX: 0, screenY: 0 },

      // Measurements
      measurements: [],
      pendingMeasurePoint: null,
      activeMeasurement: null,
      snapTarget: null,
      edgeLockState: {
        edge: null,
        meshExpressId: null,
        edgeT: 0,
        lockStrength: 0,
        isCorner: false,
        cornerValence: 0,
      },

      // Section plane: reset axis/position/enabled/flipped (those are
      // model-relative and meaningless when switching files), but PRESERVE
      // the user's cap appearance preferences (showCap, showOutlines,
      // capStyle). Those round-trip to localStorage via the slice's
      // persistence helpers; clobbering them here was the cause of "my
      // hatch / colour resets to defaults every time I open a file".
      sectionPlane: {
        ...get().sectionPlane,
        axis:     SECTION_PLANE_DEFAULTS.AXIS,
        position: SECTION_PLANE_DEFAULTS.POSITION,
        enabled:  SECTION_PLANE_DEFAULTS.ENABLED,
        flipped:  SECTION_PLANE_DEFAULTS.FLIPPED,
      },

      // Camera
      cameraRotation: {
        azimuth: CAMERA_DEFAULTS.AZIMUTH,
        elevation: CAMERA_DEFAULTS.ELEVATION,
      },
      projectionMode: 'perspective' as const,

      // UI
      activeTool: UI_DEFAULTS.ACTIVE_TOOL,
      editEnabled: false,
      // Drop any one-shot bSDD "jump to property" focus armed before the load —
      // a new file reuses ids ('legacy' + reassigned expressIds) so a stale
      // focus could otherwise match an unrelated entity (issue #1107).
      pendingPropertyFocus: null,
      visualEnhancementsEnabled: UI_DEFAULTS.VISUAL_ENHANCEMENTS_ENABLED,
      edgeContrastEnabled: UI_DEFAULTS.EDGE_CONTRAST_ENABLED,
      edgeContrastIntensity: UI_DEFAULTS.EDGE_CONTRAST_INTENSITY,
      contactShadingQuality: UI_DEFAULTS.CONTACT_SHADING_QUALITY,
      contactShadingIntensity: UI_DEFAULTS.CONTACT_SHADING_INTENSITY,
      contactShadingRadius: UI_DEFAULTS.CONTACT_SHADING_RADIUS,
      separationLinesEnabled: UI_DEFAULTS.SEPARATION_LINES_ENABLED,
      separationLinesQuality: UI_DEFAULTS.SEPARATION_LINES_QUALITY,
      separationLinesIntensity: UI_DEFAULTS.SEPARATION_LINES_INTENSITY,
      separationLinesRadius: UI_DEFAULTS.SEPARATION_LINES_RADIUS,

      // Cesium
      cesiumAvailable: false,
      cesiumEnabled: false,
      cesiumTerrainHeight: null,
      // The snap target is model-specific terrain state; drop it with the
      // sampled height so a new file can't reuse the old target (#1456).
      cesiumTerrainSaveHeight: null,
      cesiumSourceModelId: null,
      // A new file is orthometric by default — re-arm the geoid correction
      // so a previous file's "heights are ellipsoidal" opt-out doesn't carry
      // over (#1355).
      cesiumHeightsAreEllipsoidal: false,
      cesiumTerrainClipY: null,
      cesiumGlbLoaded: false,
      cesiumPlacementEditMode: false,
      cesiumPlacementDraftModelId: null,
      cesiumPlacementDraft: null,

      // Drawing 2D
      drawing2D: null,
      drawing2DStatus: 'idle' as const,
      drawing2DProgress: 0,
      drawing2DPhase: '',
      drawing2DError: null,
      drawing2DPanelVisible: false,
      suppressNextSection2DPanelAutoOpen: false,
      drawing2DSvgContent: null,
      drawing2DDisplayOptions: {
        showHiddenLines: true,
        showHatching: true,
        showAnnotations: true,
        show3DOverlay: true,
        scale: 100,
        useSymbolicRepresentations: false,
        showIfcAnnotations: true,
        showConstructionProjection: false,
      },
      // Graphic overrides (keep presets, reset active and custom)
      activePresetId: 'preset-3d-colors',
      customOverrideRules: [],
      overridesEnabled: true,
      overridesPanelVisible: false,
      // 2D Measure
      measure2DMode: false,
      measure2DStart: null,
      measure2DCurrent: null,
      measure2DShiftLocked: false,
      measure2DLockedAxis: null,
      measure2DResults: [],
      measure2DSnapPoint: null,
      // Annotation tools
      annotation2DActiveTool: 'none' as const,
      annotation2DCursorPos: null,
      polygonArea2DPoints: [],
      polygonArea2DResults: [],
      textAnnotations2D: [],
      textAnnotation2DEditing: null,
      cloudAnnotation2DPoints: [],
      cloudAnnotations2D: [],
      selectedAnnotation2D: null,
      // Drawing Sheet
      activeSheet: null,
      sheetEnabled: false,
      sheetPanelVisible: false,
      titleBlockEditorVisible: false,
      // Keep savedSheetTemplates - don't reset user's templates

      // BCF - reset panel but keep project and author
      bcfPanelVisible: false,
      bcfLoading: false,
      bcfError: null,
      activeTopicId: null,
      activeViewpointId: null,
      // Keep bcfProject and bcfAuthor - user's work

      // IDS - reset panel but keep document and results
      idsPanelVisible: false,
      idsLoading: false,
      idsProgress: null,
      idsError: null,
      idsActiveSpecificationId: null,
      idsActiveEntityId: null,
      // Keep idsDocument, idsValidationReport, idsLocale - user's work

      // Lists - reset result but keep definitions (user's saved lists)
      listPanelVisible: false,
      activeListId: null,
      listResult: null,
      listExecuting: false,

      // Pinboard - clear pinned entities on new file
      pinboardEntities: new Set<string>(),
      basketViews: [],
      activeBasketViewId: null,
      basketPresentationVisible: false,
      hierarchyBasketSelection: new Set<string>(),

      // Script - reset execution state but keep saved scripts, editor content, and panel visibility
      // (scripts that create-and-load a model should not close the panel)
      scriptExecutionState: 'idle' as const,
      scriptLastResult: null,
      scriptLastError: null,
      scriptLastDiagnostics: [],
      scriptAssistantTurnSnapshot: null,
      scriptDeleteConfirmId: null,

      // Lens - deactivate but keep saved lenses
      activeLensId: null,
      lensPanelVisible: false,
      lensColorMap: new Map<number, string>(),
      lensHiddenIds: new Set<number>(),
      lensRuleCounts: new Map<string, number>(),
      lensRuleEntityIds: new Map<string, number[]>(),

      // Chat - keep messages and panel visible, reset streaming state
      chatStatus: 'idle' as const,
      chatStreamingContent: '',
      chatError: null,
      chatAbortController: null,

      // Schedule (4D) - drop panel + data; definitions are re-extracted on
      // next load. `playbackSpeed`, `playbackLoop`, and `ganttTimeScale` are
      // intentionally preserved as user preferences that survive file loads.
      ganttPanelVisible: false,
      generateScheduleDialogOpen: false,
      scheduleData: null,
      scheduleRange: null,
      activeWorkScheduleId: '',
      expandedTaskGlobalIds: new Set<string>(),
      hoveredTaskGlobalId: null,
      selectedTaskGlobalIds: new Set<string>(),
      animationEnabled: false,
      playbackIsPlaying: false,
      playbackTime: 0,

      // Mutations - clear all mutation state so stale changes don't carry over
      mutationViews: new Map(),
      changeSets: new Map(),
      activeChangeSetId: null,
      undoStacks: new Map(),
      redoStacks: new Map(),
      dirtyModels: new Set(),
      mutationVersion: get().mutationVersion + 1,

      // Search - results reference the previous model's expressIds, drop them.
      searchQuery: '',
      searchOpen: false,
      searchHighlightIndex: 0,
      searchIndexes: new Map(),
      searchVimCycle: null,
      searchModalOpen: false,
      searchFieldFilter: 'all',
      searchModelFilter: null,
      searchFilterResult: null,
      searchFilterRunning: false,
      searchFilterError: null,
      searchFilter: { rules: [], combinator: 'AND', limit: 500 },
      searchFilterSchema: new Map(),

      // Annotations — drop draft + selection so a new file doesn't
      // inherit the previous file's pin authoring state. Persisted
      // pins themselves stay in localStorage (cross-file workspace).
      draft: null,
      selectedAnnotationId: null,

      // Point cloud — clear runtime fields so a new file doesn't
      // inherit the previous file's color mode / size / EDL state.
      // Single-source-of-truth defaults shared with createPointCloudSlice.
      ...POINT_CLOUD_DEFAULTS,
      pointCloudFixedColor: [...POINT_CLOUD_DEFAULTS.pointCloudFixedColor] as [number, number, number, number],
    });
  },

  openWorkspacePanel: (panel) => {
    const [set, get] = args;
    // Docking into the sidebar: if the panel was floating or popped out, re-dock
    // it so the toolbar / command-palette / activity-bar entry points stay in
    // sync with the float + window channels (#1200/#1201/#1208) instead of
    // leaving an orphaned window. The sidebar is single-tenant, so opening one
    // panel clears every other panel flag (the subscription below enforces this
    // for stragglers, but doing it here keeps the common path a single set()).
    get().closeFloatingPanel(panel);
    get().setPanelPoppedOut(panel, false);
    set({
      bcfPanelVisible: panel === 'bcf',
      idsPanelVisible: panel === 'ids',
      lensPanelVisible: panel === 'lens',
      clashPanelVisible: panel === 'clash',
      comparePanelVisible: panel === 'compare',
      extensionsPanelVisible: panel === 'extensions',
      collabPanelVisible: panel === 'collab',
      layersPanelVisible: panel === 'layers',
      rightPanelCollapsed: false,
    });
    if (get().sidebarMode !== 'expanded') get().setSidebarMode('expanded');
  },

  showWorkspacePanel: (panel) => {
    const [set, get] = args;
    // If the panel was floating / popped out, bring it back to the docked slot.
    get().closeFloatingPanel(panel);
    get().setPanelPoppedOut(panel, false);
    // Script / Schedule / Lists live in the BOTTOM strip, not the single-tenant
    // side slot. A popped-out one re-docks here (the OS window's dock button
    // routes through this fn with the panel id), so it must land in its home
    // region instead of flipping side-panel flags it doesn't own (#1208).
    if (isBottomPanel(panel)) {
      set({
        scriptPanelVisible: panel === 'script',
        ganttPanelVisible: panel === 'gantt',
        listPanelVisible: panel === 'lists',
        rightPanelCollapsed: false,
      });
      return;
    }
    if (panel === 'properties') {
      // The Information panel is the sidebar's fallback — reveal it by closing
      // every other panel.
      set({
        bcfPanelVisible: false,
        idsPanelVisible: false,
        lensPanelVisible: false,
        clashPanelVisible: false,
        comparePanelVisible: false,
        extensionsPanelVisible: false,
        collabPanelVisible: false,
        layersPanelVisible: false,
        rightPanelCollapsed: false,
      });
      get().setSidebarActivePanel('properties');
      if (get().sidebarMode !== 'expanded') get().setSidebarMode('expanded');
    } else {
      get().openWorkspacePanel(panel);
    }
  },

  toggleWorkspacePanel: (panel) => {
    const [, get] = args;
    // "Active" means it owns the docked slot right now. A floating / popped-out
    // panel reads as open too, so toggling it re-docks rather than no-ops.
    const s = get();
    const isActive = s.sidebarActivePanel === panel
      && !s.floatingPanels.some((p) => p.id === panel)
      && !s.poppedOutIds.includes(panel);
    if (isActive) get().showWorkspacePanel('properties');
    else get().showWorkspacePanel(panel);
  },

  toggleBottomPanel: (panel) => {
    const [set, get] = args;
    const s = get();
    const flagActive = panel === 'script' ? s.scriptPanelVisible : panel === 'gantt' ? s.ganttPanelVisible : s.listPanelVisible;
    const detached = s.floatingPanels.some((p) => p.id === panel) || s.poppedOutIds.includes(panel);
    // Re-dock any float / OS window for it first.
    get().closeFloatingPanel(panel);
    get().setPanelPoppedOut(panel, false);
    if (flagActive && !detached) {
      // Toggle off (only one bottom panel shows at a time).
      set({ scriptPanelVisible: false, ganttPanelVisible: false, listPanelVisible: false });
    } else {
      set({
        scriptPanelVisible: panel === 'script',
        ganttPanelVisible: panel === 'gantt',
        listPanelVisible: panel === 'lists',
        rightPanelCollapsed: false,
      });
    }
  },

  openPanelInHome: (panel) => {
    const [set, get] = args;
    if (isBottomPanel(panel)) {
      get().closeFloatingPanel(panel);
      get().setPanelPoppedOut(panel, false);
      set({
        scriptPanelVisible: panel === 'script',
        ganttPanelVisible: panel === 'gantt',
        listPanelVisible: panel === 'lists',
        rightPanelCollapsed: false,
      });
    } else {
      get().showWorkspacePanel(panel);
    }
  },
}));

const STORE_SINGLETON_KEY = '__ifc_lite_viewer_store__';
const globalStoreRegistry = globalThis as typeof globalThis & {
  [STORE_SINGLETON_KEY]?: ReturnType<typeof createViewerStore>;
};

/**
 * The six per-panel visibility flags that drive the single-tenant sidebar,
 * paired with their registry id. `properties` has no flag — it is the
 * fallback shown when none of these are on. (Script / Schedule / Lists are
 * NOT here: they live in the bottom panel and stay independent.)
 */
const SIDEBAR_PANEL_FLAGS: ReadonlyArray<readonly [keyof ViewerState, WorkspacePanelId]> = [
  ['bcfPanelVisible', 'bcf'],
  ['idsPanelVisible', 'ids'],
  ['lensPanelVisible', 'lens'],
  ['clashPanelVisible', 'clash'],
  ['comparePanelVisible', 'compare'],
  ['extensionsPanelVisible', 'extensions'],
  ['collabPanelVisible', 'collab'],
  ['layersPanelVisible', 'layers'],
];

/**
 * Enforce the "one docked panel at a time" invariant for the unified sidebar
 * (#1208), without having to touch the ~15 call sites that flip a panel flag
 * directly (ChatPanel, IdeasPanel, GenerateScheduleDialog, search-to-list, …).
 *
 * Whenever a panel flag transitions off→on we make it the sole active panel:
 * clear every other flag and record it as `sidebarActivePanel`. When the
 * active panel's flag goes on→off we re-resolve to the next open panel, or the
 * Information fallback. This is the single writer of `sidebarActivePanel`.
 */
function registerSidebarExclusivity(store: ReturnType<typeof createViewerStore>): void {
  store.subscribe((state, prev) => {
    // Did any panel just open this tick? (first off→on wins)
    let opened: WorkspacePanelId | null = null;
    for (const [flag, id] of SIDEBAR_PANEL_FLAGS) {
      if (state[flag] && !prev[flag]) { opened = id; break; }
    }

    if (opened) {
      const patch: Record<string, boolean> = {};
      for (const [flag, id] of SIDEBAR_PANEL_FLAGS) {
        if (id !== opened && state[flag]) patch[flag] = false;
      }
      if (Object.keys(patch).length > 0) store.setState(patch as Partial<ViewerState>);
      state.setSidebarActivePanel(opened);
      // Opening a panel from anywhere (toolbar, command palette, chat, …) means
      // the user wants to see it — reveal the sidebar if it was collapsed/hidden.
      if (state.sidebarMode !== 'expanded') state.setSidebarMode('expanded');
      return;
    }

    // Did the active panel just close? Re-resolve the docked slot.
    const active = state.sidebarActivePanel;
    if (active !== 'properties') {
      const flag = SIDEBAR_PANEL_FLAGS.find(([, id]) => id === active)?.[0];
      if (flag && !state[flag] && prev[flag]) {
        const next = SIDEBAR_PANEL_FLAGS.find(([f]) => state[f]);
        state.setSidebarActivePanel(next ? next[1] : 'properties');
      }
    }
  });
}

/**
 * Keep the Hierarchy left slot (#1267) in step with its rail visibility: hiding
 * the Hierarchy icon from the activity bar collapses its left slot, and showing
 * it again re-opens the slot, so "hide it" actually hides the panel, not just
 * its rail entry. One-way (hidden-set drives collapse); collapsing via the left
 * drag handle keeps the rail icon so the panel can be re-opened from there.
 */
function registerHierarchyLeftSync(store: ReturnType<typeof createViewerStore>): void {
  store.subscribe((state, prev) => {
    const wasHidden = prev.sidebarHiddenIds.includes('hierarchy');
    const isHidden = state.sidebarHiddenIds.includes('hierarchy');
    if (isHidden !== wasHidden) state.setLeftPanelCollapsed(isHidden);
  });
}

export function getViewerStoreApi() {
  const existing = globalStoreRegistry[STORE_SINGLETON_KEY];
  if (existing) return existing;
  const store = createViewerStore();
  globalStoreRegistry[STORE_SINGLETON_KEY] = store;
  registerSidebarExclusivity(store);
  registerHierarchyLeftSync(store);
  // Initial reconcile: a persisted panel flag (e.g. scriptPanelVisible) can be
  // true at load before any change fires the subscription, so seed the docked
  // panel from the current flags rather than leaving it on the fallback.
  const init = store.getState();
  const initialActive = SIDEBAR_PANEL_FLAGS.find(([flag]) => init[flag])?.[1];
  if (initialActive) init.setSidebarActivePanel(initialActive);
  // A persisted "Hierarchy hidden" never fired the subscription above, so seed
  // the collapsed left slot from it on load (#1267).
  if (init.sidebarHiddenIds.includes('hierarchy')) init.setLeftPanelCollapsed(true);
  return store;
}

export const useViewerStore = getViewerStoreApi();
