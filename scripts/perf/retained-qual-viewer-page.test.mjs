/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { INIT_SCRIPT, PAGE_KEY } from './retained-qual-viewer-page.mjs';

/** The page script run against a hand-driven clock, rAF queue, store and renderer. */
function harness() {
  const listeners = [], subscribers = [];
  const clock = { now: 0 };
  let queue = [];
  const world = { models: new Map(), loading: true };
  const store = { getState: () => world, subscribe: fn => subscribers.push(fn) };
  const renderer = { frame: null, gpu: { batches: 100 }, owner: { flat: null, instance: false } };
  const context = vm.createContext({
    performance: { now: () => clock.now }, PerformanceObserver: class { observe() {} },
    document: { addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }) },
    requestAnimationFrame: fn => queue.push(fn),
    __ifc_lite_viewer_store__: store,
    __ifc_lite_render_stats__: () => ({ frame: renderer.frame, gpu: renderer.gpu }),
    __ifc_lite_scene_owner__: () => renderer.owner,
  });
  vm.runInContext(INIT_SCRIPT, context);
  const q = () => context[PAGE_KEY];
  const tick = at => { clock.now = at; const run = queue; queue = []; run.forEach(fn => fn()); };
  const store$ = (at, patch) => { clock.now = at; Object.assign(world, patch); subscribers.forEach(fn => fn(world)); };
  const model = (rg, meshes = 0, loadState = 'loading') => new Map([['m', { retainedGeometry: rg, geometryResult: { meshes: new Array(meshes).fill({ expressId: 1 }) }, loadState }]]);
  const listener = () => listeners.find(l => l.type === 'change' && l.capture === true).fn;
  return { q, tick, store$, renderer, model, listener, change: at => { clock.now = at; listener()({ target: { type: 'file' } }); }, clock };
}

test('the origin is the capture-phase file input change; other inputs do not start it', () => {
  const h = harness();
  assert.equal(h.q().loadChangeMs, null);
  h.clock.now = 5;
  h.listener()({ target: { type: 'text' } });
  assert.equal(h.q().loadChangeMs, null);
  h.change(10);
  assert.equal(h.q().loadChangeMs, 10);
  h.change(20);
  assert.equal(h.q().loadChangeMs, 10, 'the first change is the load invocation');
});

test('8413: a retained draw at 20 observed at 21 is the first frame, without copying scene geometry', () => {
  const h = harness(); h.tick(1); h.change(2);
  h.store$(10, { models: h.model({ published: 1, completeness: 'running' }, 1) });
  h.renderer.frame = { timestamp: 20, drawCalls: 4 }; h.tick(21);
  assert.equal(h.q().firstRetainedFrameMs, 20);
  h.renderer.frame = { timestamp: 30, drawCalls: 4 }; h.tick(31);
  assert.equal(h.q().firstRetainedFrameMs, 20);
});

test('an instanced owner counts as held; terminal then settled needs a later drawing frame with unchanged GPU bytes', () => {
  const h = harness();
  h.tick(1); h.change(2);
  h.store$(10, { models: h.model({ published: 2, completeness: 'running' }, 2) });
  h.renderer.owner = { flat: null, instance: true };
  h.renderer.frame = { timestamp: 5, drawCalls: 1 };
  h.tick(11);
  assert.equal(h.q().sceneHeldMs, null);
  h.renderer.frame = { timestamp: 15, drawCalls: 2 };
  h.tick(16);
  assert.equal(h.q().firstRetainedFrameMs, 15);
  assert.equal(h.q().terminalMs, null, 'still running');
  h.store$(20, { loading: false, models: h.model({ published: 2, completeness: 'complete' }, 2, 'complete') });
  assert.equal(h.q().terminalMs, 20);
  h.renderer.frame = { timestamp: 19, drawCalls: 2 };       // predates terminal
  h.tick(21);
  assert.equal(h.q().settledFrameMs, null);
  h.renderer.gpu = { batches: 200 };                        // an upload lands
  h.renderer.frame = { timestamp: 25, drawCalls: 2 };
  h.tick(26);
  assert.equal(h.q().settledFrameMs, null, 'resident bytes changed since the previous tick');
  h.renderer.frame = { timestamp: 30, drawCalls: 2 };
  h.tick(31);
  assert.equal(h.q().settledFrameMs, 30);
});

test('no first retained frame and no settle without a renderer hook or frames (never a guess)', () => {
  const h = harness();
  h.tick(1); h.change(2);
  h.store$(10, { loading: false, models: h.model({ published: 2, completeness: 'complete' }, 2, 'complete') });
  for (let t = 11; t < 40; t += 3) h.tick(t);
  assert.equal(h.q().firstRetainedFrameMs, null);
  assert.equal(h.q().settledFrameMs, null);
  assert.equal(h.q().terminalMs, 10);
});
