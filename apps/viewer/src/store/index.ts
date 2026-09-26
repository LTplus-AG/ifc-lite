/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Combined Zustand store. Domain slices own their state and actions. */

import { createAppearanceSlice, type AppearanceSlice } from './slices/appearanceSlice.js';
import { create } from 'zustand';
import { createLoadingSlice, type LoadingSlice } from './slices/loadingSlice.js';
import { createSelectionSlice, type SelectionSlice } from './slices/selectionSlice.js';
import { createVisibilitySlice, type VisibilitySlice } from './slices/visibilitySlice.js';
import { createUISlice, type UISlice } from './slices/uiSlice.js';
import { createHoverSlice, type HoverSlice } from './slices/hoverSlice.js';
import { createCameraSlice, DEFAULT_CONTROLS_MODE, type CameraSlice } from './slices/cameraSlice.js';
import { createSectionSlice, type SectionSlice, clearLastSectionMode } from './slices/sectionSlice.js';
import { registerMutationViewStoreBinding } from './mutation-view-store-binding.js';
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
import { createValidationDraftSlice, type ValidationDraftSlice } from './slices/validationDraftSlice.js';
import { createExtensionsSlice, type ExtensionsSlice } from './slices/extensionsSlice.js';
import { createSourcesSlice, type SourcesSlice } from './slices/sourcesSlice.js';
import { createSceneStateSlice, type SceneStateSlice } from './slices/sceneStateSlice.js';
import { createListSlice, type ListSlice } from './slices/listSlice.js';
import { createChartSlice, type ChartSlice } from './slices/chartSlice.js';
import { createFlowSlice, type FlowSlice } from './slices/flowSlice.js';
import { createDocumentSlice, type DocumentSlice } from './slices/documentSlice.js';
import { createPinboardSlice, type PinboardSlice } from './slices/pinboardSlice.js';
import { createLensSlice, type LensSlice } from './slices/lensSlice.js';
import { createClashSlice, type ClashSlice } from './slices/clashSlice.js';
import { createCompareSlice, type CompareSlice } from './slices/compareSlice.js';
import { createDockSlice, type DockSlice } from './slices/dockSlice.js';
import { createSidebarSlice, type SidebarSlice } from './slices/sidebarSlice.js';
import { createDrawingInspectorSlice, type DrawingInspectorSlice } from './slices/drawingInspectorSlice.js';
import { type WorkspacePanelId } from '@/lib/panels/registry';
import { bottomPanelFlags, isBottomPanel, isBottomPanelDocked, type BottomPanelId } from '@/lib/panels/bottom-panels';
import { trackPanelOpened, withToolTelemetry, type PanelOpenSource } from './uiTelemetry.js';
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
import { createModelPlacementSlice, type ModelPlacementSlice } from './slices/modelPlacementSlice.js';
import { createPointCloudSlice, type PointCloudSlice } from './slices/pointCloudSlice.js';
import { createUnitDisplaySlice, type UnitDisplaySlice } from './slices/unitDisplaySlice.js';
import { createSpaceMouseSlice, type SpaceMouseSlice } from './slices/spaceMouseSlice.js';
import { createLayerStackSlice, type LayerStackSlice } from './slices/layerStackSlice.js';
import { createZonesSlice, type ZonesSlice } from './slices/zonesSlice.js';
import { createModelTagsSlice, type ModelTagsSlice } from './slices/modelTagsSlice.js';
import { invalidateVisibleBasketCache } from './basketVisibleSet.js';
import { withPlacementHistory } from './placement-history.js';
import { withVisibilityOwnershipInvalidation } from './visibility-invalidation.js';
import { SIDEBAR_PANEL_FLAGS, registerSidebarExclusivity, registerHierarchyLeftSync, registerDrawingInspectorSheetSync, reconcileInitialStoreSync } from './store-sync.js';
// The composed teardown `resetViewerState` dispatches. Its own module rather
// than this file: `slices/modelSlice.ts` is another entry point and this file
// imports that slice, so a registry declared here would be a runtime cycle.
import { viewerTeardown } from './teardown-registry.js';
import {
  endClashScenePresentation,
  type ClashSceneTeardown,
} from '@/lib/clash/visibility-ownership';


// Re-export types for consumers
export type * from './types.js';

// Explicitly re-export multi-model types that need to be imported by name
export type { EntityRef, SchemaVersion, FederatedModel, MeasurementConstraintEdge, OrthogonalAxis, SectionCapStyle, SectionCapHatchId, SectionPlane, SectionPlaneAxis } from './types.js';
export type { HierarchyMode } from './slices/uiSlice.js';
export type { RibbonTabId, ToolbarStyle } from './constants.js';

// Re-export utility functions for entity references
export { entityRefToString, stringToEntityRef, entityRefEquals, isIfcxDataStore } from './types.js';

// Re-export single source of truth for renderer ID → IFC entity resolution.
export { resolveEntityRef, resolveGlobalId } from './resolveEntityRef.js';
export { fromGlobalIdFromModels, toGlobalIdFromModels, toGlobalIdForRef } from './globalId.js';
export type { ForwardModelMapLike } from './globalId.js';

export type { Drawing2DState, Drawing2DStatus, Annotation2DTool, PolygonArea2DResult, TextAnnotation2D, CloudAnnotation2D, SelectedAnnotation2D } from './slices/drawing2DSlice.js';

export type { SheetState } from './slices/sheetSlice.js';
export type { CollabSlice, CollabRole, CollabStatus, StartCollabOptions } from './slices/collabSlice.js';
export type { BCFSlice, BCFSliceState } from './slices/bcfSlice.js';

export type { IDSSlice, IDSSliceState, IDSDisplayOptions, IDSFilterMode, IDSFocusMode } from './slices/idsSlice.js';

// Re-export List / Chart / Flow / Document / Pinboard types
export type { ListSlice } from './slices/listSlice.js';
export type { ChartSlice, ChartFocusMode } from './slices/chartSlice.js';
export type { FlowSlice } from './slices/flowSlice.js';
export type { DocumentSlice } from './slices/documentSlice.js';
export type { PinboardSlice } from './slices/pinboardSlice.js';

// Re-export Lens types
export type { LensSlice, Lens, LensRule, LensCriteria } from './slices/lensSlice.js';
export type { CompareSlice, CompareResult } from './slices/compareSlice.js';
export type { LayerStackSlice, LayerStackEntry, LayerStackDiffResult, LayerAuthorKind } from './slices/layerStackSlice.js';
export type { DockSlice, FloatingPanelState, SnapZone } from './slices/dockSlice.js';
export type { SidebarSlice, SidebarMode, SidebarLayoutSnapshot } from './slices/sidebarSlice.js';
export type { DrawingInspectorSlice, DrawingInspectorTab } from './slices/drawingInspectorSlice.js';

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
export type ViewerState = AppearanceSlice & LoadingSlice &
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
  ValidationDraftSlice &
  ListSlice &
  ChartSlice &
  FlowSlice &
  DocumentSlice &
  PinboardSlice &
  LensSlice &
  ClashSlice &
  CompareSlice &
  LayerStackSlice &
  DockSlice &
  SidebarSlice &
  DrawingInspectorSlice &
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
  PointCloudSlice & ModelPlacementSlice &
  UnitDisplaySlice & SpaceMouseSlice & ZonesSlice & ModelTagsSlice &
  ExtensionsSlice & SourcesSlice & SceneStateSlice & {
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
    openWorkspacePanel: (panel: Exclude<WorkspacePanelId, 'properties'>, surface?: PanelOpenSource) => void;
    /**
     * Show a workspace panel docked in the sidebar, un-floating / re-docking it
     * first if it was popped out (#1200/#1201/#1208). Accepts `properties` (the
     * Information fallback, shown by closing every other panel) on top of the
     * analysis + tool panels `openWorkspacePanel` handles. Shared by the
     * activity bar, the Alt+N shortcuts, the command palette and the
     * floating / window hosts' re-dock action.
     */
    showWorkspacePanel: (panel: WorkspacePanelId, surface?: PanelOpenSource) => void;
    /**
     * Toggle a sidebar panel: if it is the active docked panel, close it back
     * to Information; otherwise open it. The single entry point the activity
     * bar, toolbar and command palette use so a second click always closes.
     */
    toggleWorkspacePanel: (panel: WorkspacePanelId, surface?: PanelOpenSource) => void;
    /**
     * Toggle a bottom-strip panel (Script / Schedule / Lists). These are
     * launched from the same sidebar rail but open in the BOTTOM panel —
     * mutually exclusive among themselves, independent of the single-tenant
     * right pane (so a side panel + a bottom panel can be open at once).
     */
    toggleBottomPanel: (panel: BottomPanelId, surface?: PanelOpenSource) => void;
    /**
     * Open a panel in its home region: side panels dock in the right pane,
     * Script / Schedule / Lists open in the bottom strip. The rail and Alt+N
     * route through here so each panel lands where it belongs.
     */
    openPanelInHome: (panel: WorkspacePanelId, surface?: PanelOpenSource) => void;
  };

/**
 * Main viewer store combining all slices.
 *
 * `withVisibilityOwnershipInvalidation` wraps the store's `set` (and its
 * `setState`) so that no slice — present or future — can replace
 * `isolatedEntities` / `ghostExceptEntities` without dropping the
 * visibility-ownership records that write makes stale. See
 * `store/visibility-invalidation.ts` for why that is a middleware rather than a
 * helper each writing action remembers to call.
 */
const createViewerStore = () => create<ViewerState>()(withVisibilityOwnershipInvalidation(withPlacementHistory((...args) => ({
  // Spread all slices
  ...createLoadingSlice(...args),
  ...createSelectionSlice(...args),
  ...createVisibilitySlice(...args),
  ...withToolTelemetry(createUISlice)(...args),
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
  ...createValidationDraftSlice(...args),
  ...createListSlice(...args),
  ...createChartSlice(...args),
  ...createFlowSlice(...args),
  ...createDocumentSlice(...args),
  ...createPinboardSlice(...args),
  ...createLensSlice(...args),
  ...createClashSlice(...args),
  ...createCompareSlice(...args),
  ...createLayerStackSlice(...args),
  ...createDockSlice(...args),
  ...createSidebarSlice(...args),
  ...createDrawingInspectorSlice(...args),
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
  ...createModelPlacementSlice(...args),
  ...createUnitDisplaySlice(...args),
  ...createSpaceMouseSlice(...args),
  ...createZonesSlice(...args),
  ...createModelTagsSlice(...args),
  ...createExtensionsSlice(...args),
  ...createSourcesSlice(...args), ...createSceneStateSlice(...args),
  ...createAppearanceSlice(...args),

  // Reset all viewer state when loading new file
  // Note: Does NOT clear models - use clearAllModels() for that
  resetViewerState: () => {
    invalidateVisibleBasketCache();
    const [set, get] = args;
    // Drop the persisted "last section mode" (localStorage, survives closing
    // the browser) together with the in-memory sectionPlane reset the section
    // slice contributes below (`slices/sectionSlice.teardown.ts`) — its
    // 'cardinal' axis/position is geometry, meaningful only relative to the
    // model that was loaded when it was saved. Leaving it in localStorage past
    // this reset let a NEW model inherit the OLD model's cut position the next
    // time the section tool was opened (#2939). It stays HERE, not in that
    // contribution: writing localStorage is a side effect, and a teardown is
    // pure.
    clearLastSectionMode();
    // Measurements (#2641 review): the slice owns the full list of its own
    // fields to clear on a model switch — see resetAllMeasurementState's doc
    // comment (measurementSlice.ts) for why this must not be a field list
    // duplicated here.
    get().resetAllMeasurementState();
    // The payload is composed by the slices that own the fields
    // (`store/teardown-registry.ts`). It used to be spelled out here instead,
    // key by key, in a file that cannot see any slice — so every reset value
    // was a second statement of a value the owning slice already declares, and
    // the two could drift with nothing to notice. Now each value is stated
    // once, beside the initial value it has to agree with.
    //
    // Through the store's own `set`, which `withVisibilityOwnershipInvalidation`
    // wraps. It keys on PRESENCE (`'isolatedEntities' in patch`), and both
    // channels sit in `NEVER_DROPPED` so the filter cannot remove them, so it
    // fires on EVERY reset as the hand-written payload did. Keep that exemption.
    set(viewerTeardown({ kind: 'session-reset' }, get()));

    // Camera interaction (#2934 review): the patch resets the STATE, but a
    // teardown is pure, so the renderer still holds whatever `?controls=`
    // restricted it to -- the param is read once and `Viewport` outlives the
    // swap. Side effect, so it lives here like `clearLastSectionMode`.
    get().cameraCallbacks.setInteractionMode?.(DEFAULT_CONTROLS_MODE);

    // Clash (#2654 review) — same stale-model-reference class as the
    // `compareResult` and `zoneAssignments` the composed patch above clears
    // (`slices/compareSlice.ts`, `slices/zonesSlice.ts`): a clash result is keyed by
    // `model:expressId` pairs from the OUTGOING model, and an IFCX
    // recomposition reassigns expressIds outright, so a surviving result can
    // silently describe different entities. Worse, the on-demand intersection
    // SOLID is a mesh drawn into the live scene: `clashSelectedId` and
    // `clashSolidStatus: 'solid'` surviving here means `Viewport`'s draw gate
    // passes and the previous model's solid gets re-pushed when the renderer
    // re-initialises for the new scene.
    //
    // Routed through `endClashScenePresentation`, the shared model-lifecycle
    // teardown, rather than calling `clearClash()` directly: this was the third
    // spelling of a teardown #2574 exists to unify, and it was incomplete. The
    // `set` above puts `pendingColorUpdates: null` (`dataSlice.teardown.ts`,
    // which says the same thing from the other side), and `null` is a NO-OP in
    // the effect that owns that channel (`useGeometryStreaming.ts`, "if
    // (pendingColorUpdates === null) return") — only a non-null EMPTY map
    // reaches `scene.clearColorOverrides()`. So the outgoing file's clash pair
    // tint (or lens colouring) stayed pushed at the renderer across a model
    // switch. The helper releases it with an empty `Map`.
    //
    // `'federation-cleared'` is the right mode: every model is gone, so both
    // visibility channels are cleared outright and the clash RESULT goes with
    // them — which is what `clearClash()` did here before, unchanged. Presets +
    // settings survive (workspace prefs), as everywhere else.
    endClashScenePresentation(() => get() as unknown as ClashSceneTeardown, 'federation-cleared');
  },

  openWorkspacePanel: (panel, surface) => {
    const [set, get] = args;
    trackPanelOpened(panel, surface, isBottomPanel(panel) || get().sidebarMode !== 'expanded' ? undefined : get().sidebarActivePanel);
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
      idsPanelVisible: panel === 'validation',
      lensPanelVisible: panel === 'lens',
      clashPanelVisible: panel === 'clash',
      comparePanelVisible: panel === 'compare',
      extensionsPanelVisible: panel === 'extensions',
      sourcesPanelVisible: panel === 'sources',
      collabPanelVisible: panel === 'collab',
      layersPanelVisible: panel === 'layers',
      rightPanelCollapsed: false,
    });
    // A side panel with NO visibility flag of its own (Location zones, #1869)
    // cannot be adopted by `registerSidebarExclusivity` below, which promotes
    // the panel whose flag just went off->on. Nothing went on, so the docked
    // slot stayed where it was and the panel could not be opened from ANY entry
    // point -- the activity bar included. Set it here, where the intent to open
    // is unambiguous; a flagged panel still goes through the subscription so
    // there remains one writer per mechanism.
    // ...but only for a SIDE panel. `showWorkspacePanel` returns early for the
    // bottom strip (Script / Schedule / Lists); this entry point has no such
    // early return, so without the `isBottomPanel` clause a re-dock of a
    // popped-out Lists window would promote it into the single-tenant side slot
    // it does not belong to.
    if (!isBottomPanel(panel) && !SIDEBAR_PANEL_FLAGS.some(([, id]) => id === panel)) {
      get().setSidebarActivePanel(panel);
    }
    if (get().sidebarMode !== 'expanded') get().setSidebarMode('expanded');
  },

  showWorkspacePanel: (panel, surface) => {
    const [set, get] = args;
    const alreadyDocked = isBottomPanel(panel) && isBottomPanelDocked(get(), panel);
    // If the panel was floating / popped out, bring it back to the docked slot.
    get().closeFloatingPanel(panel);
    get().setPanelPoppedOut(panel, false);
    // Script / Schedule / Lists live in the BOTTOM strip, not the single-tenant
    // side slot. A popped-out one re-docks here (the OS window's dock button
    // routes through this fn with the panel id), so it must land in its home
    // region instead of flipping side-panel flags it doesn't own (#1208).
    if (isBottomPanel(panel)) {
      set({ ...bottomPanelFlags(panel), rightPanelCollapsed: false });
      if (!alreadyDocked) trackPanelOpened(panel, surface);
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
        sourcesPanelVisible: false,
        collabPanelVisible: false,
        layersPanelVisible: false,
        rightPanelCollapsed: false,
      });
      get().setSidebarActivePanel('properties');
      if (get().sidebarMode !== 'expanded') get().setSidebarMode('expanded');
    } else {
      get().openWorkspacePanel(panel, surface);
    }
  },

  toggleWorkspacePanel: (panel, surface) => {
    const [, get] = args;
    // "Active" means it owns the docked slot right now. A floating / popped-out
    // panel reads as open too, so toggling it re-docks rather than no-ops.
    const s = get();
    const isActive = s.sidebarActivePanel === panel
      && !s.floatingPanels.some((p) => p.id === panel)
      && !s.poppedOutIds.includes(panel);
    if (isActive) get().showWorkspacePanel('properties');
    else get().showWorkspacePanel(panel, surface);
  },

  toggleBottomPanel: (panel, surface) => {
    const [set, get] = args;
    const docked = isBottomPanelDocked(get(), panel);
    // Re-dock any float / OS window for it first.
    get().closeFloatingPanel(panel);
    get().setPanelPoppedOut(panel, false);
    if (docked) {
      // Toggle off (only one bottom panel shows at a time).
      set(bottomPanelFlags(null));
    } else {
      set({ ...bottomPanelFlags(panel), rightPanelCollapsed: false });
      trackPanelOpened(panel, surface);
    }
  },

  openPanelInHome: (panel, surface) => {
    const [, get] = args;
    get().showWorkspacePanel(panel, surface);
  },
}))));

const STORE_SINGLETON_KEY = '__ifc_lite_viewer_store__';
const globalStoreRegistry = globalThis as typeof globalThis & {
  [STORE_SINGLETON_KEY]?: ReturnType<typeof createViewerStore>;
};

export function getViewerStoreApi() {
  const existing = globalStoreRegistry[STORE_SINGLETON_KEY];
  if (existing) return existing;
  const store = createViewerStore();
  globalStoreRegistry[STORE_SINGLETON_KEY] = store;
  registerSidebarExclusivity(store);
  registerHierarchyLeftSync(store);
  registerDrawingInspectorSheetSync(store);
  registerMutationViewStoreBinding(store); // views read their model's CURRENT store, not the partial one (#5672)
  reconcileInitialStoreSync(store);
  return store;
}

export const useViewerStore = getViewerStoreApi();
