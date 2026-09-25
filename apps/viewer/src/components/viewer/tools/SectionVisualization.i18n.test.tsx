/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup } from '@/test/render.js';
import { registerLocale, setLocale } from '@/i18n';
import { useViewerStore } from '@/store';
import { getDefaultSectionPlane } from '@/store/slices/sectionSlice.js';
import { renderScene } from '../../viewport-ui/scene/test/scene-test-support.js';
import { SectionPlaneVisualization } from './SectionVisualization.js';

function pointer(target: Element, type: string, x: number): void {
  act(() => target.dispatchEvent(new window.PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 7, clientX: x, clientY: 100,
  })));
}

beforeEach(() => {
  window.localStorage.clear();
  setLocale('en');
  useViewerStore.setState({
    activeTool: 'section', sectionPlane: getDefaultSectionPlane(), sectionPickMode: false,
    sectionPickPreview: null, pointCloudAssetCount: 1, pointCloudPreviewStride: 1,
  });
});

afterEach(() => {
  cleanup();
  setLocale('en');
  window.localStorage.clear();
});

/** The gizmo's handle, mounted on the kernel's stub projector (#5501). */
function mountedHandle(): { handle: Element; container: HTMLElement } {
  act(() => useViewerStore.getState().setSectionPlaneFromFace([1, 0, 0], [100, 100, 0]));
  const { container, flush } = renderScene(<SectionPlaneVisualization enabled />);
  flush();
  const handle = container.querySelector('[data-scene-primitive="handle"] circle');
  assert.ok(handle);
  return { handle, container };
}

describe('mounted Section visualization localization (#4785)', () => {
  it('renders a translated custom-plane gizmo title and preserves dragging', () => {
    registerLocale('gizmo', { 'sectionTool.gizmo.dragTitle': 'Glisser la coupe sur sa normale' });
    setLocale('gizmo');
    const { handle } = mountedHandle();
    assert.equal(handle.querySelector('title')?.textContent, 'Glisser la coupe sur sa normale');
    const before = useViewerStore.getState().sectionPlane.custom?.distance;
    assert.equal(typeof before, 'number');
    pointer(handle, 'pointerdown', 100);
    assert.equal(useViewerStore.getState().pointCloudPreviewStride, 4);
    pointer(handle, 'pointermove', 130);
    const after = useViewerStore.getState().sectionPlane.custom?.distance;
    assert.equal(typeof after, 'number');
    assert.notEqual(after, before);
    pointer(handle, 'pointerup', 130);
    assert.equal(useViewerStore.getState().pointCloudPreviewStride, 1);
  });

  it('falls back a missing tooltip key to exact English and re-renders an active catalogue in place', () => {
    registerLocale('partial-visual', { 'sectionTool.heading': 'Coupe' });
    setLocale('partial-visual');
    const { handle } = mountedHandle();
    assert.equal(handle.querySelector('title')?.textContent, 'Drag to slide the cut along its normal');
    act(() => registerLocale('partial-visual', { 'sectionTool.gizmo.dragTitle': 'Remplacé' }));
    assert.equal(handle.querySelector('title')?.textContent, 'Remplacé', 'same handle node, new text');
  });
});
