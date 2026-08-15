/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Measurement state slice
 */

import type { StateCreator } from 'zustand';
import type { SnapTarget } from '@ifc-lite/renderer';
import type {
  Vec3,
  MeasurePoint,
  Measurement,
  ActiveMeasurement,
  EdgeLockState,
  SnapVisualization,
  MeasurementConstraintEdge,
  OrthogonalAxis,
  MeasureMode,
  ActivePolyline,
  PolylineMeasurement,
} from '../types.js';
import { EDGE_LOCK_DEFAULTS } from '../constants.js';
import { polylineLength } from '@/components/viewer/tools/measure-modes/polyline.js';

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
  /**
   * Temporary reference point for relative coordinate readouts (#2199 §5),
   * in RENDERER space (Y-up metres) — the same frame picked points arrive in,
   * so the offset is a plain subtraction with no frame conversion in between.
   *
   * Deliberately NOT cleared by {@link clearMeasurements}: the reference is a
   * setting-out datum the user established on purpose, and wiping it while
   * tidying up a list of distances would silently change what every later
   * coordinate readout is relative to.
   */
  measureReferencePoint: Vec3 | null;

  /**
   * Which Measure gesture is active (#2199): the original mousedown→mouseup
   * drag, or the multi-click polyline mode. The two are mutually exclusive —
   * {@link setMeasureMode} clears whichever in-progress state belongs to the
   * mode being left, so a sequence started in one can never leak into the
   * other.
   */
  measureMode: MeasureMode;
  /** A polyline sequence in progress (points accumulated via clicks, not yet finished). */
  activePolyline: ActivePolyline | null;
  /** Finished polyline measurements — kept separate from `measurements`
   *  (distance-only) rather than folded in, since they carry an extra basis
   *  (open length vs. closed perimeter) that a drag measurement never has. */
  polylineMeasurements: PolylineMeasurement[];

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

  /** Set or clear the temporary reference point for relative coordinates. */
  setMeasureReferencePoint: (point: Vec3 | null) => void;

  // Edge lock actions
  setEdgeLock: (edge: EdgeLockState['edge'], meshExpressId: number | null, edgeT?: number) => void;
  updateEdgeLockPosition: (edgeT: number, isCorner: boolean, cornerValence: number) => void;
  clearEdgeLock: () => void;
  incrementEdgeLockStrength: () => void;

  // Orthogonal constraint actions (shift+drag)
  setMeasurementConstraintEdge: (edge: MeasurementConstraintEdge | null) => void;
  updateConstraintActiveAxis: (axis: OrthogonalAxis | null) => void;
  clearMeasurementConstraintEdge: () => void;

  // Polyline (multi-click) measurement actions (#2199)
  /** Switch gesture. Leaving 'drag' cancels any in-progress drag measurement;
   *  leaving 'polyline' discards any in-progress click sequence. A no-op if
   *  already in the requested mode (does not disturb in-progress state). */
  setMeasureMode: (mode: MeasureMode) => void;
  /** Begin a polyline sequence at `point`. No-op if one is already active —
   *  use {@link addPolylinePoint} to extend it. */
  startPolyline: (point: MeasurePoint) => void;
  /** Append a point to the in-progress polyline. No-op if none is active. */
  addPolylinePoint: (point: MeasurePoint) => void;
  /**
   * Finish the in-progress polyline and push it to `polylineMeasurements`.
   * `closed` is the caller's explicit basis (the click handler decides this
   * from screen-space proximity to the first point; Enter/double-click
   * always finish open) — never inferred here. No-op if fewer than 2 points
   * are accumulated (or fewer than 3 for `closed`, since a 2-point loop has
   * no interior).
   */
  finishPolyline: (closed: boolean) => void;
  /** Discard the in-progress polyline without recording a measurement. */
  cancelPolyline: () => void;
  deletePolylineMeasurement: (id: string) => void;
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
  measureReferencePoint: null,
  measureMode: 'drag',
  activePolyline: null,
  polylineMeasurements: [],

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
    // "Clear all" clears every kind of measurement the panel lists,
    // including any polyline sequence still in progress — a partial
    // click-sequence left behind by "clear" would be a stale trap.
    activePolyline: null,
    polylineMeasurements: [],
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

  setMeasureReferencePoint: (measureReferencePoint) => set({ measureReferencePoint }),

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

  // Polyline (multi-click) measurement actions (#2199)
  setMeasureMode: (mode) => set((state) => {
    if (mode === state.measureMode) return {};
    if (mode === 'polyline') {
      // Entering polyline mode: cancel any in-progress drag so the two
      // gestures can never both be "active" at once.
      return {
        measureMode: mode,
        activeMeasurement: null,
        snapTarget: null,
        measurementConstraintEdge: null,
      };
    }
    // Leaving polyline mode: discard any in-progress click sequence.
    return { measureMode: mode, activePolyline: null };
  }),

  startPolyline: (point) => set((state) => {
    if (state.activePolyline) return {}; // already accumulating — use addPolylinePoint
    return { activePolyline: { points: [point] } };
  }),

  addPolylinePoint: (point) => set((state) => {
    if (!state.activePolyline) return {};
    return { activePolyline: { points: [...state.activePolyline.points, point] } };
  }),

  finishPolyline: (closed) => set((state) => {
    const active = state.activePolyline;
    if (!active) return {};
    const minPoints = closed ? 3 : 2;
    if (active.points.length < minPoints) return {};
    measurementCounter++;
    const measurement: PolylineMeasurement = {
      id: `pl-${Date.now()}-${measurementCounter}`,
      points: active.points,
      closed,
      length: polylineLength(active.points, closed),
    };
    return {
      polylineMeasurements: [...state.polylineMeasurements, measurement],
      activePolyline: null,
    };
  }),

  cancelPolyline: () => set({ activePolyline: null }),

  deletePolylineMeasurement: (id) => set((state) => ({
    polylineMeasurements: state.polylineMeasurements.filter((m) => m.id !== id),
  })),
});
