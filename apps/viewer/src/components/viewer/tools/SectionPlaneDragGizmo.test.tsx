/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5403 review: the section-plane handle took pointer capture before its
 * edge-on bail-out, so a press on an edge-on arrow held the pointer with no
 * drag state to release it. happy-dom tracks capture per element, so
 * `hasPointerCapture` is the observable.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { Renderer } from '@ifc-lite/renderer';
import { cleanup, render } from '@/test/render.js';
import { setGlobalRendererRef } from '@/hooks/useBCF.js';
import { useViewerStore } from '@/store';
import { SectionPlaneDragGizmo } from './SectionPlaneDragGizmo.js';

let originalRaf: typeof requestAnimationFrame;
let originalCaf: typeof cancelAnimationFrame;

function mountWithProjection(p1: { x: number; y: number }) {
  const canvas = document.createElement('canvas');
  Object.defineProperties(canvas, {
    clientWidth: { configurable: true, value: 800 },
    clientHeight: { configurable: true, value: 600 },
  });
  const renderer = new Renderer(canvas);
  const p0 = { x: 100, y: 100 };
  let call = 0;
  // Foot then tip, alternating: pins the on-screen span of the plane normal.
  renderer.getCamera().projectToScreen = () => (call++ % 2 === 0 ? p0 : p1);
  setGlobalRendererRef({ current: renderer });
  act(() => useViewerStore.getState().setSectionPlaneFromFace([1, 0, 0], [0, 0, 0]));
  const custom = useViewerStore.getState().sectionPlane.custom;
  assert.ok(custom);
  const starts: number[] = [];
  const ui = render(
    <svg>
      <SectionPlaneDragGizmo customPlane={custom} setDistance={() => {}}
        onDragStart={() => starts.push(1)} onDragEnd={() => {}} />
    </svg>,
  );
  const handle = ui.querySelector('circle');
  assert.ok(handle);
  return { handle, starts };
}

function press(target: Element): void {
  act(() => target.dispatchEvent(new window.PointerEvent('pointerdown', {
    bubbles: true, cancelable: true, pointerId: 7, clientX: 100, clientY: 100,
  })));
}

beforeEach(() => {
  originalRaf = globalThis.requestAnimationFrame;
  originalCaf = globalThis.cancelAnimationFrame;
  // The gizmo projects once on mount; later frames are not needed.
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
});

afterEach(() => {
  cleanup();
  setGlobalRendererRef({ current: null });
  globalThis.requestAnimationFrame = originalRaf;
  globalThis.cancelAnimationFrame = originalCaf;
});

describe('SectionPlaneDragGizmo pointer capture (#5403)', () => {
  it('an edge-on press starts no drag and leaves the pointer uncaptured', () => {
    const { handle, starts } = mountWithProjection({ x: 100, y: 100 });
    press(handle);
    assert.equal(starts.length, 0, 'edge-on: the drag is refused');
    assert.equal(handle.hasPointerCapture(7), false, 'nothing would ever release this capture');
  });

  it('a normal press starts the drag and captures the pointer', () => {
    const { handle, starts } = mountWithProjection({ x: 160, y: 100 });
    press(handle);
    assert.equal(starts.length, 1);
    assert.equal(handle.hasPointerCapture(7), true);
  });
});
