/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Space Sketch viewport invariant (#2438): EVERY write to `fitRef` bumps
 * `fitTick`.
 *
 * `fitRef` has to be a ref — it is read synchronously many times per pointer
 * event — but the overlay's building underlay is a memo that reads
 * `fitRef.current` while depending on `fitTick`. A write that skips the tick
 * therefore leaves hundreds of pre-rendered wall lines frozen at the old
 * transform while the rooms move under them, which reads as the plan tearing
 * apart rather than as a missing re-render.
 *
 * Before the split three call sites wrote `fitRef` and two open-coded the tick
 * bump, so the invariant held by duplication. These tests exercise all three
 * ways the transform can move — fit, pan, wheel — and assert the tick each time.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Pt } from '@/lib/space-sketch-geometry.js';
import { useSpaceViewport, type UseSpaceViewport } from './useSpaceViewport.js';

let root: Root | null = null;
let container: HTMLElement | null = null;
let api: UseSpaceViewport | null = null;
/** Every `fitTick` React rendered with, in order. */
let ticks: number[] = [];

function Harness() {
  api = useSpaceViewport();
  ticks.push(api.fitTick);
  // A real <svg> so the non-passive wheel listener has something to attach to.
  return <svg ref={api.svgRef} width={api.size.w} height={api.size.h} />;
}

/** The tick React last rendered with. */
const tick = () => ticks[ticks.length - 1];

const PLAN: Pt[] = [[0, 0], [12, 0], [12, 8], [0, 8]];

beforeEach(() => {
  ticks = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(<Harness />); });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
});

describe('useSpaceViewport — every transform write bumps the tick', () => {
  it('fitToPoints reframes and bumps', () => {
    const before = { ...api!.fitRef.current };
    const t0 = tick();
    act(() => { api!.fitToPoints(PLAN); });
    assert.notDeepEqual(api!.fitRef.current, before, 'the transform actually moved');
    assert.ok(tick() > t0, 'and the underlay memo was invalidated');
  });

  it('panBy translates and bumps, leaving the scale alone', () => {
    act(() => { api!.fitToPoints(PLAN); });
    const before = { ...api!.fitRef.current };
    const t0 = tick();
    act(() => { api!.panBy(17, -9); });
    assert.equal(api!.fitRef.current.scale, before.scale, 'panning does not zoom');
    assert.equal(api!.fitRef.current.offX, before.offX + 17);
    assert.equal(api!.fitRef.current.offY, before.offY - 9);
    assert.ok(tick() > t0);
  });

  it('a wheel notch zooms, bumps, and cancels the page scroll', () => {
    act(() => { api!.fitToPoints(PLAN); });
    const before = { ...api!.fitRef.current };
    const t0 = tick();
    const svg = container!.querySelector('svg')!;
    const ev = new window.WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true });
    act(() => { svg.dispatchEvent(ev); });
    assert.ok(api!.fitRef.current.scale > before.scale, 'scroll up zooms in');
    assert.ok(tick() > t0);
    // NB this pins the preventDefault call, not the `passive: false` flag —
    // happy-dom honours preventDefault either way, so the flag itself is only
    // checkable in a real browser. Both are needed: without the flag the
    // browser ignores the call and the page scrolls under the panel.
    assert.equal(ev.defaultPrevented, true, 'the wheel gesture is consumed, not passed to the page');
  });

  it('a refused wheel notch moves nothing at all', () => {
    // Past the zoom limit the gesture is dropped rather than scale-clamped: a
    // clamped scale with the offset still applied would drift the plan sideways.
    act(() => { api!.fitToPoints(PLAN); });
    const svg = container!.querySelector('svg')!;
    // Drive it hard against the far-out bound first.
    for (let i = 0; i < 60; i++) {
      act(() => { svg.dispatchEvent(new window.WheelEvent('wheel', { deltaY: 2000, bubbles: true, cancelable: true })); });
    }
    const parked = { ...api!.fitRef.current };
    act(() => { svg.dispatchEvent(new window.WheelEvent('wheel', { deltaY: 2000, bubbles: true, cancelable: true })); });
    assert.deepEqual(api!.fitRef.current, parked, 'a refused zoom leaves the transform byte-identical');
  });

  it('svgPoint clamps to the canvas the hook currently reports', () => {
    const { w, h } = api!.size;
    const svg = container!.querySelector('svg')! as unknown as { getBoundingClientRect: () => DOMRect };
    svg.getBoundingClientRect = () => ({ left: 100, top: 50 }) as DOMRect;
    assert.deepEqual(api!.svgPoint({ clientX: 100 + w + 500, clientY: 50 + h + 500 }), [w, h]);
    assert.deepEqual(api!.svgPoint({ clientX: 0, clientY: 0 }), [0, 0]);
    assert.deepEqual(api!.svgPoint({ clientX: 140, clientY: 90 }), [40, 40]);
  });

  it('a resize reaches a svgPoint that was bound before it', () => {
    // `svgPoint` is stable across renders, and the overlay's `onPointerMove` is
    // memoised on it — so React can dispatch a pointer event into a handler
    // captured several renders ago. Read the size through a closure instead of
    // the ref and that captured handler clamps to a canvas that no longer
    // exists, which is how a drag past the edge escapes the clamp entirely.
    const { w, h } = api!.size;
    const boundBeforeResize = api!.svgPoint;
    const grip = { setPointerCapture() {}, releasePointerCapture() {} };
    const down = { clientX: 0, clientY: 0, pointerId: 1, currentTarget: grip, preventDefault() {}, stopPropagation() {} };
    act(() => { api!.resizeHandlers.onPointerDown(down as unknown as React.PointerEvent); });
    act(() => {
      api!.resizeHandlers.onPointerMove({ clientX: 60, clientY: 40 } as unknown as React.PointerEvent);
    });
    assert.deepEqual(api!.size, { w: w + 60, h: h + 40 });
    const svg = container!.querySelector('svg')! as unknown as { getBoundingClientRect: () => DOMRect };
    svg.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
    assert.equal(api!.svgPoint, boundBeforeResize, 'svgPoint must stay referentially stable');
    assert.deepEqual(boundBeforeResize({ clientX: 99_999, clientY: 99_999 }), [w + 60, h + 40],
      'the pre-resize handler clamps to the new canvas');
  });

  it('will not shrink below the minimum usable canvas', () => {
    const grip = { setPointerCapture() {}, releasePointerCapture() {} };
    act(() => {
      api!.resizeHandlers.onPointerDown(
        { clientX: 0, clientY: 0, pointerId: 1, currentTarget: grip, preventDefault() {}, stopPropagation() {} } as unknown as React.PointerEvent,
      );
    });
    act(() => {
      api!.resizeHandlers.onPointerMove({ clientX: -5000, clientY: -5000 } as unknown as React.PointerEvent);
    });
    assert.ok(api!.size.w >= 320 && api!.size.h >= 240, `got ${api!.size.w}x${api!.size.h}`);
  });

  it('detaches the wheel listener on unmount', () => {
    const svg = container!.querySelector('svg')!;
    act(() => { root!.unmount(); });
    root = null;
    const ev = new window.WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true });
    svg.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, false, 'a closed panel no longer swallows the page scroll');
  });
});
