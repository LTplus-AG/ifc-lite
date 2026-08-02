/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Measurement state slice
 */

import type { StateCreator } from 'zustand';
import type { SnapTarget } from '@ifc-lite/renderer';
import type {
  MeasurePoint,
  Measurement,
  ActiveMeasurement,
  EdgeLockState,
  SnapVisualization,
  MeasurementConstraintEdge,
  OrthogonalAxis,
} from '../types.js';
import { EDGE_LOCK_DEFAULTS } from '../constants.js';

// Monotonic counter to prevent ID collisions under rapid measurement creation
let measurementCounter = 0;

export interface MeasurementSlice {
  // State
  measurements: Measurement[];
  pendingMeasurePoint: MeasurePoint | null;
  activeMeasurement: ActiveMeasurement | null;
  snapTarget: SnapTarget | null;
  snapEnabled: boolean;
  /**
   * When on, the Measure tool shows real-world projected coordinates
   * (Eastings / Northings / Height) for picked points, derived from the
   * anchor model's IfcMapConversion. Only meaningful for georeferenced models
   * (the toggle is hidden otherwise). Mirrors {@link snapEnabled}.
   */
  geoReadoutEnabled: boolean;
  snapVisualization: SnapVisualization | null;
  edgeLockState: EdgeLockState;
  /** Edge constraint for perpendicular measurements (when shift is held) */
  measurementConstraintEdge: MeasurementConstraintEdge | null;

  // Legacy measurement actions
  addMeasurePoint: (point: MeasurePoint) => void;
  completeMeasurement: (endPoint: MeasurePoint) => void;

  // Drag-based measurement actions
  startMeasurement: (point: MeasurePoint) => void;
  updateMeasurement: (point: MeasurePoint) => void;
  finalizeMeasurement: () => void;
  cancelMeasurement: () => void;
  deleteMeasurement: (id: string) => void;
  clearMeasurements: () => void;
  updateMeasurementScreenCoords: (
    projectToScreen: (worldPos: { x: number; y: number; z: number }) => { x: number; y: number } | null
  ) => void;

  // Snap actions
  setSnapTarget: (target: SnapTarget | null) => void;
  setSnapVisualization: (viz: SnapVisualization | null) => void;
  toggleSnap: () => void;

  // Geo readout actions
  toggleGeoReadout: () => void;

  // Edge lock actions
  setEdgeLock: (edge: EdgeLockState['edge'], meshExpressId: number | null, edgeT?: number) => void;
  updateEdgeLockPosition: (edgeT: number, isCorner: boolean, cornerValence: number) => void;
  clearEdgeLock: () => void;
  incrementEdgeLockStrength: () => void;

  // Orthogonal constraint actions (shift+drag)
  setMeasurementConstraintEdge: (edge: MeasurementConstraintEdge | null) => void;
  updateConstraintActiveAxis: (axis: OrthogonalAxis | null) => void;
  clearMeasurementConstraintEdge: () => void;
}

const getDefaultEdgeLockState = (): EdgeLockState => ({
  edge: null,
  meshExpressId: null,
  edgeT: 0,
  lockStrength: 0,
  isCorner: false,
  cornerValence: 0,
});

export const createMeasurementSlice: StateCreator<MeasurementSlice, [], [], MeasurementSlice> = (set, get) => ({
  // Initial state
  measurements: [],
  pendingMeasurePoint: null,
  activeMeasurement: null,
  snapTarget: null,
  snapEnabled: true,
  geoReadoutEnabled: false,
  snapVisualization: null,
  edgeLockState: getDefaultEdgeLockState(),
  measurementConstraintEdge: null,

  // Legacy measurement actions
  addMeasurePoint: (point) => set({ pendingMeasurePoint: point }),

  completeMeasurement: (endPoint) => set((state) => {
    if (!state.pendingMeasurePoint) return {};
    const start = state.pendingMeasurePoint;
    const distance = Math.sqrt(
      Math.pow(endPoint.x - start.x, 2) +
      Math.pow(endPoint.y - start.y, 2) +
      Math.pow(endPoint.z - start.z, 2)
    );
    // Use counter combined with timestamp to guarantee unique IDs
    measurementCounter++;
    const measurement: Measurement = {
      id: `m-${Date.now()}-${measurementCounter}`,
      start,
      end: endPoint,
      distance,
    };
    return {
      measurements: [...state.measurements, measurement],
      pendingMeasurePoint: null,
    };
  }),

  // Drag-based measurement actions
  startMeasurement: (point) => set({
    activeMeasurement: {
      start: point,
      current: point,
      distance: 0,
    },
  }),

  updateMeasurement: (point) => set((state) => {
    if (!state.activeMeasurement) return {};
    const start = state.activeMeasurement.start;
    const distance = Math.sqrt(
      Math.pow(point.x - start.x, 2) +
      Math.pow(point.y - start.y, 2) +
      Math.pow(point.z - start.z, 2)
    );
    return {
      activeMeasurement: {
        start,
        current: point,
        distance,
      },
    };
  }),

  finalizeMeasurement: () => set((state) => {
    if (!state.activeMeasurement) return {};
    // Use counter combined with timestamp to guarantee unique IDs
    measurementCounter++;
    const measurement: Measurement = {
      id: `m-${Date.now()}-${measurementCounter}`,
      start: state.activeMeasurement.start,
      end: state.activeMeasurement.current,
      distance: state.activeMeasurement.distance,
    };
    return {
      measurements: [...state.measurements, measurement],
      activeMeasurement: null,
      snapTarget: null,
      measurementConstraintEdge: null,
    };
  }),

  cancelMeasurement: () => set({
    activeMeasurement: null,
    snapTarget: null,
    measurementConstraintEdge: null,
  }),

  deleteMeasurement: (id) => set((state) => ({
    measurements: state.measurements.filter((m) => m.id !== id),
  })),

  clearMeasurements: () => set({
    measurements: [],
    pendingMeasurePoint: null,
    activeMeasurement: null,
    snapTarget: null,
  }),

  updateMeasurementScreenCoords: (projectToScreen) => {
    const state = get();
    let hasChanges = false;

    // Check completed measurements for changes
    const updatedMeasurements = state.measurements.map((m) => {
      const startScreen = projectToScreen(m.start);
      const endScreen = projectToScreen(m.end);

      const newStartX = startScreen?.x ?? m.start.screenX;
      const newStartY = startScreen?.y ?? m.start.screenY;
      const newEndX = endScreen?.x ?? m.end.screenX;
      const newEndY = endScreen?.y ?? m.end.screenY;

      if (
        newStartX !== m.start.screenX ||
        newStartY !== m.start.screenY ||
        newEndX !== m.end.screenX ||
        newEndY !== m.end.screenY
      ) {
        hasChanges = true;
      }

      return {
        ...m,
        start: { ...m.start, screenX: newStartX, screenY: newStartY },
        end: { ...m.end, screenX: newEndX, screenY: newEndY },
      };
    });

    // Check active measurement for changes
    let updatedActiveMeasurement = state.activeMeasurement;
    if (state.activeMeasurement) {
      const startScreen = projectToScreen(state.activeMeasurement.start);
      const currentScreen = projectToScreen(state.activeMeasurement.current);

      const newStartX = startScreen?.x ?? state.activeMeasurement.start.screenX;
      const newStartY = startScreen?.y ?? state.activeMeasurement.start.screenY;
      const newCurrentX = currentScreen?.x ?? state.activeMeasurement.current.screenX;
      const newCurrentY = currentScreen?.y ?? state.activeMeasurement.current.screenY;

      if (
        newStartX !== state.activeMeasurement.start.screenX ||
        newStartY !== state.activeMeasurement.start.screenY ||
        newCurrentX !== state.activeMeasurement.current.screenX ||
        newCurrentY !== state.activeMeasurement.current.screenY
      ) {
        hasChanges = true;
      }

      updatedActiveMeasurement = {
        ...state.activeMeasurement,
        start: { ...state.activeMeasurement.start, screenX: newStartX, screenY: newStartY },
        current: { ...state.activeMeasurement.current, screenX: newCurrentX, screenY: newCurrentY },
      };
    }

    // Early exit if nothing changed
    if (!hasChanges) {
      return;
    }

    set({
      measurements: updatedMeasurements,
      activeMeasurement: updatedActiveMeasurement,
    });
  },

  // Snap actions
  setSnapTarget: (snapTarget) => set({ snapTarget }),
  setSnapVisualization: (snapVisualization) => set({ snapVisualization }),
  toggleSnap: () => set((state) => ({ snapEnabled: !state.snapEnabled })),

  // Geo readout actions
  toggleGeoReadout: () => set((state) => ({ geoReadoutEnabled: !state.geoReadoutEnabled })),

  // Edge lock actions
  setEdgeLock: (edge, meshExpressId, edgeT = EDGE_LOCK_DEFAULTS.INITIAL_T) => set({
    edgeLockState: {
      edge,
      meshExpressId,
      edgeT,
      lockStrength: EDGE_LOCK_DEFAULTS.INITIAL_STRENGTH,
      isCorner: false,
      cornerValence: 0,
    },
  }),

  updateEdgeLockPosition: (edgeT, isCorner, cornerValence) => set((state) => ({
    edgeLockState: {
      ...state.edgeLockState,
      edgeT,
      isCorner,
      cornerValence,
    },
  })),

  clearEdgeLock: () => set({ edgeLockState: getDefaultEdgeLockState() }),

  incrementEdgeLockStrength: () => set((state) => ({
    edgeLockState: {
      ...state.edgeLockState,
      lockStrength: Math.min(
        state.edgeLockState.lockStrength + EDGE_LOCK_DEFAULTS.STRENGTH_INCREMENT,
        EDGE_LOCK_DEFAULTS.MAX_STRENGTH
      ),
    },
  })),

  // Orthogonal constraint actions
  setMeasurementConstraintEdge: (edge) => set({ measurementConstraintEdge: edge }),
  updateConstraintActiveAxis: (axis) => set((state) => {
    if (!state.measurementConstraintEdge) return {};
    return {
      measurementConstraintEdge: {
        ...state.measurementConstraintEdge,
        activeAxis: axis,
      },
    };
  }),
  clearMeasurementConstraintEdge: () => set({ measurementConstraintEdge: null }),
});
