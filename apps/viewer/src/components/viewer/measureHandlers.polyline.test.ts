/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for the polyline-mode pieces of measureHandlers.ts (#2199):
 *   - shouldStartDragMeasurement: the gate that stops a drag measurement
 *     from ever starting while polyline mode is active (and vice versa is
 *     structural — polyline mode never touches activeMeasurement at all).
 *   - raycastForPolylinePoint: the store-free raycast a click resolves to.
 *   - isNearPolylineStart: the screen-space "close the loop" threshold.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldStartDragMeasurement,
  raycastForPolylinePoint,
  isNearPolylineStart,
  CLOSE_LOOP_SCREEN_RADIUS_PX,
} from './measureHandlers.js';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';

describe('shouldStartDragMeasurement', () => {
  it('starts a drag in drag mode without shift', () => {
    assert.equal(shouldStartDragMeasurement('drag', false), true);
  });

  it('does NOT start a drag when shift is held (existing orbit escape hatch)', () => {
    assert.equal(shouldStartDragMeasurement('drag', true), false);
  });

  it('does NOT start a drag in polyline mode, shift or not', () => {
    assert.equal(shouldStartDragMeasurement('polyline', false), false);
    assert.equal(shouldStartDragMeasurement('polyline', true), false);
  });
});

/** Build a minimal MouseHandlerContext for raycastForPolylinePoint — only
 *  the fields that function actually reads. */
function fakeCtx(overrides: {
  intersection?: { point: { x: number; y: number; z: number } } | null;
  snapTarget?: { type: string; position: { x: number; y: number; z: number } } | null;
  snapEnabled?: boolean;
} = {}): MouseHandlerContext {
  const canvas = document.createElement('canvas');
  const camera = {
    projectToScreen: (p: { x: number; y: number; z: number }) => ({ x: p.x * 2, y: p.y * 2 }),
    getPosition: () => ({ x: 0, y: 0, z: 0 }),
    getRotation: () => ({ azimuth: 0, elevation: 0 }),
    getDistance: () => 10,
  };
  const renderer = {
    raycastSceneMagnetic: () => ({
      intersection: overrides.intersection ?? null,
      snapTarget: overrides.snapTarget ?? null,
      edgeLock: { edge: null, meshExpressId: null, edgeT: 0, shouldLock: false, shouldRelease: true, isCorner: false, cornerValence: 0 },
    }),
  };
  return {
    canvas,
    renderer,
    camera,
    mouseState: { isDragging: false, isPanning: false, lastX: 0, lastY: 0, button: 0, startX: 0, startY: 0, didDrag: false },
    activeToolRef: { current: 'measure' },
    activeMeasurementRef: { current: null },
    snapEnabledRef: { current: overrides.snapEnabled ?? true },
    edgeLockStateRef: { current: { edge: null, meshExpressId: null, edgeT: 0, lockStrength: 0, isCorner: false, cornerValence: 0 } },
    measurementConstraintEdgeRef: { current: null },
    hiddenEntitiesRef: { current: new Set() },
    isolatedEntitiesRef: { current: null },
    geometryRef: { current: null },
    measureRaycastPendingRef: { current: false },
    measureRaycastFrameRef: { current: null },
    lastMeasureRaycastDurationRef: { current: 0 },
    lastHoverSnapTimeRef: { current: 0 },
    lastCameraStateRef: { current: null },
    lastClickTimeRef: { current: 0 },
    lastClickPosRef: { current: null },
    startMeasurement: () => {},
    updateMeasurement: () => {},
    finalizeMeasurement: () => {},
    setSnapTarget: () => {},
    setSnapVisualization: () => {},
    setEdgeLock: () => {},
    updateEdgeLockPosition: () => {},
    clearEdgeLock: () => {},
    incrementEdgeLockStrength: () => {},
    setMeasurementConstraintEdge: () => {},
    updateConstraintActiveAxis: () => {},
    updateMeasurementScreenCoords: () => {},
    handlePickForSelection: () => {},
    toggleSelection: () => {},
    openContextMenu: () => {},
    hasPendingMeasurements: () => false,
    getPickOptions: () => ({ isStreaming: false, hiddenIds: new Set<number>(), isolatedIds: null }),
    HOVER_SNAP_THROTTLE_MS: 100,
    SLOW_RAYCAST_THRESHOLD_MS: 50,
  } as unknown as MouseHandlerContext;
}

describe('raycastForPolylinePoint', () => {
  it('returns null on a miss (no intersection, no snap target)', () => {
    const ctx = fakeCtx({ intersection: null, snapTarget: null });
    assert.equal(raycastForPolylinePoint(ctx, 10, 20), null);
  });

  it('resolves a plain geometry hit to a MeasurePoint', () => {
    const ctx = fakeCtx({ intersection: { point: { x: 1, y: 2, z: 3 } } });
    const result = raycastForPolylinePoint(ctx, 10, 20);
    assert.ok(result);
    assert.deepEqual({ x: result.point.x, y: result.point.y, z: result.point.z }, { x: 1, y: 2, z: 3 });
    assert.equal(result.snapTarget, null);
  });

  it('prefers the snap target over the raw intersection, and surfaces it', () => {
    const snapTarget = { type: 'vertex', position: { x: 5, y: 6, z: 7 } };
    const ctx = fakeCtx({ intersection: { point: { x: 1, y: 1, z: 1 } }, snapTarget });
    const result = raycastForPolylinePoint(ctx, 10, 20);
    assert.ok(result);
    assert.deepEqual({ x: result.point.x, y: result.point.y, z: result.point.z }, { x: 5, y: 6, z: 7 });
    assert.equal(result.snapTarget, snapTarget);
  });
});

describe('isNearPolylineStart', () => {
  it('is true within the close-loop radius', () => {
    const first = { screenX: 100, screenY: 100 };
    const candidate = { screenX: 100 + CLOSE_LOOP_SCREEN_RADIUS_PX - 1, screenY: 100 };
    assert.equal(isNearPolylineStart(candidate, first), true);
  });

  it('is false outside the close-loop radius', () => {
    const first = { screenX: 100, screenY: 100 };
    const candidate = { screenX: 100 + CLOSE_LOOP_SCREEN_RADIUS_PX + 5, screenY: 100 };
    assert.equal(isNearPolylineStart(candidate, first), false);
  });

  it('respects an explicit radius override', () => {
    const first = { screenX: 0, screenY: 0 };
    const candidate = { screenX: 50, screenY: 0 };
    assert.equal(isNearPolylineStart(candidate, first, 40), false);
    assert.equal(isNearPolylineStart(candidate, first, 60), true);
  });
});

describe('shouldStartDragMeasurement - angle mode (#2735)', () => {
  it('never starts a drag in angle mode', () => {
    // The single gate that stops two mode state machines running at once.
    // Angle mode places points by click, so a drag starting underneath it
    // would leave `activeMeasurement` non-null while a pick sequence is in
    // progress - the exact corruption `setMeasureMode` exists to prevent.
    assert.equal(shouldStartDragMeasurement('angle', false), false);
  });

  it('is an ALLOW-list, so a future mode is click-driven by default', () => {
    // Written as `mode === 'drag'`, not `mode !== 'polyline'`. The exclusion
    // form is a deny-list: every new click-driven mode must remember to add
    // itself, and forgetting means the drag gesture silently runs underneath
    // it. This pins the safe direction rather than the current mode list, so
    // it keeps biting when a fourth mode lands.
    assert.equal(shouldStartDragMeasurement('drag', false), true);
    assert.equal(shouldStartDragMeasurement('drag', true), false, 'shift still escapes to orbit');
    for (const mode of ['polyline', 'angle'] as const) {
      assert.equal(shouldStartDragMeasurement(mode, false), false, `${mode} must not drag`);
    }
  });
});
