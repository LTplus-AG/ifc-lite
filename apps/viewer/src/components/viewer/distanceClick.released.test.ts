/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Distance clicks over released CPU geometry (#10264, #10884): the second click
 * of a click-click distance reads back at its own point before it finishes, and
 * Esc or a tool change in the meantime drops it.
 */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { handleMeasureUp, resetMeasurePress } from './distanceClick.js';
import { measureReadbacksIdle, setMeasureReadbackFeedForTest } from './measureReadbackGate.js';

afterEach(() => setMeasureReadbackFeedForTest(null));

function releasedCtx() {
  let covered = false;
  const log: string[] = [];
  const ctx = {
    canvas: Object.assign(document.createElement('canvas'), { getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
    renderer: {
      getScene: () => ({ isGeometryDataReleased: () => true }),
      readbackRaycastCovers: () => covered,
      raycastSceneMagnetic: () => { log.push(covered ? 'raycast covered' : 'raycast UNCOVERED');
        return covered ? { intersection: { point: { x: 9, y: 0, z: 0 } }, snapTarget: null } : null; },
    },
    camera: { projectToScreen: (p: { x: number; y: number }) => ({ x: p.x, y: p.y }) },
    mouseState: { isDragging: true, didDrag: false },
    activeToolRef: { current: 'measure' },
    activeMeasurementRef: { current: { start: { x: 0, y: 0, z: 0, screenX: 0, screenY: 0 } } }, // the first click's pending start
    edgeLockStateRef: { current: { edge: null, meshExpressId: null, edgeT: 0, lockStrength: 0, isCorner: false, cornerValence: 0 } },
    measurementConstraintEdgeRef: { current: null },
    measureRaycastFrameRef: { current: null }, measureRaycastPendingRef: { current: false },
    hiddenEntitiesRef: { current: new Set() }, isolatedEntitiesRef: { current: null }, snapEnabledRef: { current: true },
    clearEdgeLock: () => {}, setSnapTarget: () => {}, setSnapVisualization: () => {},
    updateMeasurement: () => log.push('end set'), finalizeMeasurement: () => log.push('finished'),
  } as unknown as MouseHandlerContext;
  setMeasureReadbackFeedForTest(async () => { log.push('read back'); covered = true; return 'fed'; });
  return { ctx, log };
}
const up = (x: number) => new window.MouseEvent('pointerup', { clientX: x, clientY: 5 }) as unknown as PointerEvent;

describe('click-click distance over released geometry', () => {
  it('#10884 the second click reads back at its own point, then finishes', async () => {
    const { ctx, log } = releasedCtx();
    handleMeasureUp(ctx, up(300)); // far from the first click: not covered by its readback
    await measureReadbacksIdle();
    assert.deepEqual(log, ['read back', 'raycast covered', 'end set', 'finished'], 'never an uncovered synchronous raycast');
  });

  it('#10884 Esc while the second click reads back drops the finish', async () => {
    const { ctx, log } = releasedCtx();
    handleMeasureUp(ctx, up(300));
    resetMeasurePress(ctx);
    await measureReadbacksIdle();
    assert.deepEqual(log.filter((entry) => entry !== 'read back'), [], 'nothing measured after the reset');
  });
});
