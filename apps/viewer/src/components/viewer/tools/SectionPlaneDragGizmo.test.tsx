/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The section-plane drag gizmo on the scene kernel (#5501): drag behaviour
 * is unchanged from the hand-rolled version — cursor pixels along the
 * screen-projected normal become metres through `foot -> foot + normal`'s
 * on-screen span — and the #5403 capture rule holds: an edge-on press
 * takes no capture, a real press does. The stub camera is scaled to 2 px
 * per world metre here, so a +X normal spans 2 px/m: 30 px = 15 m (a
 * mutation that drops the px-per-metre division reads 30 m and fails).
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { getDefaultSectionPlane } from '@/store/slices/sectionSlice.js';
import { renderScene } from '../../viewport-ui/scene/test/scene-test-support.js';
import { SectionPlaneVisualization } from './SectionVisualization.js';

function pointer(target: Element, type: string, x: number, y = 100): void {
  act(() => target.dispatchEvent(new window.PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 7, clientX: x, clientY: y,
  })));
}

function mount(normal: [number, number, number]) {
  act(() => useViewerStore.getState().setSectionPlaneFromFace(normal, [100, 100, 0]));
  const custom = useViewerStore.getState().sectionPlane.custom;
  assert.ok(custom);
  const scene = renderScene(<SectionPlaneVisualization enabled />);
  scene.source.camera.projectToScreen = (p) => ({ x: p.x * 2, y: p.y * 2 });
  scene.source.dirty = true;
  scene.flush();
  const handle = scene.container.querySelector('[data-scene-primitive="handle"] circle');
  assert.ok(handle);
  return { ...scene, handle, start: custom.distance };
}

beforeEach(() => {
  useViewerStore.setState({ sectionPlane: getDefaultSectionPlane(), sectionPickMode: false, sectionPickPreview: null, pointCloudAssetCount: 1, pointCloudPreviewStride: 1 });
});
afterEach(cleanup);

describe('SectionPlaneDragGizmo on the kernel (#5501, #5403)', () => {
  it('an edge-on press starts no drag and leaves the pointer uncaptured', () => {
    // A +Z normal projects foot and tip to the same screen point on the stub camera.
    const { handle, start } = mount([0, 0, 1]);
    pointer(handle, 'pointerdown', 100);
    assert.equal(handle.hasPointerCapture(7), false, 'nothing would ever release this capture');
    assert.equal(useViewerStore.getState().pointCloudPreviewStride, 1, 'no drag started');
    pointer(handle, 'pointermove', 130);
    assert.equal(useViewerStore.getState().sectionPlane.custom?.distance, start);
  });

  it('a press captures, a move along the projected normal slides the plane by pixels / (px per metre), release restores the scan stride', () => {
    const { handle, start } = mount([1, 0, 0]);
    pointer(handle, 'pointerdown', 100);
    assert.equal(handle.hasPointerCapture(7), true);
    assert.equal(useViewerStore.getState().pointCloudPreviewStride, 4, 'a scan is thinned while dragging');
    pointer(handle, 'pointermove', 130);
    assert.ok(Math.abs(useViewerStore.getState().sectionPlane.custom!.distance - (start + 15)) < 1e-9, '30 px along a 2 px/m normal is 15 m');
    pointer(handle, 'pointermove', 100, 140);
    assert.ok(Math.abs(useViewerStore.getState().sectionPlane.custom!.distance - start) < 1e-9, 'movement perpendicular to the normal does nothing');
    pointer(handle, 'pointerup', 100, 140);
    assert.equal(handle.hasPointerCapture(7), false);
    assert.equal(useViewerStore.getState().pointCloudPreviewStride, 1);
  });

  it('the handle follows the LIVE plane as the distance changes, on the shared projector, without a loop of its own', () => {
    const { container, handle, flush, projector, start } = mount([1, 0, 0]);
    const g = handle.closest<SVGGElement>('[data-scene-primitive="handle"]')!;
    // The pick insets the plane a hair off the face (#5480), hence the tolerance.
    const x = () => Number(/translate\(([-\d.]+)px/.exec(g.style.transform)?.[1]);
    assert.ok(Math.abs(x() - 200) < 0.01, `foot at the pick (2 px/m): ${g.style.transform}`);
    const ticks = projector.dirtyTicks;
    act(() => useViewerStore.getState().setSectionCustomDistance(start + 25));
    flush();
    assert.ok(Math.abs(x() - 250) < 0.01, `the foot is pickedAt projected onto the moved plane: ${g.style.transform}`);
    assert.ok(projector.dirtyTicks > ticks, 'the value change woke the one projector');
    assert.equal(container.querySelectorAll('[data-scene-primitive="axis-arrow"]').length, 1);
  });
});
