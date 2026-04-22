/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Re-export from modular store for backward compatibility
 *
 * The store has been refactored into domain-specific slices:
 * - loadingSlice: Loading, progress, error state
 * - selectionSlice: Entity and storey selection
 * - visibilitySlice: Hidden/isolated entities, type visibility
 * - uiSlice: Panel state, theme, mobile detection
 * - hoverSlice: Hover and context menu state
 * - cameraSlice: Camera rotation and callbacks
 * - sectionSlice: Section plane state
 * - measurementSlice: Measurements, snapping, edge lock
 * - dataSlice: IFC data and geometry
 *
 * See apps/viewer/src/store/ for the modular implementation.
 */

// Re-export everything from the modular store
export { getViewerStoreApi, useViewerStore } from './store/index.js';
export type { ViewerState } from './store/index.js';

// Re-export types for backward compatibility
export type {
  MeasurePoint,
  Measurement,
  ActiveMeasurement,
  EdgeLockState,
  SectionPlaneAxis,
  SectionPlane,
  HoverState,
  ContextMenuState,
  SnapVisualization,
  TypeVisibility,
  CameraRotation,
  CameraCallbacks,
  // Multi-model federation types
  EntityRef,
  SchemaVersion,
  FederatedModel,
} from './store/types.js';

// Re-export utility functions for multi-model federation
export { entityRefToString, stringToEntityRef, entityRefEquals, isIfcxDataStore } from './store/types.js';

// Re-export single source of truth for globalId → EntityRef resolution
export { resolveEntityRef } from './store/resolveEntityRef.js';
export { toGlobalIdFromModels, fromGlobalIdFromModels, toGlobalIdForRef } from './store/globalId.js';
export type { ForwardModelMapLike } from './store/globalId.js';

// Re-export Schedule (4D) types + helpers
export type { ScheduleSlice, ScheduleTimeRange, GanttTimeScale } from './store/slices/scheduleSlice.js';
export {
  computeScheduleRange,
  computeHiddenProductIds,
  computeActiveProductIds,
  countGeneratedTasks,
  taskStartEpoch,
  taskFinishEpoch,
  parseIsoDate,
} from './store/slices/scheduleSlice.js';
