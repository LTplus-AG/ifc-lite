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
import { isDuplicateClickPoint } from '@/components/viewer/measureHandlers.js';

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
   * drag, or the multi-click polyline mode. The two are mutually exclusive
   * within a Measure session — {@link setMeasureMode} clears whichever
   * in-progress state belongs to the mode being left, so a sequence started
   * in one can never leak into the other while the tool stays active.
   *
   * Leaving the Measure tool entirely is a *different* boundary, enforced by
   * {@link resetMeasureGesture}: `setActiveTool` (uiSlice.ts) calls it
   * whenever the tool changes away from `'measure'`, which is the only way
   * `MeasureOverlay` ever unmounts (it is gated purely on
   * `activeTool === 'measure'` — see `ToolOverlays.tsx`), so this one call
   * site covers every route out of the tool: toolbar click, keyboard
   * shortcut, or the panel's own Close button (which itself calls
   * `setActiveTool('select')`).
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
   *
   * `fromDoubleClick` opts into dropping the trailing near-duplicate point a
   * physical double-click leaves behind. It is OFF by default and belongs to
   * exactly one call site (useMouseControls.ts's `dblclick` handler) — see
   * the implementation for why every other finish path must not dedup.
   *
   * Returns whether a measurement was actually recorded, so a caller (the
   * Enter shortcut) can tell "finished" apart from "did nothing register"
   * and give feedback instead of leaving the no-op silent.
   */
  finishPolyline: (closed: boolean, options?: { fromDoubleClick?: boolean }) => boolean;
  /** Discard the in-progress polyline without recording a measurement. */
  cancelPolyline: () => void;
  deletePolylineMeasurement: (id: string) => void;

  /**
   * Discard whatever measurement gesture is in progress — a drag mid-flight
   * or a polyline click sequence — without touching finished measurements,
   * snap/geo toggles, or the user's last-picked {@link measureMode}.
   *
   * This is the single call `setActiveTool` (uiSlice.ts) makes whenever the
   * tool changes away from `'measure'`. See the {@link measureMode} doc
   * comment for why that one call site is enough to cover every way the
   * Measure tool can be left.
   */
  resetMeasureGesture: () => void;

  /**
   * Reset EVERY piece of state this slice owns to its just-loaded default —
   * finished measurements of both kinds, any in-progress gesture, the
   * relative-coordinate datum, and the gesture mode itself. This is the one
   * place a new model's `resetViewerState` (`store/index.ts`) reaches into
   * the measurement slice: a model switch is a new scene, and every field
   * here is either keyed to the outgoing model's geometry (world-space
   * points) or a session choice that should not silently outlive it.
   *
   * Deliberately broader than {@link clearMeasurements} (the user-facing
   * "Clear all" button), which intentionally PRESERVES `measureReferencePoint`
   * and `measureMode` — tidying up a distance list must not move the user's
   * setting-out origin or flip their tool mode underneath them. A model
   * switch has no such continuity to protect.
   *
   * #2641 review: `resetViewerState` used to list a hand-picked subset of
   * these fields inline (`measurements`, `activeMeasurement`, `snapTarget`,
   * `measureReferencePoint`) and silently missed `activePolyline`,
   * `polylineMeasurements` and `measureMode` — the previous model's
   * world-space polylines kept rendering against the new one. Owning the
   * full field list here, beside the state declarations, means a future
   * field added to this slice is far more likely to be added to this one
   * function than to be remembered at every call site that resets state.
   */
  resetAllMeasurementState: () => void;
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

    // Reproject a single point, returning it unchanged if the projector
    // can't place it (e.g. behind the camera) — same fallback the
    // measurements/activeMeasurement paths above use.
    const reprojectPoint = (point: MeasurePoint): MeasurePoint => {
      const screen = projectToScreen(point);
      const newX = screen?.x ?? point.screenX;
      const newY = screen?.y ?? point.screenY;
      if (newX !== point.screenX || newY !== point.screenY) {
        hasChanges = true;
      }
      return { ...point, screenX: newX, screenY: newY };
    };

    // Polyline points keep their click-time screenX/screenY forever unless
    // reprojected here too (#2641 review) — both the in-progress sequence
    // (segments/vertices/close-loop hit-testing all read live screen coords)
    // and every FINISHED polyline (its placed vertices are still rendered
    // and can still be re-selected after the camera moves).
    let updatedActivePolyline = state.activePolyline;
    if (state.activePolyline) {
      updatedActivePolyline = { points: state.activePolyline.points.map(reprojectPoint) };
    }

    const updatedPolylineMeasurements = state.polylineMeasurements.map((m) => ({
      ...m,
      points: m.points.map(reprojectPoint),
    }));

    // Early exit if nothing changed
    if (!hasChanges) {
      return;
    }

    set({
      measurements: updatedMeasurements,
      activeMeasurement: updatedActiveMeasurement,
      activePolyline: updatedActivePolyline,
      polylineMeasurements: updatedPolylineMeasurements,
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

  finishPolyline: (closed, options) => {
    // Reports whether a measurement was actually recorded (as opposed to a
    // no-op — no active sequence, or too few points to satisfy `minPoints`
    // even after dropping a double-click's duplicate). The Enter shortcut
    // (useKeyboardShortcuts.ts) uses this to tell "finished" apart from
    // "did nothing register" and surface a toast for the latter — Enter on
    // a 1-point sequence used to be silently indistinguishable from a
    // successful finish.
    let recorded = false;
    set((state) => {
      const active = state.activePolyline;
      if (!active) return {};
      // Browsers dispatch click, click, dblclick for one physical double-click
      // (never just dblclick) — handlePolylineClick runs on both leading
      // clicks before this fires from the dblclick handler, so a double-click
      // meant to "place the last point and finish" has already appended a
      // near-duplicate a few px from the one the user intended. Drop trailing
      // duplicate point(s) before validating/recording, mirroring
      // SpaceSketchOverlay's `commitDraw` (same double-click-to-close gesture,
      // same fix).
      //
      // SCOPED to that one gesture on purpose (#2641 review). The screen
      // coordinates this compares are not the click-time ones: the animation
      // loop's `updateMeasurementScreenCoords` reprojects every placed point
      // on every camera move, so after orbiting towards a top-down view two
      // genuinely distinct vertices separated along the view ray collapse to
      // within DUPLICATE_POINT_SCREEN_RADIUS_PX of each other. Running this
      // on the Enter path (useKeyboardShortcuts.ts) or the close-loop click
      // path (selectionHandlers.ts) would then delete real vertices and
      // report a short length with nothing on screen to say so. Neither of
      // those gestures synthesises an extra click — Enter appends nothing,
      // and a close-loop click returns before `addPolylinePoint` — so
      // neither can produce the duplicate this exists to remove.
      //
      // At most ONE point is dropped: the browser generates exactly one extra
      // `click` per double-click, so removing more could only ever be eating
      // a vertex the user placed on purpose.
      let points = active.points;
      if (
        options?.fromDoubleClick &&
        points.length >= 2 &&
        isDuplicateClickPoint(points[points.length - 1], points[points.length - 2])
      ) {
        points = points.slice(0, -1);
      }
      const minPoints = closed ? 3 : 2;
      if (points.length < minPoints) return {};
      measurementCounter++;
      const measurement: PolylineMeasurement = {
        id: `pl-${Date.now()}-${measurementCounter}`,
        points,
        closed,
        length: polylineLength(points, closed),
      };
      recorded = true;
      return {
        polylineMeasurements: [...state.polylineMeasurements, measurement],
        activePolyline: null,
      };
    });
    return recorded;
  },

  cancelPolyline: () => set({ activePolyline: null }),

  deletePolylineMeasurement: (id) => set((state) => ({
    polylineMeasurements: state.polylineMeasurements.filter((m) => m.id !== id),
  })),

  resetMeasureGesture: () => set({
    activeMeasurement: null,
    activePolyline: null,
    snapTarget: null,
    measurementConstraintEdge: null,
  }),

  resetAllMeasurementState: () => set({
    measurements: [],
    pendingMeasurePoint: null,
    activeMeasurement: null,
    snapTarget: null,
    snapVisualization: null,
    edgeLockState: getDefaultEdgeLockState(),
    measurementConstraintEdge: null,
    // #2199 §5: RENDERER-space datum belongs to the scene it was picked in —
    // a new file is a new scene, so (unlike clearMeasurements) this must go.
    measureReferencePoint: null,
    measureMode: 'drag',
    activePolyline: null,
    polylineMeasurements: [],
  }),
});
