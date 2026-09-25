/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Add element preview's readouts are scene-kernel `WorldLabel`s
 * (#5503): the wall length and the slab width / depth appear as
 * world-anchored label cards on the shared DOM layer, not as SVG
 * `<text>` drawn by the overlay itself. Driven through the real store and
 * the scene harness (stub projector: world x/y → screen px).
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { cleanup } from '@/test/render.js';
import { renderScene } from '../../viewport-ui/scene/test/scene-test-support.js';
import { AddElementOverlay } from './AddElementOverlay.js';

let originalRaf: typeof requestAnimationFrame;
let originalCaf: typeof cancelAnimationFrame;

beforeEach(() => {
  // The overlay's own camera-tick loop would re-schedule forever under a
  // real rAF; park it (the projector under test uses its own fake scheduler).
  originalRaf = globalThis.requestAnimationFrame;
  originalCaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  useViewerStore.setState({
    activeTool: 'addElement',
    addElementAutoSpacePreview: null,
    cameraCallbacks: {
      projectToScreen: (p: { x: number; y: number; z: number }) => ({ x: p.x * 10, y: p.z * 10 }),
      getViewpoint: () => null,
    },
  } as unknown as Partial<ReturnType<typeof useViewerStore.getState>>);
});

afterEach(() => {
  cleanup();
  globalThis.requestAnimationFrame = originalRaf;
  globalThis.cancelAnimationFrame = originalCaf;
  useViewerStore.setState({ activeTool: 'select', addElementPendingPoints: [], addElementHoverPoint: null });
});

const labels = (root: ParentNode) =>
  Array.from(root.querySelectorAll('[data-scene-primitive="world-label"]')).map((el) => el.textContent);

describe('AddElementOverlay readouts as WorldLabel (#5503)', () => {
  it('shows the live wall length as one accent world label at the segment midpoint', () => {
    useViewerStore.setState({
      addElementType: 'wall',
      addElementPendingPoints: [{ x: 0, y: 0, z: 0 }],
      addElementHoverPoint: { x: 2, y: 0, z: 0 },
    } as unknown as Partial<ReturnType<typeof useViewerStore.getState>>);
    const { container, flush } = renderScene(<AddElementOverlay />);
    flush();
    assert.deepEqual(labels(container), ['2.000 m']);
    const outer = container.querySelector('[data-scene-primitive="world-label"]') as HTMLElement;
    assert.equal(outer.style.transform, 'translate(1px, 0px)', 'anchored on the world midpoint (stub camera: x→px)');
    assert.match((outer.firstElementChild as HTMLElement).className, /border-overlay-accent/, 'the live readout is accent');
    assert.equal(container.querySelectorAll('svg text').length, 0, 'no overlay-drawn SVG text label remains');
  });

  it('shows slab width and depth as two world labels', () => {
    useViewerStore.setState({
      addElementType: 'slab',
      addElementSlabMode: 'rectangle',
      addElementPendingPoints: [{ x: 0, y: 0, z: 0 }],
      addElementHoverPoint: { x: 3, y: 0, z: -2 },
    } as unknown as Partial<ReturnType<typeof useViewerStore.getState>>);
    const { container, flush } = renderScene(<AddElementOverlay />);
    flush();
    assert.deepEqual(labels(container), ['3.000 m', '2.000 m']);
  });
});
