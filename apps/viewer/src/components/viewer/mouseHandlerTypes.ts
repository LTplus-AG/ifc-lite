/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared types for extracted mouse handler functions.
 * Used by measureHandlers.ts, selectionHandlers.ts, and useMouseControls.ts.
 */

import type { MutableRefObject } from 'react';
import type { Renderer, PickResult, SnapTarget } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import type {
  MeasurePoint,
  SnapVisualization,
  ActiveMeasurement,
  EdgeLockState,
  SectionPlane,
} from '@/store';
import type { MeasurementConstraintEdge, OrthogonalAxis, Vec3 } from '@/store/types.js';

export interface MouseState {
  isDragging: boolean;
  isPanning: boolean;
  lastX: number;
  lastY: number;
  button: number;
  startX: number;
  startY: number;
  didDrag: boolean;
}

/**
 * Camera interface matching the subset of renderer Camera used by mouse handlers.
 */
export interface Camera {
  projectToScreen(pos: { x: number; y: number; z: number }, width: number, height: number): { x: number; y: number } | null;
  getPosition(): { x: number; y: number; z: number };
  getRotation(): { azimuth: number; elevation: number };
  getDistance(): number;
}

/**
 * Shared context passed to all extracted handler functions.
 * Contains refs, callbacks, and constants that the handlers need.
 */
export interface MouseHandlerContext {
  canvas: HTMLCanvasElement;
  renderer: Renderer;
  camera: Camera;
  mouseState: MouseState;

  // Tool/state refs
  activeToolRef: MutableRefObject<string>;
  activeMeasurementRef: MutableRefObject<ActiveMeasurement | null>;
  snapEnabledRef: MutableRefObject<boolean>;
  edgeLockStateRef: MutableRefObject<EdgeLockState>;
  measurementConstraintEdgeRef: MutableRefObject<MeasurementConstraintEdge | null>;
  /** Latest value of `sectionPickMode` from the section slice. */
  sectionPickModeRef: MutableRefObject<boolean>;
  /** Action: set plane through a world-space face. `position` is already
   * projected into 0-100% along the model bounds along the normal. */
  setSectionPlaneFromFace: (
    normal: [number, number, number],
    position: number,
  ) => void;
  /** Action: arm/disarm face-pick mode. */
  setSectionPickMode: (enabled: boolean) => void;

  // Visibility refs
  hiddenEntitiesRef: MutableRefObject<Set<number>>;
  isolatedEntitiesRef: MutableRefObject<Set<number> | null>;

  // Geometry refs
  geometryRef: MutableRefObject<MeshData[] | null>;

  // Measure raycast refs
  measureRaycastPendingRef: MutableRefObject<boolean>;
  measureRaycastFrameRef: MutableRefObject<number | null>;
  lastMeasureRaycastDurationRef: MutableRefObject<number>;
  lastHoverSnapTimeRef: MutableRefObject<number>;

  // Camera tracking
  lastCameraStateRef: MutableRefObject<{
    position: { x: number; y: number; z: number };
    rotation: { azimuth: number; elevation: number };
    distance: number;
    canvasWidth: number;
    canvasHeight: number;
  } | null>;

  // Click detection refs
  lastClickTimeRef: MutableRefObject<number>;
  lastClickPosRef: MutableRefObject<{ x: number; y: number } | null>;

  // Callbacks
  startMeasurement: (point: MeasurePoint) => void;
  updateMeasurement: (point: MeasurePoint) => void;
  finalizeMeasurement: () => void;
  setSnapTarget: (target: SnapTarget | null) => void;
  setSnapVisualization: (viz: Partial<SnapVisualization> | null) => void;
  setEdgeLock: (edge: { v0: { x: number; y: number; z: number }; v1: { x: number; y: number; z: number } }, meshExpressId: number, edgeT: number) => void;
  updateEdgeLockPosition: (edgeT: number, isCorner: boolean, cornerValence: number) => void;
  clearEdgeLock: () => void;
  incrementEdgeLockStrength: () => void;
  setMeasurementConstraintEdge: (edge: MeasurementConstraintEdge) => void;
  updateConstraintActiveAxis: (axis: OrthogonalAxis | null) => void;
  updateMeasurementScreenCoords: (projector: (worldPos: { x: number; y: number; z: number }) => { x: number; y: number } | null) => void;
  handlePickForSelection: (pickResult: PickResult | null) => void;
  toggleSelection: (entityId: number) => void;
  openContextMenu: (entityId: number | null, screenX: number, screenY: number) => void;
  hasPendingMeasurements: () => boolean;
  getPickOptions: () => { isStreaming: boolean; hiddenIds: Set<number>; isolatedIds: Set<number> | null };

  // Constants
  HOVER_SNAP_THROTTLE_MS: number;
  SLOW_RAYCAST_THRESHOLD_MS: number;
}
