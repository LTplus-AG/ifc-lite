/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WIRING tests for angle mode (#2735) - click -> store -> readout.
 *
 * These exist because an adversarial review found the pure layer was
 * mutation-hardened while the layer that CONNECTS it was covered by nothing.
 * Two mutations survived the entire 5001-test viewer suite:
 *
 *   1. `handleAngleClick`'s body replaced with a bare `return` - the tool is
 *      completely dead, no pick ever registers, every test still passes.
 *   2. the panel feeding `picks[1]` as the apex instead of `picks[0]` - every
 *      displayed angle is wrong (the 3-4-5 fixture's 90 degrees renders 36.9).
 *
 * Both are invisible to tests of pure functions and of the store in isolation,
 * because neither layer is wrong: the wiring between them is. The readout test
 * below therefore asserts the NUMBER A USER WOULD SEE, computed the way the
 * panel computes it, rather than asserting that the store holds three picks.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { handleAngleClick } from './selectionHandlers.js';
import {
  formatThreePointAngle,
  threePointAngle,
} from './tools/measure-modes/three-point-angle.js';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';

function fakeCtx(hit: { x: number; y: number; z: number } | null): MouseHandlerContext {
  const canvas = document.createElement('canvas');
  return {
    canvas,
    camera: {
      projectToScreen: (p: { x: number; y: number; z: number }) => ({ x: p.x, y: p.y }),
      getPosition: () => ({ x: 0, y: 0, z: 0 }),
      getRotation: () => ({ azimuth: 0, elevation: 0 }),
      getDistance: () => 10,
    },
    renderer: {
      raycastSceneMagnetic: () => ({
        intersection: hit ? { point: hit } : null,
        snapTarget: null,
        edgeLock: { edge: null, meshExpressId: null, edgeT: 0, shouldLock: false, shouldRelease: true, isCorner: false, cornerValence: 0 },
      }),
    },
    mouseState: { isDragging: false, isPanning: false, lastX: 0, lastY: 0, button: 0, startX: 0, startY: 0, didDrag: false },
    activeToolRef: { current: 'measure' },
    snapEnabledRef: { current: true },
    edgeLockStateRef: { current: { edge: null, meshExpressId: null, edgeT: 0, lockStrength: 0, isCorner: false, cornerValence: 0 } },
    hiddenEntitiesRef: { current: new Set() },
    isolatedEntitiesRef: { current: null },
    setSnapTarget: () => {},
  } as unknown as MouseHandlerContext;
}

/** Exactly what `MeasurePanel` renders for a finished angle. */
function readoutOf(m: { picks: { point: { x: number; y: number; z: number } }[] }): string {
  return formatThreePointAngle(
    threePointAngle(m.picks[0].point, m.picks[1].point, m.picks[2].point),
  );
}

describe('handleAngleClick wiring (#2735)', () => {
  beforeEach(() => {
    useViewerStore.setState({
      measureMode: 'angle',
      angleKind: 'points',
      activeAngle: null,
      angleMeasurements: [],
      activeMeasurement: null,
    });
  });

  it('a miss is a no-op, matching polyline', () => {
    handleAngleClick(fakeCtx(null), 10, 10);
    assert.equal(useViewerStore.getState().activeAngle, null);
    assert.equal(useViewerStore.getState().angleMeasurements.length, 0);
  });

  it('a click registers a pick - the tool is not dead', () => {
    // Kills the "replace the handler body with `return`" mutation.
    handleAngleClick(fakeCtx({ x: 0, y: 0, z: 0 }), 0, 0);
    assert.equal(useViewerStore.getState().activeAngle?.picks.length, 1);
  });

  it('three clicks produce the angle a user would READ, apex first', () => {
    // Kills the "panel feeds the wrong pick as apex" mutation. The fixture is
    // the 3-4-5 right triangle with the apex at its RIGHT angle, so measuring
    // at either other vertex yields 36.9 or 53.1 - all three distinguishable.
    handleAngleClick(fakeCtx({ x: 0, y: 0, z: 0 }), 0, 0);
    handleAngleClick(fakeCtx({ x: 4, y: 0, z: 0 }), 4, 0);
    handleAngleClick(fakeCtx({ x: 0, y: 3, z: 0 }), 0, 3);

    const finished = useViewerStore.getState().angleMeasurements;
    assert.equal(finished.length, 1, 'the third click must finish the measurement');
    assert.equal(useViewerStore.getState().activeAngle, null);
    assert.equal(readoutOf(finished[0]), '90.0°', 'the FIRST pick is the apex');
  });

  it('clicks in a different order measure a different corner', () => {
    // Guards the guard above: if the readout ignored pick order entirely, the
    // previous test could pass for the wrong reason. Same three points, apex
    // moved to the end of the long leg -> atan(3/4) = 36.9.
    handleAngleClick(fakeCtx({ x: 4, y: 0, z: 0 }), 4, 0);
    handleAngleClick(fakeCtx({ x: 0, y: 0, z: 0 }), 0, 0);
    handleAngleClick(fakeCtx({ x: 0, y: 3, z: 0 }), 0, 3);
    assert.equal(readoutOf(useViewerStore.getState().angleMeasurements[0]), '36.9°');
  });

  it('drops the second half of a physical double-click', () => {
    // Browsers fire click, click, dblclick. Without this guard a habitual
    // double-click on a DIRECTION point makes picks 2 and 3 coincide and
    // records a confident "0.0°" - a junk measurement rendered as a real
    // answer, not an em dash. An earlier version of the handler argued the
    // maths already covered this; it does not, because only APEX-coincidence
    // is degenerate.
    handleAngleClick(fakeCtx({ x: 0, y: 0, z: 0 }), 0, 0);
    handleAngleClick(fakeCtx({ x: 4, y: 0, z: 0 }), 4, 0);
    handleAngleClick(fakeCtx({ x: 4, y: 0, z: 0 }), 4, 0); // the double-click's twin
    const st = useViewerStore.getState();
    assert.equal(st.angleMeasurements.length, 0, 'the duplicate must not finish a measurement');
    assert.equal(st.activeAngle?.picks.length, 2, 'and must not be recorded as a third pick');
  });

  it('still accepts a genuinely distinct pick near, but not within, the duplicate radius', () => {
    // Guards the guard: a radius that swallowed real picks would be worse than
    // the junk it prevents. DUPLICATE_POINT_SCREEN_RADIUS_PX is 2, so 5 px is
    // a real pick.
    handleAngleClick(fakeCtx({ x: 0, y: 0, z: 0 }), 0, 0);
    handleAngleClick(fakeCtx({ x: 4, y: 0, z: 0 }), 4, 0);
    handleAngleClick(fakeCtx({ x: 4, y: 5, z: 0 }), 4, 5);
    assert.equal(useViewerStore.getState().angleMeasurements.length, 1);
  });

  it('does not register picks when the tool is not in angle mode', () => {
    useViewerStore.setState({ measureMode: 'drag' });
    // The router gates on mode, but the handler is exported and a future
    // caller could reach it directly; the store's own kind check is the
    // backstop being pinned here.
    useViewerStore.setState({ angleKind: 'edges' });
    handleAngleClick(fakeCtx({ x: 0, y: 0, z: 0 }), 0, 0);
    assert.equal(useViewerStore.getState().activeAngle, null);
  });
});
