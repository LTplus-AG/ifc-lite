/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `RectSelectionOverlay` on the shared scene-overlay kernel (#5512, charter
 * #5478): the drag rect portals into the kernel's SVG layer instead of
 * mounting its own `<svg>`.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup } from '@/test/render.js';
import { renderScene } from '@/components/viewport-ui/scene/test/scene-test-support';
import { RectSelectionOverlay } from './RectSelectionOverlay';

afterEach(() => cleanup());

describe('RectSelectionOverlay', () => {
  it('portals a rect into the shared scene SVG layer at the drag bounds', () => {
    const { container } = renderScene(<RectSelectionOverlay rect={{ x0: 40, y0: 10, x1: 10, y1: 30 }} />);
    const rect = container.querySelector('[data-scene-primitive="rect-selection"]') as SVGRectElement;
    assert.ok(rect, 'rect renders into the kernel SVG layer');
    assert.equal(rect.getAttribute('x'), '10');
    assert.equal(rect.getAttribute('y'), '10');
    assert.equal(rect.getAttribute('width'), '30');
    assert.equal(rect.getAttribute('height'), '20');
    // Mutation check: swapping `Math.min(rect.x0, rect.x1)` for `rect.x0`
    // would report x=40 here instead of the normalized 10 (the drag ran
    // right-to-left), failing this assertion.
  });

  it('renders nothing while no drag is in progress', () => {
    const { container } = renderScene(<RectSelectionOverlay rect={null} />);
    assert.equal(container.querySelector('[data-scene-primitive="rect-selection"]'), null);
    // Mutation check: dropping the `!rect` early return would still call
    // `useSceneLayer`/`createPortal` with garbage geometry from a null rect.
  });

  it('drops a sub-pixel drag rather than drawing a zero-size marquee', () => {
    const { container } = renderScene(<RectSelectionOverlay rect={{ x0: 5, y0: 5, x1: 5.4, y1: 5.4 }} />);
    assert.equal(container.querySelector('[data-scene-primitive="rect-selection"]'), null);
    // Mutation check: removing the `width < 1 || height < 1` guard would
    // render a visible dashed rect for a drag too small to be intentional.
  });
});
