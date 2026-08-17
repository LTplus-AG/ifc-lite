/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The in-progress polyline's rubber-band segment must follow the CURSOR, not
 * the snap machinery (#2199 review findings).
 *
 * The segment used to render only off `snapIndicatorPos`, which is set solely
 * when a snap target exists (MeasurePanel.tsx). Two user-visible failures
 * followed:
 *
 * 1. Snap ON, cursor over empty background: the hover raycast finds nothing
 *    within its radius, nulls the snap target, and the rubber band unmounts —
 *    flickering off and on as the cursor crosses gaps in the model.
 * 2. Snap OFF: `useMouseControls` gates `handleMeasureHover` on
 *    `snapEnabledRef`, so `snapTarget` is never updated at all and the rubber
 *    band is absent (or frozen stale) for the whole polyline session.
 *
 * The fix tracks the live cursor in state while a polyline is active and
 * falls back to it: `hoverPosition={snapIndicatorPos ?? polylineCursor}`.
 * These tests drive the shipped overlay through a real window `mousemove`,
 * the same event the panel's own listener is bound to.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store/index.js';
import { ToolOverlays } from '../ToolOverlays.js';
import { render, cleanup } from '@/test/render.js';

/** One placed polyline point at renderer origin, screen-anchored at (10, 20). */
const PLACED = { x: 0, y: 0, z: 0, screenX: 10, screenY: 20 };

/** Move the real cursor: the window listener MeasurePanel installs is the
 *  code under test, so the event goes through `window`, not through React. */
function moveMouse(x: number, y: number): void {
  act(() => {
    window.dispatchEvent(new window.MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
  });
}

/**
 * The rubber-band `<line>`, identified by its dash pattern — the only `<line>`
 * MeasurementVisuals draws for an active polyline (placed segments are a
 * `<path>`, completed measurements are seeded empty here).
 */
function rubberBand(container: HTMLElement): SVGLineElement | null {
  return container.querySelector('line[stroke-dasharray="3,3"]');
}

after(cleanup);

beforeEach(() => {
  cleanup();
  useViewerStore.setState({
    activeTool: 'measure',
    measureMode: 'polyline',
    measurements: [],
    polylineMeasurements: [],
    activeMeasurement: null,
    pendingMeasurePoint: null,
    activePolyline: { points: [PLACED] },
    snapTarget: null,
    snapVisualization: null,
    unitDisplayOverrides: {},
  });
});

describe('polyline rubber band without a snap target', () => {
  it('follows the cursor over empty background (snap on, raycast found nothing)', () => {
    // snapTarget is null — exactly what handleMeasureHover leaves behind when
    // the 40px-radius raycast misses. The segment must still track the cursor.
    useViewerStore.setState({ snapEnabled: true });
    const container = render(<ToolOverlays />);

    moveMouse(123, 45);

    const line = rubberBand(container);
    assert.ok(line, 'rubber band unmounted while the cursor is over empty background');
    assert.equal(line.getAttribute('x1'), '10');
    assert.equal(line.getAttribute('y1'), '20');
    assert.equal(line.getAttribute('x2'), '123', 'rubber band does not end at the cursor');
    assert.equal(line.getAttribute('y2'), '45', 'rubber band does not end at the cursor');
  });

  it('renders at all with Snap toggled OFF (hover handling never runs)', () => {
    // With snap off, useMouseControls never calls handleMeasureHover, so
    // snapTarget stays null for the whole session — the cursor fallback is
    // the only thing that can drive the segment.
    useViewerStore.setState({ snapEnabled: false });
    const container = render(<ToolOverlays />);

    assert.equal(rubberBand(container), null, 'no segment before the mouse has moved');
    moveMouse(300, 200);

    const line = rubberBand(container);
    assert.ok(line, 'rubber band absent for the whole polyline session with Snap off');
    assert.equal(line.getAttribute('x2'), '300');
    assert.equal(line.getAttribute('y2'), '200');
  });

  it('still prefers the snapped position when a snap target IS present (control)', () => {
    // The fallback must not displace snapping: snapIndicatorPos is captured
    // when the snap target lands (cursor at A), and a later raw move to B
    // must leave the rubber band on the snapped position A. This passed
    // before the fix too — it pins that the fix did not regress snapping.
    useViewerStore.setState({ snapEnabled: true });
    const container = render(<ToolOverlays />);

    moveMouse(100, 50);
    act(() => {
      useViewerStore.setState({
        snapTarget: { type: 'vertex', position: { x: 1, y: 1, z: 1 } } as never,
      });
    });
    moveMouse(300, 200);

    const line = rubberBand(container);
    assert.ok(line, 'rubber band missing with a snap target present');
    assert.equal(line.getAttribute('x2'), '100', 'raw cursor displaced the snapped position');
    assert.equal(line.getAttribute('y2'), '50', 'raw cursor displaced the snapped position');
  });

  it('does not leak a stale cursor into the next polyline (control)', () => {
    // Finish/cancel clears the tracked cursor; a new polyline must show no
    // rubber band until the mouse actually moves again.
    useViewerStore.setState({ snapEnabled: false });
    const container = render(<ToolOverlays />);

    moveMouse(123, 45);
    assert.ok(rubberBand(container), 'precondition: segment tracked the first polyline');

    act(() => {
      useViewerStore.getState().cancelPolyline();
    });
    act(() => {
      useViewerStore.getState().startPolyline({ x: 1, y: 0, z: 0, screenX: 40, screenY: 60 });
    });

    assert.equal(
      rubberBand(container),
      null,
      'previous polyline\'s last cursor position leaked into the new one',
    );
  });
});
