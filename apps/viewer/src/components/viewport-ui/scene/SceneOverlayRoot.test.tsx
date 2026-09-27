/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `SceneOverlayRoot` end to end against a REAL `Renderer` (no WebGPU
 * device, matching `SectionPlaneDragGizmo.test.tsx`'s pattern): one SVG
 * layer, one DOM layer, `OverlayDefs` mounted once, `pointer-events-none`
 * at the root, and a `Handle` child that projects through the real
 * `Camera.projectToScreen` (#5486).
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { Renderer } from '@ifc-lite/renderer';
import { cleanup, render } from '@/test/render.js';
import { setGlobalRendererRef } from '@/hooks/useBCF.js';
import { SceneOverlayRoot } from './SceneOverlayRoot.js';
import { Handle } from './primitives/Handle.js';

let originalRaf: typeof requestAnimationFrame;
let originalCaf: typeof cancelAnimationFrame;
let rafQueue: FrameRequestCallback[];

beforeEach(() => {
  originalRaf = globalThis.requestAnimationFrame;
  originalCaf = globalThis.cancelAnimationFrame;
  rafQueue = [];
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  };
  globalThis.cancelAnimationFrame = () => {};
});

afterEach(() => {
  cleanup();
  setGlobalRendererRef({ current: null });
  globalThis.requestAnimationFrame = originalRaf;
  globalThis.cancelAnimationFrame = originalCaf;
});

function flushRaf() {
  const due = rafQueue;
  rafQueue = [];
  for (const cb of due) act(() => cb(16));
}

describe('SceneOverlayRoot', () => {
  it('mounts exactly one SVG layer and one DOM layer, both pointer-events-none, with OverlayDefs mounted once', () => {
    const ui = render(<SceneOverlayRoot />);
    const root = ui.querySelector('[data-scene-overlay-root]')!;
    assert.match(root.className, /pointer-events-none/);
    assert.match(root.className, /z-\(--z-scene\)/);
    const svgs = root.querySelectorAll('svg');
    assert.equal(svgs.length, 1);
    assert.equal(svgs[0]!.querySelectorAll('filter').length, 1, 'one shared glow filter, not one per primitive');
    assert.equal(svgs[0]!.querySelectorAll('marker').length, 2, 'accent + ink arrowheads, defined once');
    const domLayers = root.querySelectorAll(':scope > div');
    assert.equal(domLayers.length, 1);
    assert.match(domLayers[0]!.className, /pointer-events-none/);
  });

  it('projects a Handle child through the real renderer camera', () => {
    const canvas = document.createElement('canvas');
    Object.defineProperties(canvas, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 600 },
    });
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-viewport', 'main');
    wrapper.appendChild(canvas);
    document.body.appendChild(wrapper);

    const renderer = new Renderer(canvas);
    renderer.getCamera().projectToScreen = () => ({ x: 123, y: 45 });
    setGlobalRendererRef({ current: renderer });

    const root = render(
      <SceneOverlayRoot>
        <Handle worldPoint={{ x: 1, y: 2, z: 3 }} />
      </SceneOverlayRoot>,
    );
    wrapper.appendChild(root);

    flushRaf(); // registration tick — the source resolves the canvas, and RendererProjectorSource is bootstrap-dirty until then
    flushRaf(); // now-resolved camera/canvas: projects for real

    const g = root.querySelector('[data-scene-primitive="handle"]') as SVGGElement;
    assert.ok(g);
    assert.equal(g.style.display, '');
    assert.equal(g.style.transform, 'translate(123px, 45px)');

    wrapper.remove();
  });

  it('wakes the idle projector on a pointermove over the viewport canvas', () => {
    const canvas = document.createElement('canvas');
    Object.defineProperties(canvas, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 600 },
    });
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-viewport', 'main');
    wrapper.appendChild(canvas);
    document.body.appendChild(wrapper);

    const renderer = new Renderer(canvas);
    renderer.getCamera().projectToScreen = () => ({ x: 1, y: 1 });
    setGlobalRendererRef({ current: renderer });

    const root = render(
      <SceneOverlayRoot>
        <Handle worldPoint={{ x: 1, y: 2, z: 3 }} />
      </SceneOverlayRoot>,
    );
    wrapper.appendChild(root);

    flushRaf(); // resolves the canvas (bootstrap-dirty) and attaches the wake listeners
    flushRaf(); // projects for real; this tick is not dirty afterwards and goes idle
    assert.equal(rafQueue.length, 0, 'idle: no frame pending');

    act(() => {
      canvas.dispatchEvent(new window.PointerEvent('pointermove', { bubbles: true }));
    });
    assert.equal(rafQueue.length, 1, 'a pointermove on the canvas wakes the projector');
    // Mutation check: removing the `canvas.addEventListener('pointermove', wake, …)`
    // call in SceneProjectorProvider would leave `rafQueue` empty here.

    wrapper.remove();
  });
});
