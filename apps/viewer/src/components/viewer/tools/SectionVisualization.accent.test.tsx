/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5488 / #5501 (charter #5478): the section drag gizmo and face-pick
 * preview are the shared scene primitives (`AxisArrow`, `Handle`,
 * `PlaneOutline`) driven by the ONE projector loop, drawn in the one
 * interaction accent. No per-axis hue, no custom-plane violet, no `<svg>`
 * or rAF loop of the tool's own.
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

/** Every colour an SVG element paints through a presentation attribute or inline style. */
function paintedLiterals(root: ParentNode): string[] {
  const out: string[] = [];
  for (const el of root.querySelectorAll('svg *')) {
    for (const attr of ['fill', 'stroke', 'stop-color', 'flood-color']) {
      const v = el.getAttribute(attr);
      if (v && v !== 'none') out.push(`${el.tagName} ${attr}=${v}`);
    }
    const style = el.getAttribute('style') ?? '';
    if (/#[0-9a-f]{3,8}\b|rgba?\(/i.test(style)) out.push(`${el.tagName} style=${style}`);
  }
  return out;
}

const classesOf = (el: Element | null) => (el?.getAttribute('class') ?? '').split(/\s+/);

beforeEach(() => {
  useViewerStore.setState({ sectionPlane: getDefaultSectionPlane(), sectionPickMode: false, sectionPickPreview: null });
});
afterEach(cleanup);

describe('section scene marks on the kernel (#5501)', () => {
  it('a cardinal cut draws nothing in the scene', () => {
    const { container, flush, projector } = renderScene(<SectionPlaneVisualization enabled />);
    flush();
    assert.equal(container.querySelectorAll('[data-scene-primitive]').length, 0);
    assert.equal(projector.anchorCount, 0, 'nothing registered on the projector');
  });

  it('a face-picked plane is an accent AxisArrow plus an active Handle on the shared projector, in the accent only', () => {
    act(() => useViewerStore.getState().setSectionPlaneFromFace([1, 0, 0], [4, 2, 0]));
    const { container, flush, projector } = renderScene(<SectionPlaneVisualization enabled />);
    assert.equal(projector.anchorCount, 5, 'gizmo foot + tip for the drag math, the arrow\'s foot + tip, the handle: all on the one projector');
    flush();
    assert.deepEqual(paintedLiterals(container), [], 'no violet or other literal is painted');
    const arrow = container.querySelector('[data-scene-primitive="axis-arrow"]')!;
    assert.ok(classesOf(arrow).includes('stroke-overlay-accent'), 'the gizmo arrow is accent');
    assert.equal((arrow as SVGElement).style.display, '', 'projected by the kernel tick');
    const handle = container.querySelector('[data-scene-primitive="handle"] circle')!;
    assert.ok(classesOf(handle).includes('fill-overlay-accent'), 'the handle is the accent (active)');
    assert.equal(container.querySelectorAll('svg').length, 1, 'the kernel SVG layer only — no <svg> of the tool\'s own');
  });

  it('the face-pick preview is the plane\'s own styling (PlaneOutline) plus an accent telltale, and paints nothing for a degenerate pick', () => {
    act(() => useViewerStore.setState({ sectionPickMode: true, sectionPickPreview: { point: [100, 100, 0], normal: [0, 1, 0], faceKey: 'f' } }));
    const { container, flush } = renderScene(<SectionPlaneVisualization enabled={false} />);
    flush();
    const quad = container.querySelector('[data-scene-primitive="plane-outline"]')!;
    assert.ok(classesOf(quad).includes('fill-overlay-accent-soft'));
    assert.ok(classesOf(quad).includes('stroke-overlay-accent'));
    assert.equal((quad as SVGElement).style.display, '');
    assert.ok(classesOf(container.querySelector('[data-scene-primitive="axis-arrow"]')).includes('stroke-overlay-accent'));
    assert.deepEqual(paintedLiterals(container), []);
    act(() => useViewerStore.setState({ sectionPickPreview: { point: [100, 100, 0], normal: [0, 0, 0], faceKey: 'g' } }));
    assert.equal(container.querySelectorAll('[data-scene-primitive]').length, 0, 'a zero normal is nothing drawable (#2495)');
  });
});
