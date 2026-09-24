/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `RendererProjectorSource.isDirty()` against a real `Renderer` (no WebGPU
 * device, matching `SectionPlaneDragGizmo.test.tsx`'s pattern) — the
 * camera-pose comparison that replaced `peekRenderRequest()` after it lost
 * a real race against the main render loop's per-frame consumption (see
 * this module's docblock). Mutation-checked.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from '@ifc-lite/renderer';
import { setGlobalRendererRef } from '@/hooks/useBCF.js';
import { RendererProjectorSource } from './renderer-source.js';

afterEach(() => setGlobalRendererRef({ current: null }));

function makeWiredSource() {
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
  setGlobalRendererRef({ current: renderer });
  const container = document.createElement('div');
  wrapper.appendChild(container);
  const source = new RendererProjectorSource({ current: container }, () => {});
  return { source, renderer, wrapper };
}

describe('RendererProjectorSource.isDirty', () => {
  it('reports dirty before the renderer/canvas resolve', () => {
    const container = document.createElement('div'); // not under any [data-viewport]
    const source = new RendererProjectorSource({ current: container }, () => {});
    assert.equal(source.isDirty(), true);
  });

  it('is dirty on the first real read (nothing to compare against yet), then settles false with no camera change', () => {
    const { source, wrapper } = makeWiredSource();
    assert.equal(source.isDirty(), true, 'first read has no prior snapshot');
    assert.equal(source.isDirty(), false, 'same pose, same canvas size — not dirty');
    assert.equal(source.isDirty(), false);
    wrapper.remove();
  });

  it('goes dirty on a pan — position AND target move together, so rotation/distance stay identical', () => {
    // `camera.setPosition` alone isn't representative: with `target` left
    // behind, `getRotation()`/`getDistance()` (both DERIVED from
    // position-relative-to-target) change too, so a comparison that only
    // checked rotation/distance would still catch it — a pan is the real
    // case that isolates "position changed, pose direction/distance did not".
    const { source, renderer, wrapper } = makeWiredSource();
    source.isDirty(); // establish the baseline snapshot
    assert.equal(source.isDirty(), false);
    const camera = renderer.getCamera();
    const rotationBefore = camera.getRotation();
    const distanceBefore = camera.getDistance();
    camera.pan(50, 0);
    assert.deepEqual(camera.getRotation(), rotationBefore, 'pan does not change rotation');
    assert.equal(camera.getDistance(), distanceBefore, 'pan does not change distance');
    assert.equal(source.isDirty(), true, 'position moved even though rotation/distance did not');
    assert.equal(source.isDirty(), false, 'settled again at the new pose');
    // Mutation check: dropping the `position.x !== snapshot.position.x || …`
    // clauses (comparing only rotation/distance/canvas size) leaves this
    // reading false — verified live: removing them made this assertion fail.
    wrapper.remove();
  });

  it('does NOT rely on Renderer.peekRenderRequest — a pending render request with an unchanged pose is not "dirty"', () => {
    const { source, renderer, wrapper } = makeWiredSource();
    source.isDirty();
    renderer.requestRender();
    assert.equal(renderer.peekRenderRequest(), true, 'the flag this used to read IS set');
    assert.equal(source.isDirty(), false, 'but the pose has not moved, so this reports settled');
    wrapper.remove();
  });
});
