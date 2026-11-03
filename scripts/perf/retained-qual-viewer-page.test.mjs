/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { INIT_SCRIPT, PAGE_KEY } from './retained-qual-viewer-page.mjs';

/** The page script run against a hand-driven clock, rAF queue, store and renderer. */
function harness(statsCost = 0) {
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
    __ifc_lite_render_frame__: () => renderer.frame,
    __ifc_lite_render_stats__: () => { clock.now += statsCost; return { frame: renderer.frame, gpu: renderer.gpu }; },
    __ifc_lite_scene_owner__: () => renderer.owner,
  });
  vm.runInContext(INIT_SCRIPT, context);
  const q = () => context[PAGE_KEY];
  const tick = at => { clock.now = at; const run = queue; queue = []; run.forEach(fn => fn()); };
  const store$ = (at, patch) => { clock.now = at; Object.assign(world, patch); subscribers.forEach(fn => fn(world)); };
  const model = (rg, meshes = 0, loadState = 'loading') => new Map([['m', { retainedGeometry: rg, geometryResult: { meshes: new Array(meshes).fill({ expressId: 1 }) }, loadState }]]);
  const listener = () => listeners.find(l => l.type === 'change' && l.capture === true).fn;
  return { q, tick, store$, renderer, model, listener, change: at => { clock.now = at; listener()({ target: { type: 'file' } }); }, clock, raf: fn => context.requestAnimationFrame(fn) };
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

test('terminal then settled needs a later drawing frame with unchanged GPU bytes', () => {
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

// PR #8413: multiple viewer callbacks in one animation tick cannot overwrite the
// first retained draw before the instrumentation observes it.
test('8413: capture the first draw before a later callback replaces frame stats', () => {
  const h = harness(); h.tick(1); h.change(2);
  h.store$(10, { models: h.model({ published: 1, completeness: 'running' }, 1) });
  h.raf(() => { h.renderer.frame = { timestamp: 20, drawCalls: 3 }; });
  h.raf(() => { h.renderer.frame = { timestamp: 21, drawCalls: 0 }; });
  h.tick(22);
  assert.equal(h.q().firstRetainedFrameMs, 20);
});

// #8413: earlier observations must not delay a later retained drawing callback.
test('8413: expensive scene statistics never enter the first-frame interval', () => {
  const h = harness(100); h.tick(1); h.change(2);
  h.store$(10, { models: h.model({ published: 1, completeness: 'running' }, 1) });
  h.raf(() => { h.renderer.frame = { timestamp: h.clock.now, drawCalls: 0 }; });
  h.raf(() => { h.renderer.frame = { timestamp: h.clock.now, drawCalls: 3 }; });
  h.tick(20);
  assert.equal(h.q().firstRetainedFrameMs, 20);
});

test('8413: repeated observations of the upload frame cannot become a settled draw', () => {
  const h = harness(); h.tick(1); h.change(2);
  h.store$(10, { models: h.model({ published: 1, completeness: 'running' }, 1) });
  h.renderer.frame = { timestamp: 15, drawCalls: 2 }; h.tick(16);
  h.store$(20, { loading: false, models: h.model({ published: 1, completeness: 'complete' }, 1, 'complete') });
  h.renderer.gpu = { batches: 200 };
  h.renderer.frame = { timestamp: 25, drawCalls: 2 }; h.tick(26);
  // On-demand rendering stops after the upload draw. Repeated ticks see its snapshot.
  for (const at of [27, 28, 29]) {
    h.tick(at);
    assert.equal(h.q().settledFrameMs, null, 'no new completed renderer submission');
  }
  // A real completed submission produces a fresh snapshot, even at equal clock precision.
  h.renderer.frame = { timestamp: 25, drawCalls: 2 }; h.tick(30);
  assert.equal(h.q().settledFrameMs, 25);
});

test('8413: a store update with no model cannot throw out of the viewer setState', () => {
  const h = harness(); h.tick(1); h.change(2);
  h.store$(10, { models: h.model({ published: 1, completeness: 'running' }, 1) });
  assert.notEqual(h.q().firstProductMs, null);
  assert.doesNotThrow(() => h.store$(20, { loading: false, models: new Map() }));
  assert.equal(h.q().terminalMs, null);
});

test('8413: scene accounting waits for terminal, and the terminal baseline still gates settling', () => {
  let reads = 0;
  const h = harness(); h.tick(1); h.change(2);
  const stats = h.renderer; const original = Object.getOwnPropertyDescriptor(stats, 'gpu');
  let gpu = { batches: 100 };
  Object.defineProperty(stats, 'gpu', { get: () => { reads++; return gpu; }, set: v => { gpu = v; }, configurable: true, enumerable: original.enumerable });
  h.store$(10, { models: h.model({ published: 1, completeness: 'running' }, 1) });
  h.renderer.frame = { timestamp: 15, drawCalls: 2 }; h.tick(16);
  h.renderer.frame = { timestamp: 17, drawCalls: 2 }; h.tick(18);
  assert.equal(h.q().firstRetainedFrameMs, 15);
  assert.equal(reads, 0, 'no scene walk before terminal');
  h.store$(20, { loading: false, models: h.model({ published: 1, completeness: 'complete' }, 1, 'complete') });
  assert.equal(reads, 1, 'one baseline read at the terminal stamp');
  gpu = { batches: 200 };                                   // an upload lands after the baseline
  h.renderer.frame = { timestamp: 25, drawCalls: 2 }; h.tick(26);
  assert.equal(h.q().settledFrameMs, null, 'bytes differ from the terminal baseline');
  h.renderer.frame = { timestamp: 30, drawCalls: 2 }; h.tick(31);
  assert.equal(h.q().settledFrameMs, 30);
});

test('7955: page-created workers are counted by script, peak live follows terminate()', () => {
  class FakeWorker { constructor(url) { this.url = url; } terminate() {} }
  const context = vm.createContext({ Worker: FakeWorker, performance: { now: () => 0 }, PerformanceObserver: class { observe() {} },
    document: { addEventListener() {} }, requestAnimationFrame: () => {} });
  vm.runInContext(INIT_SCRIPT, context);
  const make = url => vm.runInContext(`new Worker(${JSON.stringify(url)})`, context);
  const a = make('https://h/assets/retained.worker-abc.js?worker_file&type=module');
  make('https://h/assets/retained.worker-abc.js');
  a.terminate();
  make('blob:https://h/1234');
  const w = context[PAGE_KEY].workers;
  assert.equal(w.created, 3);
  assert.equal(w.terminated, 1);
  assert.equal(w.peakLive, 2);
  assert.deepEqual({ ...w.byScript }, { 'https://h/assets/retained.worker-abc.js?worker_file&type=module': 1, 'https://h/assets/retained.worker-abc.js': 1, 'blob:https://h/1234': 1 });
  assert.ok(vm.runInContext('new Worker("x") instanceof Worker', context), 'still a Worker');
});

// PR #8540: same basenames are distinct scripts; termination is per worker.
test('8540: distinct worker paths and repeated termination preserve live counts', () => {
  class FakeWorker { terminate() {} }
  const context = vm.createContext({ Worker: FakeWorker, performance: { now: () => 0 }, PerformanceObserver: class { observe() {} },
    document: { addEventListener() {} }, requestAnimationFrame: () => {} });
  vm.runInContext(INIT_SCRIPT, context);
  const a = vm.runInContext('new Worker("/parser/worker.js")', context);
  a.terminate(); a.terminate();
  vm.runInContext('new Worker("/parser/worker.js"); new Worker("/renderer/worker.js")', context);
  const w = context[PAGE_KEY].workers;
  assert.equal(w.terminated, 1);
  assert.equal(w.peakLive, 2);
  assert.deepEqual({ ...w.byScript }, { '/parser/worker.js': 2, '/renderer/worker.js': 1 });
});

test('8540: blob identities and query variants remain distinct worker scripts', () => {
  class FakeWorker { terminate() {} }
  const context = vm.createContext({ Worker: FakeWorker, performance: { now: () => 0 }, PerformanceObserver: class { observe() {} },
    document: { addEventListener() {} }, requestAnimationFrame: () => {} });
  vm.runInContext(INIT_SCRIPT, context);
  const urls = ['blob:https://h/first', 'blob:https://h/second', '/worker.js?version=1', '/worker.js?version=2'];
  for (const url of [...urls, urls[0]]) vm.runInContext(`new Worker(${JSON.stringify(url)})`, context);
  assert.deepEqual({ ...context[PAGE_KEY].workers.byScript }, Object.fromEntries(urls.map((url, i) => [url, i === 0 ? 2 : 1])));
});

test('7955: a Worker constructor that throws counts no worker and the error still reaches the page', () => {
  class FakeWorker { constructor(url) { if (url === 'bad') throw new SyntaxError('invalid worker URL'); } terminate() {} }
  const context = vm.createContext({ Worker: FakeWorker, performance: { now: () => 0 }, PerformanceObserver: class { observe() {} },
    document: { addEventListener() {} }, requestAnimationFrame: () => {} });
  vm.runInContext(INIT_SCRIPT, context);
  assert.throws(() => vm.runInContext('new Worker("bad")', context), /invalid worker URL/);
  const w = context[PAGE_KEY].workers;
  assert.deepEqual([w.created, w.peakLive, { ...w.byScript }], [0, 0, {}], 'no worker exists, so none is counted');
  vm.runInContext('new Worker("/ok.js")', context);
  assert.deepEqual([w.created, w.peakLive, { ...w.byScript }], [1, 1, { '/ok.js': 1 }]);
});
