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
import { createMeasurementSlice, type MeasurementSlice } from './slices/measurementSlice.js';
import { createDataSlice, type DataSlice } from './slices/dataSlice.js';
import { createModelSlice, type ModelSlice } from './slices/modelSlice.js';
import { createMutationSlice, type MutationSlice } from './slices/mutationSlice.js';
import { createDrawing2DSlice, type Drawing2DSlice } from './slices/drawing2DSlice.js';
import { createSheetSlice, type SheetSlice } from './slices/sheetSlice.js';
import { createBcfSlice, type BCFSlice } from './slices/bcfSlice.js';
import { createIdsSlice, type IDSSlice } from './slices/idsSlice.js';
import { createListSlice, type ListSlice } from './slices/listSlice.js';
import { createPinboardSlice, type PinboardSlice } from './slices/pinboardSlice.js';
import { createLensSlice, type LensSlice } from './slices/lensSlice.js';
import { createScriptSlice, type ScriptSlice } from './slices/scriptSlice.js';
import { createChatSlice, type ChatSlice } from './slices/chatSlice.js';
import { createCesiumSlice, type CesiumSlice } from './slices/cesiumSlice.js';
import { createDesktopEntitlementSlice, type DesktopEntitlementSlice } from './slices/desktopEntitlementSlice.js';
import { invalidateVisibleBasketCache } from './basketVisibleSet.js';

// Import constants for reset function
import { CAMERA_DEFAULTS, SECTION_PLANE_DEFAULTS, UI_DEFAULTS, TYPE_VISIBILITY_DEFAULTS } from './constants.js';

// Re-export types for consumers
export type * from './types.js';

// Explicitly re-export multi-model types that need to be imported by name
export type { EntityRef, SchemaVersion, FederatedModel, MeasurementConstraintEdge, OrthogonalAxis, SectionCapStyle, SectionCapHatchId, SectionPlane, SectionPlaneAxis } from './types.js';

// Re-export utility functions for entity references
export { entityRefToString, stringToEntityRef, entityRefEquals, isIfcxDataStore } from './types.js';

// Re-export single source of truth for globalId → EntityRef resolution
export { resolveEntityRef } from './resolveEntityRef.js';
export { fromGlobalIdFromModels, toGlobalIdFromModels, toGlobalIdForRef } from './globalId.js';

// Re-export Drawing2D types
export type { Drawing2DState, Drawing2DStatus, Annotation2DTool, PolygonArea2DResult, TextAnnotation2D, CloudAnnotation2D, SelectedAnnotation2D } from './slices/drawing2DSlice.js';

// Re-export Sheet types
export type { SheetState } from './slices/sheetSlice.js';

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

// Re-export Script types
export type { ScriptSlice } from './slices/scriptSlice.js';

// Re-export Chat types
export type { ChatSlice } from './slices/chatSlice.js';
export type { DesktopEntitlementSlice } from './slices/desktopEntitlementSlice.js';

// Re-export Cesium types
export type { CesiumSlice, CesiumDataSource } from './slices/cesiumSlice.js';

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
  ScriptSlice &
  ChatSlice &
  CesiumSlice &
  DesktopEntitlementSlice & {
    resetViewerState: () => void;
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
  ...createScriptSlice(...args),
  ...createChatSlice(...args),
  ...createCesiumSlice(...args),
  ...createDesktopEntitlementSlice(...args),

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

      // Selection (multi-model)
      selectedEntity: null,
      selectedEntitiesSet: new Set(),

      // Visibility (legacy)
      hiddenEntities: new Set(),
      isolatedEntities: null,
      classFilter: null,
      typeVisibility: {
        spaces: TYPE_VISIBILITY_DEFAULTS.SPACES,
        openings: TYPE_VISIBILITY_DEFAULTS.OPENINGS,
        site: TYPE_VISIBILITY_DEFAULTS.SITE,
      },

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
      cesiumTerrainClamp: false,
      cesiumSourceModelId: null,
      cesiumTerrainClipY: null,
      cesiumGlbLoaded: false,

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

      // Mutations - clear all mutation state so stale changes don't carry over
      mutationViews: new Map(),
      changeSets: new Map(),
      activeChangeSetId: null,
      undoStacks: new Map(),
      redoStacks: new Map(),
      dirtyModels: new Set(),
      mutationVersion: get().mutationVersion + 1,
    });
  },
}));

const STORE_SINGLETON_KEY = '__ifc_lite_viewer_store__';
const globalStoreRegistry = globalThis as typeof globalThis & {
  [STORE_SINGLETON_KEY]?: ReturnType<typeof createViewerStore>;
};

export function getViewerStoreApi() {
  return globalStoreRegistry[STORE_SINGLETON_KEY] ?? (
    globalStoreRegistry[STORE_SINGLETON_KEY] = createViewerStore()
  );
}

export const useViewerStore = getViewerStoreApi();
