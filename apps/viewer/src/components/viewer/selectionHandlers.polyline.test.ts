/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `handlePolylineClick` (#2199) is the click-routing state machine for the
 * Measure tool's multi-click mode: start / accumulate / close-the-loop, all
 * from one click. These tests drive it against the REAL store (the function
 * reads/writes `useViewerStore.getState()` directly, the same pattern the
 * pre-existing addElement click flow in this file already uses) so the
 * store's own invariants (mode exclusivity, minimum point counts) are
 * exercised for real rather than through a mock.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { handlePolylineClick, finishPolylineFromDoubleClick } from './selectionHandlers.js';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';

type Projector = (p: { x: number; y: number; z: number }) => { x: number; y: number };

/** The default camera: a world point raycasts to itself, screen (x, y). */
const elevation: Projector = (p) => ({ x: p.x, y: p.y });

/**
 * A world point that raycasts to itself. `project` stands in for the camera
 * orientation — swapping it is how a test "orbits" between clicks.
 */
function fakeCtx(
  hit: { x: number; y: number; z: number } | null,
  project: Projector = elevation,
): MouseHandlerContext {
  const canvas = document.createElement('canvas');
  const camera = {
    projectToScreen: (p: { x: number; y: number; z: number }) => project(p),
    getPosition: () => ({ x: 0, y: 0, z: 0 }),
    getRotation: () => ({ azimuth: 0, elevation: 0 }),
    getDistance: () => 10,
  };
  const renderer = {
    raycastSceneMagnetic: () => ({
      intersection: hit ? { point: hit } : null,
      snapTarget: null,
      edgeLock: { edge: null, meshExpressId: null, edgeT: 0, shouldLock: false, shouldRelease: true, isCorner: false, cornerValence: 0 },
    }),
  };
  return {
    canvas,
    renderer,
    camera,
    mouseState: { isDragging: false, isPanning: false, lastX: 0, lastY: 0, button: 0, startX: 0, startY: 0, didDrag: false },
    activeToolRef: { current: 'measure' },
    snapEnabledRef: { current: true },
    edgeLockStateRef: { current: { edge: null, meshExpressId: null, edgeT: 0, lockStrength: 0, isCorner: false, cornerValence: 0 } },
    hiddenEntitiesRef: { current: new Set() },
    isolatedEntitiesRef: { current: null },
    setSnapTarget: () => {},
  } as unknown as MouseHandlerContext;
}

describe('handlePolylineClick', () => {
  beforeEach(() => {
    useViewerStore.setState({
      measureMode: 'polyline',
      activePolyline: null,
      polylineMeasurements: [],
      activeMeasurement: null,
    });
  });

  it('a miss (no raycast hit) is a no-op', () => {
    handlePolylineClick(fakeCtx(null), 10, 10);
    assert.equal(useViewerStore.getState().activePolyline, null);
  });

  it('the first click starts the sequence', () => {
    handlePolylineClick(fakeCtx({ x: 0, y: 0, z: 0 }), 0, 0);
    const active = useViewerStore.getState().activePolyline;
    assert.ok(active);
    assert.equal(active.points.length, 1);
  });

  it('accumulates 3+ points across successive clicks', () => {
    // Screen coordinates are chosen well outside the close-loop radius
    // (14px, CLOSE_LOOP_SCREEN_RADIUS_PX) from the first point AND from
    // each other, so none of these clicks is mistaken for "close the loop".
    handlePolylineClick(fakeCtx({ x: 0, y: 0, z: 0 }), 0, 0);
    handlePolylineClick(fakeCtx({ x: 30, y: 0, z: 0 }), 30, 0);
    handlePolylineClick(fakeCtx({ x: 30, y: 40, z: 0 }), 30, 40);
    handlePolylineClick(fakeCtx({ x: 0, y: 40, z: 0 }), 0, 40);

    const active = useViewerStore.getState().activePolyline;
    assert.ok(active);
    assert.equal(active.points.length, 4);
  });

  it('clicking near the first point (>=3 points placed) closes the loop', () => {
    handlePolylineClick(fakeCtx({ x: 0, y: 0, z: 0 }), 0, 0);   // first point, screen (0,0)
    handlePolylineClick(fakeCtx({ x: 3, y: 0, z: 0 }), 3, 0);
    handlePolylineClick(fakeCtx({ x: 3, y: 4, z: 0 }), 3, 4);
    // Click lands 2px from the first point's screen position — inside the
    // close-loop radius (14px, see CLOSE_LOOP_SCREEN_RADIUS_PX).
    handlePolylineClick(fakeCtx({ x: 0.1, y: 0.1, z: 0 }), 0.1, 0.1);

    const state = useViewerStore.getState();
    assert.equal(state.activePolyline, null, 'the sequence must be finished, not still in progress');
    assert.equal(state.polylineMeasurements.length, 1);
    assert.equal(state.polylineMeasurements[0].closed, true);
  });

  it('a click far from the first point APPENDS instead of closing, even with >=3 points', () => {
    handlePolylineClick(fakeCtx({ x: 0, y: 0, z: 0 }), 0, 0);
    handlePolylineClick(fakeCtx({ x: 3, y: 0, z: 0 }), 3, 0);
    handlePolylineClick(fakeCtx({ x: 3, y: 4, z: 0 }), 3, 4);
    handlePolylineClick(fakeCtx({ x: 100, y: 100, z: 0 }), 100, 100); // far from (0,0)

    const active = useViewerStore.getState().activePolyline;
    assert.ok(active, 'sequence must still be in progress — this click should not have closed it');
    assert.equal(active.points.length, 4);
  });

  it('closing before 3 points are placed is impossible — a near-start click before that just appends', () => {
    // Only 2 points placed; a click back near the first must not be treated
    // as a close (the store's finishPolyline(true) would reject it anyway,
    // but the click handler's own >=3 guard means it never even tries).
    handlePolylineClick(fakeCtx({ x: 0, y: 0, z: 0 }), 0, 0);
    handlePolylineClick(fakeCtx({ x: 0.1, y: 0.1, z: 0 }), 0.1, 0.1);

    const state = useViewerStore.getState();
    assert.ok(state.activePolyline, 'must still be in progress, not closed');
    assert.equal(state.activePolyline?.points.length, 2);
    assert.equal(state.polylineMeasurements.length, 0);
  });

  // #2641 review (Codex P2), end to end through the real click handler and
  // the real store. `finishPolyline`'s screen-space duplicate check used to
  // run on the close-loop path too, comparing coordinates the animation loop
  // rewrites on every camera move — so orbiting mid-trace towards plan view
  // made two genuinely distinct vertices collide and one of them vanish from
  // the recorded perimeter, with no error and nothing on screen to say so.
  it('an orbit between the last point and the closing click does not eat a vertex', () => {
    /** Axonometric, the camera the points were placed under. */
    const axo: Projector = (p) => ({ x: p.x + 0.7 * p.z, y: p.y + 0.4 * p.z });
    /** Plan view: height (y) is lost, which is what makes the two collide. */
    const plan: Projector = (p) => ({ x: p.x, y: p.z });

    // An L along the floor, then straight UP: the last two vertices share a
    // plan position and differ only in height. Under `axo` every consecutive
    // pair is >= 24 screen px apart, and every point is >= 40 px from the
    // first, so none of these clicks is anywhere near closing the loop.
    handlePolylineClick(fakeCtx({ x: 0, y: 0, z: 0 }, axo), 0, 0);
    handlePolylineClick(fakeCtx({ x: 40, y: 0, z: 0 }, axo), 40, 0);
    handlePolylineClick(fakeCtx({ x: 40, y: 0, z: 30 }, axo), 61, 12);
    handlePolylineClick(fakeCtx({ x: 40, y: 30, z: 30 }, axo), 61, 42);
    assert.equal(useViewerStore.getState().activePolyline?.points.length, 4);

    // Orbit to plan view: the animation loop reprojects every placed point.
    useViewerStore.getState().updateMeasurementScreenCoords(plan);
    const placed = useViewerStore.getState().activePolyline!.points;
    assert.ok(
      Math.hypot(placed[3].screenX - placed[2].screenX, placed[3].screenY - placed[2].screenY) <= 2,
      'fixture is inert: the last two vertices did not collapse onto one pixel from overhead',
    );

    // Now close the loop with a click back on the first point, seen from the
    // new camera.
    handlePolylineClick(fakeCtx({ x: 0.1, y: 12, z: 0.1 }, plan), 0.1, 0.1);

    const state = useViewerStore.getState();
    assert.equal(state.activePolyline, null, 'the click must have closed the loop');
    assert.equal(state.polylineMeasurements.length, 1);
    const m = state.polylineMeasurements[0];
    assert.equal(m.points.length, 4, 'the vertex hidden behind another in plan view must survive');
    // 40 + 30 + 30 along the run, plus |(40, 30, 30)| closing back to the start.
    const expected = 100 + Math.hypot(40, 30, 30);
    assert.ok(
      Math.abs(m.length - expected) < 1e-9,
      `expected the full perimeter ${expected}, got ${m.length}`,
    );
  });

  it('never touches activeMeasurement (drag state) — the two gestures cannot cross-contaminate', () => {
    useViewerStore.setState({
      activeMeasurement: { start: { x: 9, y: 9, z: 9, screenX: 9, screenY: 9 }, current: { x: 9, y: 9, z: 9, screenX: 9, screenY: 9 }, distance: 0 },
    });

    handlePolylineClick(fakeCtx({ x: 0, y: 0, z: 0 }), 0, 0);
    handlePolylineClick(fakeCtx({ x: 1, y: 0, z: 0 }), 1, 0);

    assert.deepEqual(useViewerStore.getState().activeMeasurement, {
      start: { x: 9, y: 9, z: 9, screenX: 9, screenY: 9 },
      current: { x: 9, y: 9, z: 9, screenX: 9, screenY: 9 },
      distance: 0,
    });
  });
});

/**
 * The double-click finish is the one path allowed to drop a trailing
 * near-duplicate point, because it is the only one where the browser
 * manufactured an extra `click` (#2641 review). Driven here rather than
 * through `useMouseControls`' DOM handler so the decision is testable at all.
 */
describe('finishPolylineFromDoubleClick', () => {
  beforeEach(() => {
    useViewerStore.setState({
      measureMode: 'polyline',
      activePolyline: null,
      polylineMeasurements: [],
      activeMeasurement: null,
    });
  });

  it('drops the browser-generated second click of the double-click', () => {
    handlePolylineClick(fakeCtx({ x: 0, y: 0, z: 0 }), 0, 0);
    handlePolylineClick(fakeCtx({ x: 30, y: 0, z: 0 }), 30, 0);
    handlePolylineClick(fakeCtx({ x: 30, y: 40, z: 0 }), 30, 40);
    // The second `click` of the physical double-click, ~1.4px away.
    handlePolylineClick(fakeCtx({ x: 30.5, y: 40.5, z: 0 }), 30.5, 40.5);
    assert.equal(useViewerStore.getState().activePolyline?.points.length, 4);

    assert.equal(finishPolylineFromDoubleClick(), true);

    const m = useViewerStore.getState().polylineMeasurements[0];
    assert.equal(m.points.length, 3, 'the duplicate click must not become a vertex');
    assert.equal(m.closed, false, 'double-click finishes OPEN — closing is a click gesture');
    assert.ok(Math.abs(m.length - 70) < 0.01, `expected ~70, got ${m.length}`);
  });

  it('keeps a deliberate vertex placed outside the duplicate radius', () => {
    handlePolylineClick(fakeCtx({ x: 0, y: 0, z: 0 }), 0, 0);
    handlePolylineClick(fakeCtx({ x: 30, y: 0, z: 0 }), 30, 0);
    handlePolylineClick(fakeCtx({ x: 30, y: 40, z: 0 }), 30, 40);

    assert.equal(finishPolylineFromDoubleClick(), true);
    assert.equal(useViewerStore.getState().polylineMeasurements[0].points.length, 3);
  });

  it('reports "not this gesture" when no sequence is in progress, so the DOM event is left alone', () => {
    assert.equal(finishPolylineFromDoubleClick(), null);

    useViewerStore.setState({ measureMode: 'drag' });
    handlePolylineClick(fakeCtx({ x: 0, y: 0, z: 0 }), 0, 0);
    assert.equal(finishPolylineFromDoubleClick(), null, 'drag mode must not be finished by a double-click');
  });
});
