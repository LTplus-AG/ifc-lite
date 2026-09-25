/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `AnnotationLayer` on the shared scene-overlay kernel (#5511, charter
 * #5478): each pin registers on the shared `SceneProjector` through the
 * `Pin` primitive instead of running its own `requestAnimationFrame` +
 * `projectToScreen` loop. Mounted inside the kernel's real
 * `SceneProjectorProvider`/`SceneOverlayLayers` shell, driven by a stub
 * camera/frame scheduler (`scene-test-support`), so a click on the
 * projected pin exercises the exact registration path production code uses.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { SceneProjectorContext } from '@/components/viewport-ui/scene/SceneProjectorProvider';
import { SceneOverlayLayers } from '@/components/viewport-ui/scene/SceneOverlayLayers';
import { FakeFrameScheduler, StubSource } from '@/components/viewport-ui/scene/test/scene-test-support';
import { SceneProjector } from '@/components/viewport-ui/scene/projector';
import { useViewerStore } from '@/store';
import { AnnotationLayer } from './AnnotationLayer';

afterEach(() => {
  cleanup();
  useViewerStore.setState({
    annotations: new Map(),
    draft: null,
    selectedAnnotationId: null,
  });
});

function mount() {
  const scheduler = new FakeFrameScheduler();
  const source = new StubSource();
  const projector = new SceneProjector(source, { requestFrame: scheduler.request, cancelFrame: scheduler.cancel });
  // A sibling <canvas> so AnnotationLayer's own ResizeObserver-driven bounds
  // measurement (for the popover's edge clamp) has something to find —
  // orthogonal to the projector loop under test here.
  const container = render(
    <>
      <canvas />
      <SceneProjectorContext.Provider value={projector}>
        <SceneOverlayLayers>
          <AnnotationLayer />
        </SceneOverlayLayers>
      </SceneProjectorContext.Provider>
    </>,
  );
  // Wrapped in act(): a dirty tick can call a primitive's `onProject`
  // callback, which here drives a React `setState` (the popover/drop-input's
  // screen anchor) — an un-acted flush leaves that state update unflushed.
  return { container, flush: () => act(() => scheduler.flush()) };
}

describe('AnnotationLayer', () => {
  it('projects a committed annotation as a Pin on the shared projector, with no pin visible before the first tick', () => {
    useViewerStore.setState({
      annotations: new Map([
        [
          'a1',
          {
            id: 'a1',
            position: { x: 5, y: 7, z: 0 },
            note: 'leak here',
            entityExpressId: null,
            modelId: null,
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      ]),
    });
    const { container, flush } = mount();
    const pin = container.querySelector('[data-scene-primitive="pin"]') as SVGGElement;
    assert.ok(pin, 'a Pin is registered for the annotation');
    assert.equal(pin.style.display, 'none', 'not projected until the shared loop ticks');
    flush();
    assert.equal(pin.style.display, '');
    assert.equal(pin.style.transform, 'translate(5px, 7px)');
    // Mutation check: reverting to a bespoke rAF-driven <div> pin would
    // either fail the [data-scene-primitive="pin"] lookup or show the pin
    // immediately (no "hidden before first tick" gate) — this covers both.
  });

  it('clicking the Pin selects the annotation and opens its popover at the projected point', () => {
    useViewerStore.setState({
      annotations: new Map([
        [
          'a1',
          {
            id: 'a1',
            position: { x: 5, y: 7, z: 0 },
            note: 'leak here',
            entityExpressId: null,
            modelId: null,
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      ]),
    });
    const { container, flush } = mount();
    flush();
    const pin = container.querySelector('[data-scene-primitive="pin"][data-annotation-pin-id="a1"]') as SVGGElement;
    assert.ok(pin);
    assert.equal(container.querySelector('[role="dialog"]'), null, 'no popover before selection');
    act(() => {
      pin.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    assert.equal(useViewerStore.getState().selectedAnnotationId, 'a1');
    // The popover anchor is projected through a second, hidden anchor
    // registered on the SAME projector — needs one more tick to resolve.
    flush();
    assert.ok(container.querySelector('[role="dialog"]'), 'popover opens once selected');
    // Mutation check: dropping the onClick wiring on the Pin leaves
    // selectedAnnotationId unset and the popover absent.
  });
});
