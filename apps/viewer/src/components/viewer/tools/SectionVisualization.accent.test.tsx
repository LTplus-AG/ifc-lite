/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5488 (charter #5478): the section drag gizmo and face-pick preview draw
 * in the one interaction accent for face-picked planes. No per-axis
 * Material hue and no custom-plane violet is painted. The corner axis badge
 * is gone (#5500): nothing in the scene carries an axis hue any more.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { Renderer } from '@ifc-lite/renderer';
import { cleanup, render } from '@/test/render.js';
import { setGlobalRendererRef } from '@/hooks/useBCF.js';
import { useViewerStore } from '@/store';
import { getDefaultSectionPlane } from '@/store/slices/sectionSlice.js';
import { SectionPlaneVisualization } from './SectionVisualization.js';

let originalRaf: typeof requestAnimationFrame;
let originalCaf: typeof cancelAnimationFrame;
let frame: FrameRequestCallback | undefined;

/** Every colour an SVG element paints through a presentation attribute or inline style. */
function paintedLiterals(ui: HTMLElement): string[] {
  const out: string[] = [];
  for (const el of ui.querySelectorAll('svg *')) {
    for (const attr of ['fill', 'stroke', 'stop-color', 'flood-color']) {
      const v = el.getAttribute(attr);
      if (v && v !== 'none') out.push(`${el.tagName} ${attr}=${v}`);
    }
    const style = el.getAttribute('style') ?? '';
    if (/#[0-9a-f]{3,8}\b|rgba?\(/i.test(style)) out.push(`${el.tagName} style=${style}`);
  }
  return out;
}

function classesOf(el: Element | null): string[] {
  assert.ok(el, 'element is rendered');
  return (el.getAttribute('class') ?? '').split(/\s+/);
}

function mountRenderer(): void {
  const canvas = document.createElement('canvas');
  Object.defineProperties(canvas, {
    clientWidth: { configurable: true, value: 800 },
    clientHeight: { configurable: true, value: 600 },
  });
  setGlobalRendererRef({ current: new Renderer(canvas) });
}

beforeEach(() => {
  frame = undefined;
  originalRaf = globalThis.requestAnimationFrame;
  originalCaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => { frame = cb; return 1; };
  globalThis.cancelAnimationFrame = () => { frame = undefined; };
  useViewerStore.setState({ sectionPlane: getDefaultSectionPlane(), sectionPickPreview: null });
});

afterEach(() => {
  cleanup();
  setGlobalRendererRef({ current: null });
  globalThis.requestAnimationFrame = originalRaf;
  globalThis.cancelAnimationFrame = originalCaf;
});

describe('section overlay uses the interaction accent (#5488)', () => {
  it('cardinal cut: no badge, no axis hue, nothing painted in the scene', () => {
    const ui = render(<SectionPlaneVisualization enabled />);
    assert.equal(ui.querySelector('[data-section-badge]'), null, 'the corner badge is gone (#5500)');
    assert.deepEqual(paintedLiterals(ui), []);
    assert.deepEqual([...ui.querySelectorAll('svg *')].filter((el) => /\b(fill|stroke)-axis-/.test(el.getAttribute('class') ?? '')), []);
  });

  it('face-picked plane: accent drag gizmo', () => {
    mountRenderer();
    act(() => useViewerStore.getState().setSectionPlaneFromFace([1, 1, 0], [0, 0, 0]));
    const ui = render(<SectionPlaneVisualization enabled />);
    act(() => frame?.(16));
    assert.deepEqual(paintedLiterals(ui), [], 'no violet or other literal is painted');
    const handle = ui.querySelector('circle[cursor="grab"]');
    assert.ok(classesOf(handle).includes('fill-overlay-accent'), 'gizmo handle is accent');
    const shaft = handle?.parentElement?.querySelector('line') ?? null;
    assert.ok(classesOf(shaft).includes('stroke-overlay-accent'), 'gizmo arrow is accent');
  });

  it('face-pick hover preview quad and arrow are accent', () => {
    mountRenderer();
    act(() => useViewerStore.setState({
      sectionPickPreview: { point: [0, 0, 0], normal: [0, 1, 0], faceKey: 'f' },
    }));
    const ui = render(<SectionPlaneVisualization enabled={false} />);
    act(() => frame?.(16));
    const preview = ui.querySelector('[data-section-pick-preview]');
    assert.ok(preview, 'the preview is drawn');
    assert.deepEqual(paintedLiterals(ui), []);
    const [quad, head] = preview.querySelectorAll('polygon');
    assert.ok(classesOf(quad).includes('fill-overlay-accent-soft'));
    assert.ok(classesOf(quad).includes('stroke-overlay-accent'));
    assert.ok(classesOf(preview.querySelector('line')).includes('stroke-overlay-accent'));
    assert.ok(classesOf(head).includes('fill-overlay-accent'));
  });
});
