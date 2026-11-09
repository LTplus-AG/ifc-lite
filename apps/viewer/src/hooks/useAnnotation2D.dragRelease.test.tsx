/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Dragging a 2D annotation ends when the button is released anywhere, not only
 * over the drawing canvas (G2). The canvas only sees its own `mouseup`, so a
 * release outside it used to leave the drag armed: moving back over the
 * canvas, with no button held, kept moving the annotation on every move.
 * Same idea as `useMeasure2D`'s global mouseup; a lost pointer
 * (`pointercancel`) or a window blur (alt-tab mid-drag) ends it too.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useRef } from 'react';
import { cleanup, render } from '@/test/render.js';
import { useAnnotation2D } from './useAnnotation2D.js';
import type { CloudAnnotation2D, SelectedAnnotation2D } from '@/store/slices/drawing2DSlice.js';
import type { Point2D } from '@ifc-lite/drawing-2d';

const cloud: CloudAnnotation2D = { id: 'cloud-1', points: [{ x: 0, y: 0 }, { x: 20, y: 20 }], color: '#E53935', label: '' };
const selected: SelectedAnnotation2D = { type: 'cloud', id: cloud.id };

let handlers!: ReturnType<typeof useAnnotation2D>;
const moves: Point2D[] = [];

function Probe() {
  const containerRef = useRef<HTMLDivElement>(null);
  handlers = useAnnotation2D({
    drawing: null,
    viewTransform: { x: 0, y: 0, scale: 1 },
    sectionAxis: 'down',
    containerRef,
    activeTool: 'none',
    setActiveTool: () => {},
    polygonArea2DPoints: [],
    addPolygonArea2DPoint: () => {},
    completePolygonArea2D: () => {},
    cancelPolygonArea2D: () => {},
    textAnnotations2D: [],
    addTextAnnotation2D: () => {},
    setTextAnnotation2DEditing: () => {},
    cloudAnnotation2DPoints: [],
    cloudAnnotations2D: [cloud],
    addCloudAnnotation2DPoint: () => {},
    completeCloudAnnotation2D: () => {},
    cancelCloudAnnotation2D: () => {},
    measure2DResults: [],
    polygonArea2DResults: [],
    selectedAnnotation2D: selected,
    setSelectedAnnotation2D: () => {},
    deleteSelectedAnnotation2D: () => {},
    moveAnnotation2D: (_sel, origin) => { moves.push(origin); },
    setAnnotation2DCursorPos: () => {},
    setMeasure2DSnapPoint: () => {},
  });
  return <div ref={containerRef} />;
}

// Identity view transform with sectionAxis 'down': screen coords === drawing coords.
const at = (x: number, y: number) => ({ button: 0, clientX: x, clientY: y } as unknown as React.MouseEvent);

afterEach(() => { cleanup(); moves.length = 0; });

describe('useAnnotation2D drag ends on a release outside the canvas (G2)', () => {
  for (const [name, release] of [
    ['mouseup outside the canvas', () => window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }))],
    ['pointercancel', () => window.dispatchEvent(new Event('pointercancel'))],
    ['window blur', () => window.dispatchEvent(new Event('blur'))],
  ] as const) {
    it(`${name} stops the annotation following the cursor`, () => {
      render(<Probe />);
      act(() => { assert.equal(handlers.handleMouseDown(at(10, 10)), true, 'the press grabs the cloud'); });
      act(() => handlers.handleMouseMove(at(15, 15)));
      assert.equal(moves.length, 1, 'a held drag moves the cloud');

      act(release);
      assert.equal(handlers.isDraggingRef.current, false, 'the drag is over');
      act(() => handlers.handleMouseMove(at(40, 40)));
      act(() => handlers.handleMouseMove(at(60, 60)));
      assert.equal(moves.length, 1, 'moving back over the canvas with no button held must not move the cloud');
    });
  }
});
