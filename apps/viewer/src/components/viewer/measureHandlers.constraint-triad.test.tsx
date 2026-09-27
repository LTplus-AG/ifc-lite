/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One X/Y/Z triad (#5490). The measure tool's shift-drag constraint axes used
 * their own Material triad (`#F44336 #8BC34A #2196F3`) and coloured the
 * renderer's vertical axis as "Y", while the axis helper in the corner calls
 * that same direction Z (IFC is Z-up). This drives a real measure pointer-down
 * and compares the colour each constraint axis is drawn in against the colour
 * the rendered axis helper paints the matching IFC axis.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup } from '@/test/render.js';
import type { MeasurementConstraintEdge } from '@/store/types';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { handleMeasureDown } from './measureHandlers.js';
import { AxisHelper } from './AxisHelper.js';

afterEach(cleanup);

/** The colour the axis helper paints each IFC axis label in. */
function axisHelperColors(): Record<'X' | 'Y' | 'Z', string> {
  const container = render(<AxisHelper />);
  const colorOf = (label: string): string => {
    const el = [...container.querySelectorAll<HTMLElement>('div')].find((d) => d.textContent === label);
    assert.ok(el, `axis helper renders an "${label}" label`);
    assert.ok(el.style.color, `"${label}" label has a colour`);
    return el.style.color;
  };
  return { X: colorOf('X'), Y: colorOf('Y'), Z: colorOf('Z') };
}

/** Run a measure pointer-down on a surface hit and return the constraint it sets up. */
function constraintFromPointerDown(): MeasurementConstraintEdge {
  let constraint: MeasurementConstraintEdge | null = null;
  const noop = () => {};
  const ctx = {
    canvas: document.createElement('canvas'),
    renderer: {
      raycastSceneMagnetic: () => ({
        intersection: { point: { x: 1, y: 2, z: 3 } },
        snapTarget: null,
        edgeLock: { edge: null, meshExpressId: null, edgeT: 0, shouldLock: false, shouldRelease: true, isCorner: false, cornerValence: 0 },
      }),
    },
    camera: { projectToScreen: (p: { x: number; y: number }) => ({ x: p.x, y: p.y }) },
    mouseState: { isDragging: false },
    edgeLockStateRef: { current: { edge: null, meshExpressId: null, edgeT: 0, lockStrength: 0, isCorner: false, cornerValence: 0 } },
    hiddenEntitiesRef: { current: new Set() },
    isolatedEntitiesRef: { current: null },
    snapEnabledRef: { current: true },
    startMeasurement: noop,
    setSnapTarget: noop,
    setSnapVisualization: noop,
    clearEdgeLock: noop,
    setMeasurementConstraintEdge: (edge: MeasurementConstraintEdge) => { constraint = edge; },
  } as unknown as MouseHandlerContext;
  handleMeasureDown(ctx, new window.MouseEvent('pointerdown', { clientX: 10, clientY: 20 }) as unknown as PointerEvent);
  assert.ok(constraint, 'a measure pointer-down on geometry sets up the shift-drag constraint');
  return constraint;
}

describe('measure constraint axes use the one X/Y/Z triad (#5490)', () => {
  it('colours each renderer axis as the axis helper colours the IFC axis it is', () => {
    const helper = axisHelperColors();
    const { axes, colors } = constraintFromPointerDown();
    // Renderer frame is Y-up: renderer X is IFC X, renderer Y is IFC Z (up),
    // renderer Z is IFC Y.
    const ifcAxisOf = (v: { x: number; y: number; z: number }): 'X' | 'Y' | 'Z' =>
      v.x !== 0 ? 'X' : v.y !== 0 ? 'Z' : 'Y';
    for (const key of ['axis1', 'axis2', 'axis3'] as const) {
      const ifc = ifcAxisOf(axes[key]);
      assert.equal(colors[key], helper[ifc], `${key} (IFC ${ifc}) matches the axis helper's ${ifc}`);
    }
  });

  it('the three axis colours are distinct', () => {
    const { X, Y, Z } = axisHelperColors();
    assert.equal(new Set([X, Y, Z]).size, 3);
  });
});
