/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { Renderer } from '@ifc-lite/renderer';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale } from '@/i18n';
import { setGlobalRendererRef } from '@/hooks/useBCF.js';
import { useViewerStore } from '@/store';
import { getDefaultSectionPlane } from '@/store/slices/sectionSlice.js';
import { ViewportHud } from '../../viewport-ui/hud/ViewportHud.js';
import { ToolOverlays } from '../ToolOverlays.js';
import { SceneOverlayRoot } from '@/components/viewport-ui/scene';

let originalRequestAnimationFrame: typeof requestAnimationFrame;
let originalCancelAnimationFrame: typeof cancelAnimationFrame;
let frame: FrameRequestCallback | undefined;

function pointer(target: Element, type: string, x: number): void {
  act(() => target.dispatchEvent(new window.PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 7, clientX: x, clientY: 100,
  })));
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem('ifc-lite:section-last-mode', JSON.stringify({ kind: 'cardinal', axis: 'down', position: 50, flipped: false }));
  setLocale('en');
  frame = undefined;
  originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => { frame = callback; return 1; };
  globalThis.cancelAnimationFrame = () => { frame = undefined; };
  useViewerStore.setState({
    activeTool: 'section', sectionPlane: getDefaultSectionPlane(), sectionPickMode: false,
    sectionPickPreview: null, pointCloudAssetCount: 1, pointCloudPreviewStride: 1,
  });
});

afterEach(() => {
  cleanup();
  setGlobalRendererRef({ current: null });
  setLocale('en');
  globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  window.localStorage.clear();
});

describe('mounted Section visualization localization (#4785)', () => {
  it('renders a translated custom-plane gizmo title and preserves dragging', () => {
    registerLocale('gizmo', { 'sectionTool.gizmo.dragTitle': 'Glisser la coupe sur sa normale' });
    setLocale('gizmo');
    const canvas = document.createElement('canvas');
    Object.defineProperties(canvas, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 600 },
    });
    const renderer = new Renderer(canvas);
    setGlobalRendererRef({ current: renderer });
    act(() => useViewerStore.getState().setSectionPlaneFromFace([1, 1, 0], [0, 0, 0]));
    const ui = render(<><ViewportHud /><SceneOverlayRoot><ToolOverlays /></SceneOverlayRoot></>);
    act(() => frame?.(16));
    const title = [...ui.querySelectorAll('title')].find((candidate) => candidate.textContent === 'Glisser la coupe sur sa normale');
    assert.ok(title, 'translated title is reachable through ToolOverlays and the production visualization');
    const handle = title.parentElement;
    assert.ok(handle instanceof SVGCircleElement);
    Object.defineProperties(handle, {
      setPointerCapture: { configurable: true, value: () => {} },
      releasePointerCapture: { configurable: true, value: () => {} },
    });
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

  it('falls back a missing tooltip key to exact English, and draws no badge text at all', () => {
    registerLocale('partial-visual', { 'sectionTool.heading': 'Coupe' });
    setLocale('partial-visual');
    const canvas = document.createElement('canvas');
    Object.defineProperties(canvas, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 600 },
    });
    setGlobalRendererRef({ current: new Renderer(canvas) });
    const ui = render(<><ViewportHud /><SceneOverlayRoot><ToolOverlays /></SceneOverlayRoot></>);
    assert.equal(ui.querySelectorAll('svg text').length, 0, 'the corner badge is gone (#5500)');
    act(() => useViewerStore.getState().setSectionPlaneFromFace([1, 0, 0], [0, 0, 0]));
    act(() => frame?.(16));
    assert.ok([...ui.querySelectorAll('title')].some((candidate) => candidate.textContent === 'Drag to slide the cut along its normal'));
  });
});
