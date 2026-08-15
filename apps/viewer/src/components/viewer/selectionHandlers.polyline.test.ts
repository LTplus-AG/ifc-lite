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
import { handlePolylineClick } from './selectionHandlers.js';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';

/** A world point that raycasts to itself: point (x, y, 0), screen (x, y). */
function fakeCtx(hit: { x: number; y: number; z: number } | null): MouseHandlerContext {
  const canvas = document.createElement('canvas');
  const camera = {
    projectToScreen: (p: { x: number; y: number; z: number }) => ({ x: p.x, y: p.y }),
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
