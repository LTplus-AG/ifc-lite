/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Organized store selectors for the Viewport component
 * Groups 47+ store subscriptions into logical categories for better maintainability
 * Extracted from Viewport.tsx for reusability
 */

import { useViewerStore } from '../store.js';

/**
 * Selection-related store state and actions
 */
export function useSelectionState() {
  const selectedEntityId = useViewerStore((state) => state.selectedEntityId);
  const selectedEntityIds = useViewerStore((state) => state.selectedEntityIds);
  const setSelectedEntityId = useViewerStore((state) => state.setSelectedEntityId);
  const setSelectedEntity = useViewerStore((state) => state.setSelectedEntity);
  const toggleSelection = useViewerStore((state) => state.toggleSelection);
  const models = useViewerStore((state) => state.models);

  return {
    selectedEntityId,
    selectedEntityIds,
    setSelectedEntityId,
    setSelectedEntity,
    toggleSelection,
    models,
  };
}

/**
 * Visibility-related store state (hidden/isolated entities)
 */
export function useVisibilityState() {
  const hiddenEntities = useViewerStore((state) => state.hiddenEntities);
  const isolatedEntities = useViewerStore((state) => state.isolatedEntities);

  return {
    hiddenEntities,
    isolatedEntities,
  };
}

/**
 * Tool-related store state and actions
 */
export function useToolState() {
  const activeTool = useViewerStore((state) => state.activeTool);
  const sectionPlane = useViewerStore((state) => state.sectionPlane);
  const sectionPickMode = useViewerStore((state) => state.sectionPickMode);
  const setSectionPlaneFromFace = useViewerStore((state) => state.setSectionPlaneFromFace);
  const setSectionPickMode = useViewerStore((state) => state.setSectionPickMode);
  const setSectionCustomDistance = useViewerStore((state) => state.setSectionCustomDistance);

  return {
    activeTool,
    sectionPlane,
    sectionPickMode,
    setSectionPlaneFromFace,
    setSectionPickMode,
    setSectionCustomDistance,
  };
}

/**
 * Measurement-related store state and actions
 */
export function useMeasurementState() {
  // Basic measurement state
  const measurements = useViewerStore((state) => state.measurements);
  const pendingMeasurePoint = useViewerStore((state) => state.pendingMeasurePoint);
  const activeMeasurement = useViewerStore((state) => state.activeMeasurement);

  // Measurement actions
  const addMeasurePoint = useViewerStore((state) => state.addMeasurePoint);
  const completeMeasurement = useViewerStore((state) => state.completeMeasurement);
  const startMeasurement = useViewerStore((state) => state.startMeasurement);
  const updateMeasurement = useViewerStore((state) => state.updateMeasurement);
  const finalizeMeasurement = useViewerStore((state) => state.finalizeMeasurement);
  const cancelMeasurement = useViewerStore((state) => state.cancelMeasurement);
  const updateMeasurementScreenCoords = useViewerStore((state) => state.updateMeasurementScreenCoords);

  // Snap state
  const snapEnabled = useViewerStore((state) => state.snapEnabled);
  const setSnapTarget = useViewerStore((state) => state.setSnapTarget);
  const setSnapVisualization = useViewerStore((state) => state.setSnapVisualization);

  // Edge lock state for magnetic snapping
  const edgeLockState = useViewerStore((state) => state.edgeLockState);
  const setEdgeLock = useViewerStore((state) => state.setEdgeLock);
  const updateEdgeLockPosition = useViewerStore((state) => state.updateEdgeLockPosition);
  const clearEdgeLock = useViewerStore((state) => state.clearEdgeLock);
  const incrementEdgeLockStrength = useViewerStore((state) => state.incrementEdgeLockStrength);

  // Orthogonal constraint for shift+drag measurements
  const measurementConstraintEdge = useViewerStore((state) => state.measurementConstraintEdge);
  const setMeasurementConstraintEdge = useViewerStore((state) => state.setMeasurementConstraintEdge);
  const updateConstraintActiveAxis = useViewerStore((state) => state.updateConstraintActiveAxis);
  const clearMeasurementConstraintEdge = useViewerStore((state) => state.clearMeasurementConstraintEdge);

  return {
    // State
    measurements,
    pendingMeasurePoint,
    activeMeasurement,
    snapEnabled,
    edgeLockState,
    measurementConstraintEdge,

    // Actions
    addMeasurePoint,
    completeMeasurement,
    startMeasurement,
    updateMeasurement,
    finalizeMeasurement,
    cancelMeasurement,
    updateMeasurementScreenCoords,
    setSnapTarget,
    setSnapVisualization,
    setEdgeLock,
    updateEdgeLockPosition,
    clearEdgeLock,
    incrementEdgeLockStrength,
    setMeasurementConstraintEdge,
    updateConstraintActiveAxis,
    clearMeasurementConstraintEdge,
  };
}

/**
 * Camera-related store actions
 */
export function useCameraState() {
  const updateCameraRotationRealtime = useViewerStore((state) => state.updateCameraRotationRealtime);
  const updateScaleRealtime = useViewerStore((state) => state.updateScaleRealtime);
  const setCameraCallbacks = useViewerStore((state) => state.setCameraCallbacks);

  return {
    updateCameraRotationRealtime,
    updateScaleRealtime,
    setCameraCallbacks,
  };
}

/**
 * Hover/tooltip-related store state and actions
 */
export function useHoverState() {
  const hoverTooltipsEnabled = useViewerStore((state) => state.hoverTooltipsEnabled);
  const setHoverState = useViewerStore((state) => state.setHoverState);
  const clearHover = useViewerStore((state) => state.clearHover);

  return {
    hoverTooltipsEnabled,
    setHoverState,
    clearHover,
  };
}

/**
 * Theme-related store state
 */
export function useThemeState() {
  const theme = useViewerStore((state) => state.theme);
  const isMobile = useViewerStore((state) => state.isMobile);
  const visualEnhancementsEnabled = useViewerStore((state) => state.visualEnhancementsEnabled);
  const edgeContrastEnabled = useViewerStore((state) => state.edgeContrastEnabled);
  const edgeContrastIntensity = useViewerStore((state) => state.edgeContrastIntensity);
  const contactShadingQuality = useViewerStore((state) => state.contactShadingQuality);
  const contactShadingIntensity = useViewerStore((state) => state.contactShadingIntensity);
  const contactShadingRadius = useViewerStore((state) => state.contactShadingRadius);
  const separationLinesEnabled = useViewerStore((state) => state.separationLinesEnabled);
  const separationLinesQuality = useViewerStore((state) => state.separationLinesQuality);
  const separationLinesIntensity = useViewerStore((state) => state.separationLinesIntensity);
  const separationLinesRadius = useViewerStore((state) => state.separationLinesRadius);

  return {
    theme,
    isMobile,
    visualEnhancementsEnabled,
    edgeContrastEnabled,
    edgeContrastIntensity,
    contactShadingQuality,
    contactShadingIntensity,
    contactShadingRadius,
    separationLinesEnabled,
    separationLinesQuality,
    separationLinesIntensity,
    separationLinesRadius,
  };
}

/**
 * Context menu-related store actions
 */
export function useContextMenuState() {
  const openContextMenu = useViewerStore((state) => state.openContextMenu);

  return {
    openContextMenu,
  };
}

/**
 * Color update-related store state and actions
 */
export function useColorUpdateState() {
  const pendingColorUpdates = useViewerStore((state) => state.pendingColorUpdates);
  const pendingMeshColorUpdates = useViewerStore((state) => state.pendingMeshColorUpdates);
  const clearPendingColorUpdates = useViewerStore((state) => state.clearPendingColorUpdates);
  const clearPendingMeshColorUpdates = useViewerStore((state) => state.clearPendingMeshColorUpdates);

  return {
    pendingColorUpdates,
    pendingMeshColorUpdates,
    clearPendingColorUpdates,
    clearPendingMeshColorUpdates,
  };
}

/**
 * IFC data store state
 */
export function useIfcDataState() {
  const ifcDataStore = useViewerStore((state) => state.ifcDataStore);

  return {
    ifcDataStore,
  };
}

/**
 * All viewport-related selectors combined
 * Use individual hooks above for more granular control
 */
export function useViewerSelectors() {
  return {
    selection: useSelectionState(),
    visibility: useVisibilityState(),
    tools: useToolState(),
    measurement: useMeasurementState(),
    camera: useCameraState(),
    hover: useHoverState(),
    theme: useThemeState(),
    contextMenu: useContextMenuState(),
    colorUpdates: useColorUpdateState(),
    ifcData: useIfcDataState(),
  };
}
