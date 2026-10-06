/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Combined Zustand store. Domain slices own their state and actions. */

import { registerWorkflowArtifactInvalidation } from '../lib/flow/artifact-lifetime.js';
import { createAppearanceSlice, type AppearanceSlice } from './slices/appearanceSlice.js';
import { create } from 'zustand';
import { createViewerActions, type ViewerActions } from './createViewerActions.js';
import { createLoadingSlice, type LoadingSlice } from './slices/loadingSlice.js';
import { createSelectionSlice, type SelectionSlice } from './slices/selectionSlice.js';
import { createVisibilitySlice, type VisibilitySlice } from './slices/visibilitySlice.js';
import { createUISlice, type UISlice } from './slices/uiSlice.js';
import { createHoverSlice, type HoverSlice } from './slices/hoverSlice.js';
import { createCameraSlice, type CameraSlice } from './slices/cameraSlice.js';
import { createSectionSlice, type SectionSlice } from './slices/sectionSlice.js';
import { registerMutationViewStoreBinding } from './mutation-view-store-binding.js';
export { customPlaneCenter, loadLastSectionMode, type LastSectionMode } from './slices/sectionSlice.js';
import { createMeasurementSlice, type MeasurementSlice } from './slices/measurementSlice.js';
import { createDataSlice, type DataSlice } from './slices/dataSlice.js';
import { createModelSlice, type ModelSlice } from './slices/modelSlice.js';
import { createMutationSlice, type MutationSlice } from './slices/mutationSlice.js';
import { createDrawing2DSlice, type Drawing2DSlice } from './slices/drawing2DSlice.js';
import { createSheetSlice, type SheetSlice } from './slices/sheetSlice.js';
import { createBcfSlice, type BCFSlice } from './slices/bcfSlice.js';
import { createIdsSlice, type IDSSlice } from './slices/idsSlice.js';
import { createValidationDraftSlice, type ValidationDraftSlice } from './slices/validationDraftSlice.js';
import { createManualValidationSlice, type ManualValidationSlice } from './slices/manualValidationSlice.js';
import { createValidationReportsSlice, type ValidationReportsSlice } from './slices/validationReportsSlice.js';
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
import { createSavedComparisonsSlice, type SavedComparisonsSlice } from './slices/savedComparisonsSlice.js';
import { createCompareSlice, type CompareSlice } from './slices/compareSlice.js';
import { createCompareRunsSlice, type CompareRunsSlice } from './slices/compareRunsSlice.js';
import { createDockSlice, type DockSlice } from './slices/dockSlice.js';
import { createSidebarSlice, type SidebarSlice } from './slices/sidebarSlice.js';
import { createDrawingInspectorSlice, type DrawingInspectorSlice } from './slices/drawingInspectorSlice.js';
import { withToolTelemetry } from './uiTelemetry.js';
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
import { createAuthoringSessionSlice, type AuthoringSessionSlice } from './slices/authoringSessionSlice.js';
import { createAuthoringDefaultsSlice, type AuthoringDefaultsSlice } from './slices/authoringDefaultsSlice.js';
import { createLevelDisplaySlice, type LevelDisplaySlice } from './slices/levelDisplaySlice.js';
import { createStoreyContextSlice, type StoreyContextSlice } from './slices/storeyContextSlice.js';
import { createModelPlacementSlice, type ModelPlacementSlice } from './slices/modelPlacementSlice.js';
import { createPointCloudSlice, type PointCloudSlice } from './slices/pointCloudSlice.js';
import { createUnitDisplaySlice, type UnitDisplaySlice } from './slices/unitDisplaySlice.js';
import { createSpaceMouseSlice, type SpaceMouseSlice } from './slices/spaceMouseSlice.js';
import { createLayerStackSlice, type LayerStackSlice } from './slices/layerStackSlice.js';
import { createZonesSlice, type ZonesSlice } from './slices/zonesSlice.js';
import { createModelTagsSlice, type ModelTagsSlice } from './slices/modelTagsSlice.js';
import { withPlacementHistory } from './placement-history.js';
import { withVisibilityOwnershipInvalidation } from './visibility-invalidation.js';
import { withStoreChurnCounters } from './perf-churn.js';
import { registerSidebarExclusivity, registerHierarchyLeftSync, registerDrawingInspectorSheetSync, reconcileInitialStoreSync } from './store-sync.js';
import { registerOverlayThemeSync } from '@/lib/viewport-ui/overlay-theme-sync';

// Re-export types for consumers
export type * from './types.js';

// Explicitly re-export multi-model types that need to be imported by name
export type { EntityRef, SchemaVersion, FederatedModel, MeasurementConstraintEdge, OrthogonalAxis, SectionCapStyle, SectionCapHatchId, SectionPlane, SectionPlaneAxis } from './types.js';
export type { HierarchyMode } from './slices/uiSlice.js';
export type { RibbonTabId } from './constants.js';

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
export type { LensSlice, Lens, LensRule } from './slices/lensSlice.js';
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
  ManualValidationSlice &
  ValidationReportsSlice &
  ListSlice &
  ChartSlice &
  FlowSlice &
  DocumentSlice &
  PinboardSlice &
  LensSlice &
  ClashSlice &
  CompareSlice & SavedComparisonsSlice & CompareRunsSlice &
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
  AuthoringSessionSlice & AuthoringDefaultsSlice &
  LevelDisplaySlice & StoreyContextSlice &
  PointCloudSlice & ModelPlacementSlice &
  UnitDisplaySlice & SpaceMouseSlice & ZonesSlice & ModelTagsSlice &
  ExtensionsSlice & SourcesSlice & SceneStateSlice & ViewerActions;

/**
 * Main viewer store combining all slices.
 *
 * `withVisibilityOwnershipInvalidation` wraps the store's `set` (and its
 * `setState`) so that no slice — present or future — can replace
 * `isolatedEntities` / `ghostExceptEntities` without dropping the
 * visibility-ownership records that write makes stale. See
 * `store/visibility-invalidation.ts` for why that is a middleware rather than a
 * helper each writing action remembers to call. `withStoreChurnCounters`
 * (outermost) counts writes and subscriber notifications under ?perfTrace=1 (#6957).
 */
const createViewerStore = () => create<ViewerState>()(withStoreChurnCounters(withVisibilityOwnershipInvalidation(withPlacementHistory((...args) => ({
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
  ...createValidationDraftSlice(...args), ...createManualValidationSlice(...args),
  ...createValidationReportsSlice(...args),
  ...createListSlice(...args),
  ...createChartSlice(...args),
  ...createFlowSlice(...args),
  ...createDocumentSlice(...args),
  ...createPinboardSlice(...args),
  ...createLensSlice(...args),
  ...createClashSlice(...args),
  ...createCompareSlice(...args),
  ...createSavedComparisonsSlice(...args),
  ...createCompareRunsSlice(...args),
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
  ...createAuthoringSessionSlice(...args), ...createAuthoringDefaultsSlice(...args),
  ...createLevelDisplaySlice(...args), ...createStoreyContextSlice(...args),
  ...createPointCloudSlice(...args),
  ...createModelPlacementSlice(...args),
  ...createUnitDisplaySlice(...args),
  ...createSpaceMouseSlice(...args),
  ...createZonesSlice(...args),
  ...createModelTagsSlice(...args),
  ...createExtensionsSlice(...args),
  ...createSourcesSlice(...args), ...createSceneStateSlice(...args),
  ...createAppearanceSlice(...args),

  ...createViewerActions(...args),
})))));

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
  registerOverlayThemeSync(store); // `--overlay-*` on <html> follow `theme` in every app that holds the store (#5490)
  registerWorkflowArtifactInvalidation(store);
  reconcileInitialStoreSync(store);
  return store;
}

export const useViewerStore = getViewerStoreApi();
