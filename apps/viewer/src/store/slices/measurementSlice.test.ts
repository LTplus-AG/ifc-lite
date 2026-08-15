/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createMeasurementSlice, type MeasurementSlice } from './measurementSlice.js';

describe('MeasurementSlice', () => {
  let state: MeasurementSlice;
  let setState: (partial: Partial<MeasurementSlice> | ((state: MeasurementSlice) => Partial<MeasurementSlice>)) => void;
  let getState: () => MeasurementSlice;

  beforeEach(() => {
    // Create mock set/get functions
    setState = (partial) => {
      if (typeof partial === 'function') {
        const updates = partial(state);
        state = { ...state, ...updates };
      } else {
        state = { ...state, ...partial };
      }
    };
    getState = () => state;

    // Create slice with mock functions
    state = createMeasurementSlice(setState, getState, {} as any);
  });

  describe('initial state', () => {
    it('should have empty measurements array', () => {
      assert.deepStrictEqual(state.measurements, []);
    });

    it('should have null pending measure point', () => {
      assert.strictEqual(state.pendingMeasurePoint, null);
    });

    it('should have null active measurement', () => {
      assert.strictEqual(state.activeMeasurement, null);
    });

    it('should have snap enabled by default', () => {
      assert.strictEqual(state.snapEnabled, true);
    });
  });

  describe('addMeasurePoint', () => {
    it('should set pending measure point', () => {
      const point = { x: 1, y: 2, z: 3, screenX: 0, screenY: 0 };
      state.addMeasurePoint(point);
      assert.deepStrictEqual(state.pendingMeasurePoint, point);
    });
  });

  describe('completeMeasurement', () => {
    it('should create measurement when pending point exists', () => {
      const startPoint = { x: 0, y: 0, z: 0, screenX: 0, screenY: 0 };
      const endPoint = { x: 3, y: 4, z: 0, screenX: 0, screenY: 0 };

      state.addMeasurePoint(startPoint);
      state.completeMeasurement(endPoint);

      assert.strictEqual(state.measurements.length, 1);
      assert.deepStrictEqual(state.measurements[0].start, startPoint);
      assert.deepStrictEqual(state.measurements[0].end, endPoint);
      assert.strictEqual(state.measurements[0].distance, 5); // 3-4-5 triangle
      assert.strictEqual(state.pendingMeasurePoint, null);
    });

    it('should not create measurement when no pending point', () => {
      const endPoint = { x: 1, y: 1, z: 1, screenX: 0, screenY: 0 };
      state.completeMeasurement(endPoint);
      assert.strictEqual(state.measurements.length, 0);
    });

    it('should generate unique IDs for rapid measurements', () => {
      const point1 = { x: 0, y: 0, z: 0, screenX: 0, screenY: 0 };
      const point2 = { x: 1, y: 0, z: 0, screenX: 0, screenY: 0 };

      state.addMeasurePoint(point1);
      state.completeMeasurement(point2);

      state.addMeasurePoint(point1);
      state.completeMeasurement(point2);

      assert.strictEqual(state.measurements.length, 2);
      assert.notStrictEqual(state.measurements[0].id, state.measurements[1].id);
    });
  });

  describe('startMeasurement', () => {
    it('should initialize active measurement', () => {
      const point = { x: 1, y: 2, z: 3, screenX: 0, screenY: 0 };
      state.startMeasurement(point);

      assert.deepStrictEqual(state.activeMeasurement?.start, point);
      assert.deepStrictEqual(state.activeMeasurement?.current, point);
      assert.strictEqual(state.activeMeasurement?.distance, 0);
    });
  });

  describe('updateMeasurement', () => {
    it('should update current point and distance', () => {
      const startPoint = { x: 0, y: 0, z: 0, screenX: 0, screenY: 0 };
      const currentPoint = { x: 3, y: 4, z: 0, screenX: 0, screenY: 0 };

      state.startMeasurement(startPoint);
      state.updateMeasurement(currentPoint);

      assert.deepStrictEqual(state.activeMeasurement?.start, startPoint);
      assert.deepStrictEqual(state.activeMeasurement?.current, currentPoint);
      assert.strictEqual(state.activeMeasurement?.distance, 5);
    });

    it('should not update when no active measurement', () => {
      const point = { x: 1, y: 1, z: 1, screenX: 0, screenY: 0 };
      state.updateMeasurement(point);
      assert.strictEqual(state.activeMeasurement, null);
    });
  });

  describe('finalizeMeasurement', () => {
    it('should add completed measurement to list', () => {
      const startPoint = { x: 0, y: 0, z: 0, screenX: 0, screenY: 0 };
      const endPoint = { x: 1, y: 0, z: 0, screenX: 0, screenY: 0 };

      state.startMeasurement(startPoint);
      state.updateMeasurement(endPoint);
      state.finalizeMeasurement();

      assert.strictEqual(state.measurements.length, 1);
      assert.deepStrictEqual(state.measurements[0].start, startPoint);
      assert.deepStrictEqual(state.measurements[0].end, endPoint);
      assert.strictEqual(state.activeMeasurement, null);
    });

    it('should not add measurement when no active measurement', () => {
      state.finalizeMeasurement();
      assert.strictEqual(state.measurements.length, 0);
    });
  });

  describe('cancelMeasurement', () => {
    it('should clear active measurement', () => {
      state.startMeasurement({ x: 0, y: 0, z: 0, screenX: 0, screenY: 0 });
      state.cancelMeasurement();
      assert.strictEqual(state.activeMeasurement, null);
    });

    it('should clear snap target', () => {
      state.snapTarget = { type: 'vertex', position: [0, 0, 0] } as any;
      state.cancelMeasurement();
      assert.strictEqual(state.snapTarget, null);
    });
  });

  describe('deleteMeasurement', () => {
    it('should remove measurement by id', () => {
      state.startMeasurement({ x: 0, y: 0, z: 0, screenX: 0, screenY: 0 });
      state.updateMeasurement({ x: 1, y: 0, z: 0, screenX: 0, screenY: 0 });
      state.finalizeMeasurement();

      const id = state.measurements[0].id;
      state.deleteMeasurement(id);

      assert.strictEqual(state.measurements.length, 0);
    });

    it('should not affect other measurements', () => {
      // Create two measurements
      state.startMeasurement({ x: 0, y: 0, z: 0, screenX: 0, screenY: 0 });
      state.updateMeasurement({ x: 1, y: 0, z: 0, screenX: 0, screenY: 0 });
      state.finalizeMeasurement();

      state.startMeasurement({ x: 0, y: 0, z: 0, screenX: 0, screenY: 0 });
      state.updateMeasurement({ x: 2, y: 0, z: 0, screenX: 0, screenY: 0 });
      state.finalizeMeasurement();

      const firstId = state.measurements[0].id;
      state.deleteMeasurement(firstId);

      assert.strictEqual(state.measurements.length, 1);
      assert.strictEqual(state.measurements[0].distance, 2);
    });
  });

  describe('clearMeasurements', () => {
    it('should clear all measurements and state', () => {
      state.startMeasurement({ x: 0, y: 0, z: 0, screenX: 0, screenY: 0 });
      state.updateMeasurement({ x: 1, y: 0, z: 0, screenX: 0, screenY: 0 });
      state.finalizeMeasurement();

      state.addMeasurePoint({ x: 5, y: 5, z: 5, screenX: 0, screenY: 0 });

      state.clearMeasurements();

      assert.deepStrictEqual(state.measurements, []);
      assert.strictEqual(state.pendingMeasurePoint, null);
      assert.strictEqual(state.activeMeasurement, null);
    });
  });

  describe('toggleSnap', () => {
    it('should toggle snap from enabled to disabled', () => {
      assert.strictEqual(state.snapEnabled, true);
      state.toggleSnap();
      assert.strictEqual(state.snapEnabled, false);
    });

    it('should toggle snap from disabled to enabled', () => {
      state.snapEnabled = false;
      state.toggleSnap();
      assert.strictEqual(state.snapEnabled, true);
    });
  });

  // ── Multi-click polyline mode (#2199) ─────────────────────────────────

  const p = (x: number, y: number, z: number) => ({ x, y, z, screenX: x * 10, screenY: y * 10 });

  describe('polyline initial state', () => {
    it('defaults to drag mode with nothing accumulated', () => {
      assert.strictEqual(state.measureMode, 'drag');
      assert.strictEqual(state.activePolyline, null);
      assert.deepStrictEqual(state.polylineMeasurements, []);
    });
  });

  describe('startPolyline / addPolylinePoint (accumulating 3+ points)', () => {
    it('starts a sequence and accumulates points in order', () => {
      state.startPolyline(p(0, 0, 0));
      assert.deepStrictEqual(state.activePolyline?.points, [p(0, 0, 0)]);

      state.addPolylinePoint(p(3, 0, 0));
      state.addPolylinePoint(p(3, 4, 0));
      state.addPolylinePoint(p(0, 4, 0));

      assert.strictEqual(state.activePolyline?.points.length, 4);
      assert.deepStrictEqual(state.activePolyline?.points, [
        p(0, 0, 0), p(3, 0, 0), p(3, 4, 0), p(0, 4, 0),
      ]);
    });

    it('startPolyline is a no-op once a sequence is already active', () => {
      state.startPolyline(p(0, 0, 0));
      state.addPolylinePoint(p(1, 0, 0));
      state.startPolyline(p(99, 99, 99)); // must not reset or clobber
      assert.deepStrictEqual(state.activePolyline?.points, [p(0, 0, 0), p(1, 0, 0)]);
    });

    it('addPolylinePoint is a no-op with no sequence in progress', () => {
      state.addPolylinePoint(p(1, 1, 1));
      assert.strictEqual(state.activePolyline, null);
    });
  });

  describe('finishPolyline — the finish gesture, open vs. closed', () => {
    it('finishes OPEN: length is the sum of segments, no closing segment', () => {
      // 3-4-5 right triangle path: legs 3 and 4.
      state.startPolyline(p(0, 0, 0));
      state.addPolylinePoint(p(3, 0, 0));
      state.addPolylinePoint(p(3, 4, 0));
      state.finishPolyline(false);

      assert.strictEqual(state.activePolyline, null, 'finishing clears the in-progress sequence');
      assert.strictEqual(state.polylineMeasurements.length, 1);
      const m = state.polylineMeasurements[0];
      assert.strictEqual(m.closed, false);
      assert.strictEqual(m.length, 7); // 3 + 4, no hypotenuse
    });

    it('finishes CLOSED: length is the perimeter (adds the closing segment)', () => {
      state.startPolyline(p(0, 0, 0));
      state.addPolylinePoint(p(3, 0, 0));
      state.addPolylinePoint(p(3, 4, 0));
      state.finishPolyline(true);

      assert.strictEqual(state.polylineMeasurements.length, 1);
      const m = state.polylineMeasurements[0];
      assert.strictEqual(m.closed, true);
      assert.strictEqual(m.length, 12); // 3 + 4 + 5 (hypotenuse closes the loop)
    });

    it('open and closed report DIFFERENT numbers for the identical points', () => {
      const points = [p(0, 0, 0), p(3, 0, 0), p(3, 4, 0)];

      state.startPolyline(points[0]);
      state.addPolylinePoint(points[1]);
      state.addPolylinePoint(points[2]);
      state.finishPolyline(false);
      const openLength = state.polylineMeasurements[0].length;

      state.startPolyline(points[0]);
      state.addPolylinePoint(points[1]);
      state.addPolylinePoint(points[2]);
      state.finishPolyline(true);
      const closedLength = state.polylineMeasurements[1].length;

      assert.notStrictEqual(openLength, closedLength);
      assert.strictEqual(state.polylineMeasurements[0].closed, false);
      assert.strictEqual(state.polylineMeasurements[1].closed, true);
    });

    it('rejects finishing OPEN with fewer than 2 points (no-op)', () => {
      state.startPolyline(p(0, 0, 0));
      state.finishPolyline(false);
      assert.strictEqual(state.polylineMeasurements.length, 0);
      assert.ok(state.activePolyline, 'sequence must still be in progress, not silently dropped');
    });

    it('rejects finishing CLOSED with fewer than 3 points (no-op)', () => {
      state.startPolyline(p(0, 0, 0));
      state.addPolylinePoint(p(1, 0, 0));
      state.finishPolyline(true);
      assert.strictEqual(state.polylineMeasurements.length, 0);
      assert.ok(state.activePolyline, 'a 2-point loop has no interior — must not be recorded as closed');
    });

    it('is a no-op with nothing in progress', () => {
      state.finishPolyline(false);
      assert.strictEqual(state.polylineMeasurements.length, 0);
    });

    // PR #2641 review — Enter on a 1-point sequence was a silent no-op: the
    // Enter shortcut called finishPolyline(false) unconditionally, and
    // finishPolyline had no way to tell its caller "nothing happened" so the
    // keyboard handler could not surface feedback. finishPolyline's return
    // value is that signal — the Enter handler in useKeyboardShortcuts.ts
    // shows a toast when it comes back false.
    it('reports success/failure via its return value so callers can give feedback on a no-op', () => {
      state.startPolyline(p(0, 0, 0));
      assert.strictEqual(state.finishPolyline(false), false, 'fewer than 2 points must report failure, not just silently return');

      state.addPolylinePoint(p(3, 4, 0));
      assert.strictEqual(state.finishPolyline(false), true, 'a valid 2-point open polyline must report success');
    });

    it('reports failure when nothing is in progress', () => {
      assert.strictEqual(state.finishPolyline(false), false);
    });
  });

  describe('finishPolyline — double-click-to-finish does not duplicate the last point', () => {
    // Browsers dispatch click, click, dblclick for one physical double-click
    // (never just dblclick). handlePolylineClick runs on both leading
    // clicks, so by the time finishPolyline(false) fires from the dblclick
    // handler, the sequence already has a near-duplicate point appended a
    // few CSS px from the one the user intended as the final vertex.
    it('drops the trailing near-duplicate point before recording the measurement', () => {
      state.startPolyline({ x: 0, y: 0, z: 0, screenX: 0, screenY: 0 });
      state.addPolylinePoint({ x: 3, y: 0, z: 0, screenX: 100, screenY: 0 });
      // First `click` of the physical double-click:
      state.addPolylinePoint({ x: 3, y: 4, z: 0, screenX: 100, screenY: 100 });
      // Second `click` of the SAME physical double-click — ~1.4px away on
      // screen, a hair off in world space (real raycasts of two closely
      // spaced pixels rarely land on the exact same world point):
      state.addPolylinePoint({ x: 3.001, y: 4.001, z: 0, screenX: 101, screenY: 101 });
      state.finishPolyline(false);

      assert.strictEqual(state.polylineMeasurements.length, 1);
      const m = state.polylineMeasurements[0];
      assert.strictEqual(m.points.length, 3, 'the duplicate must not survive into the recorded measurement');
      // Length matches the 3-4-5 triangle's two legs, not a triangle plus a
      // near-zero extra segment.
      assert.ok(Math.abs(m.length - 7) < 0.01, `expected ~7, got ${m.length}`);
    });

    it('keeps a deliberate point placed outside the duplicate-click radius', () => {
      state.startPolyline({ x: 0, y: 0, z: 0, screenX: 0, screenY: 0 });
      state.addPolylinePoint({ x: 3, y: 0, z: 0, screenX: 100, screenY: 0 });
      // 3-4-5 triangle's third vertex again, but this time in world space it
      // is genuinely > the duplicate-click screen radius from the previous
      // point — a real, separate click.
      state.addPolylinePoint({ x: 3, y: 4, z: 0, screenX: 100, screenY: 100 });
      state.finishPolyline(false);

      assert.strictEqual(state.polylineMeasurements[0].points.length, 3);
    });

    it('a double-click placing (and finishing on) the first point stays a no-op (below minPoints after dedup)', () => {
      // startPolyline already seeds point 1; a physical double-click right
      // after that appends only ONE more near-duplicate point (the click
      // that lands, then the dblclick that finishes) — so after dropping the
      // duplicate, only 1 point remains, one short of the 2 an open polyline
      // needs.
      state.startPolyline({ x: 0, y: 0, z: 0, screenX: 0, screenY: 0 });
      state.addPolylinePoint({ x: 0.001, y: 0.001, z: 0, screenX: 1, screenY: 1 });
      state.finishPolyline(false);

      assert.strictEqual(state.polylineMeasurements.length, 0);
      assert.ok(state.activePolyline, 'sequence must still be in progress, not silently dropped');
    });
  });

  describe('cancelPolyline (cancel mid-sequence)', () => {
    it('discards an in-progress sequence without recording a measurement', () => {
      state.startPolyline(p(0, 0, 0));
      state.addPolylinePoint(p(1, 0, 0));
      state.addPolylinePoint(p(1, 1, 0));

      state.cancelPolyline();

      assert.strictEqual(state.activePolyline, null);
      assert.deepStrictEqual(state.polylineMeasurements, [], 'cancel must not record anything');
    });

    it('is a no-op with nothing in progress', () => {
      state.cancelPolyline();
      assert.strictEqual(state.activePolyline, null);
    });
  });

  describe('deletePolylineMeasurement', () => {
    it('removes a finished polyline by id without touching others', () => {
      state.startPolyline(p(0, 0, 0));
      state.addPolylinePoint(p(1, 0, 0));
      state.finishPolyline(false);

      state.startPolyline(p(0, 0, 0));
      state.addPolylinePoint(p(2, 0, 0));
      state.finishPolyline(false);

      const firstId = state.polylineMeasurements[0].id;
      state.deletePolylineMeasurement(firstId);

      assert.strictEqual(state.polylineMeasurements.length, 1);
      assert.strictEqual(state.polylineMeasurements[0].length, 2);
    });
  });

  describe('clearMeasurements also clears polyline state', () => {
    it('drops both an in-progress sequence and finished polylines', () => {
      state.startPolyline(p(0, 0, 0));
      state.addPolylinePoint(p(1, 0, 0));
      state.finishPolyline(false);
      state.startPolyline(p(5, 5, 5)); // leave one in progress too

      state.clearMeasurements();

      assert.strictEqual(state.activePolyline, null);
      assert.deepStrictEqual(state.polylineMeasurements, []);
    });
  });

  describe('setMeasureMode — the two gestures cannot corrupt each other', () => {
    it('entering polyline mode cancels an in-progress DRAG measurement', () => {
      state.startMeasurement(p(0, 0, 0));
      state.updateMeasurement(p(1, 0, 0));
      assert.ok(state.activeMeasurement, 'precondition: a drag is in progress');

      state.setMeasureMode('polyline');

      assert.strictEqual(state.measureMode, 'polyline');
      assert.strictEqual(state.activeMeasurement, null, 'drag state must not survive the mode switch');
    });

    it('leaving polyline mode discards an in-progress CLICK sequence', () => {
      state.setMeasureMode('polyline');
      state.startPolyline(p(0, 0, 0));
      state.addPolylinePoint(p(1, 0, 0));
      assert.ok(state.activePolyline, 'precondition: a polyline sequence is in progress');

      state.setMeasureMode('drag');

      assert.strictEqual(state.measureMode, 'drag');
      assert.strictEqual(state.activePolyline, null, 'polyline state must not survive the mode switch');
    });

    it('switching to the mode already active is a no-op (state undisturbed)', () => {
      state.setMeasureMode('polyline');
      state.startPolyline(p(0, 0, 0));
      state.addPolylinePoint(p(1, 0, 0));

      state.setMeasureMode('polyline'); // already polyline — must not cancel itself

      assert.ok(state.activePolyline, 'a same-mode switch must not discard the in-progress sequence');
      assert.strictEqual(state.activePolyline?.points.length, 2);
    });

    it('a finished measurement list of either kind survives a mode switch', () => {
      // Only IN-PROGRESS state is mode-exclusive; completed measurements are
      // not gestures in progress and must not be touched by switching modes.
      state.startMeasurement(p(0, 0, 0));
      state.updateMeasurement(p(1, 0, 0));
      state.finalizeMeasurement();

      state.setMeasureMode('polyline');
      state.startPolyline(p(0, 0, 0));
      state.addPolylinePoint(p(1, 0, 0));
      state.addPolylinePoint(p(1, 1, 0));
      state.finishPolyline(false);

      state.setMeasureMode('drag');

      assert.strictEqual(state.measurements.length, 1);
      assert.strictEqual(state.polylineMeasurements.length, 1);
    });
  });
});
