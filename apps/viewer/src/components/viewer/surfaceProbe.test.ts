/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The probe cache behind navigation on gated models (#8769): coalescing,
 * which answer a caller may take, the timeout, and late readbacks. The
 * renderer's readback is a hand-resolved promise and the frame scheduler a
 * manual queue, so every interleaving is explicit.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSurfaceProbe, SURFACE_PROBE_MAX_AGE_MS, SURFACE_PROBE_TIMEOUT_MS } from './surfaceProbe.js';

type P = { x: number; y: number; z: number };

function rig() {
  const frames: Array<() => void> = [];
  const calls: Array<{ x: number; y: number; resolve: (p: P | null) => void; reject: (e: unknown) => void }> = [];
  const probe = createSurfaceProbe(
    (x, y) => new Promise<P | null>((resolve, reject) => { calls.push({ x, y, resolve, reject }); }),
    () => ({ getBoundingClientRect: () => ({ width: 800, height: 600 }) as DOMRect }),
    // An identity "camera": a world point projects to its own x/y.
    (p) => ({ x: p.x, y: p.y }),
    (run) => { frames.push(run); },
  );
  const frame = () => { const run = frames.shift(); assert.ok(run, 'a probe was scheduled'); run(); };
  return { probe, calls, frames, frame };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const at = (x: number, y: number): P => ({ x, y, z: 3 });

describe('surface probe cache (#8769)', () => {
  const realNow = Date.now;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let clock = 0;
  let timers: Array<{ at: number; fn: () => void; id: number }> = [];
  const advance = (ms: number) => {
    clock += ms;
    for (const t of timers.filter((t) => t.at <= clock)) { timers = timers.filter((u) => u !== t); t.fn(); }
  };
  beforeEach(() => {
    clock = 1_000_000; timers = [];
    let next = 1;
    Date.now = () => clock;
    globalThis.setTimeout = ((fn: () => void, ms = 0) => { const id = next++; timers.push({ at: clock + ms, fn, id }); return id; }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => { timers = timers.filter((t) => t.id !== id); }) as unknown as typeof clearTimeout;
  });
  afterEach(() => { Date.now = realNow; globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout; });

  it('coalesces requests into one readback at the newest position, answering only callers near it', async () => {
    const r = rig();
    const far = r.probe.request(100, 100);
    const near = r.probe.request(300, 200);
    const same = r.probe.request(302, 201);
    assert.equal(r.frames.length, 1, 'one frame scheduled');
    r.frame();
    assert.deepEqual(r.calls.map((c) => [c.x, c.y]), [[302, 201]]);
    r.calls[0].resolve(at(302, 201));
    assert.equal(await far, null, 'a caller 200 px away is not told about another pixel');
    assert.deepEqual(await near, at(302, 201));
    assert.deepEqual(await same, at(302, 201));
  });

  it('does not answer a caller from a probe under another visibility', async () => {
    const r = rig();
    const before = r.probe.request(10, 10, 'v1');
    const after = r.probe.request(10, 10, 'v2');
    r.frame();
    r.calls[0].resolve(at(10, 10));
    assert.equal(await before, null);
    assert.deepEqual(await after, at(10, 10));
    assert.equal(r.probe.peek(10, 10, 'v1'), null, 'nor serve it from the cache');
    assert.deepEqual(r.probe.peek(10, 10, 'v2'), at(10, 10));
  });

  it('peeks only a fresh point that still projects under the pixel, and a miss clears it', async () => {
    const r = rig();
    void r.probe.request(50, 60);
    r.frame();
    r.calls[0].resolve(at(50, 60));
    await tick();
    assert.deepEqual(r.probe.peek(53, 57), at(50, 60), 'within the 4 px slop');
    assert.equal(r.probe.peek(60, 60), null, 'not under a pixel 10 px away');
    advance(SURFACE_PROBE_MAX_AGE_MS);
    assert.equal(r.probe.peek(50, 60), null, 'too old: the scene may have changed under a still camera');
    void r.probe.request(50, 60);
    r.frame();
    r.calls[1].resolve(at(50, 60));
    await tick();
    void r.probe.request(50, 60);
    r.frame();
    r.calls[2].resolve(null);
    await tick();
    assert.equal(r.probe.peek(50, 60), null, 'a miss at the pixel replaces the cached point');
  });

  it('a readback that never settles frees the slot after the timeout, and later requests are served', async () => {
    const r = rig();
    const stuck = r.probe.request(5, 5);
    r.frame();
    void r.probe.request(7, 7);
    assert.equal(r.frames.length, 0, 'one readback in flight at a time');
    advance(SURFACE_PROBE_TIMEOUT_MS);
    assert.equal(await stuck, null);
    assert.equal(r.frames.length, 1, 'the queued request runs once the slot is free');
    r.frame();
    r.calls[1].resolve(at(7, 7));
    await tick();
    assert.deepEqual(r.probe.peek(7, 7), at(7, 7));
  });

  it('a slow readback that lands after its timeout still fills the cache, unless a newer one landed first', async () => {
    const r = rig();
    const slow = r.probe.request(5, 5);
    r.frame();
    await tick();
    advance(SURFACE_PROBE_TIMEOUT_MS);
    assert.equal(await slow, null, 'the caller hears null at the timeout');
    r.calls[0].resolve(at(5, 5)); // a slow GPU: valid, just late
    await tick();
    assert.deepEqual(r.probe.peek(5, 5), at(5, 5), 'the late answer is kept, not thrown away');
    advance(SURFACE_PROBE_MAX_AGE_MS - SURFACE_PROBE_TIMEOUT_MS);
    assert.equal(r.probe.peek(5, 5), null, 'aged from when its frame was read, not from when it landed');

    void r.probe.request(9, 9);
    r.frame();
    await tick();
    advance(SURFACE_PROBE_TIMEOUT_MS);
    await tick();
    void r.probe.request(20, 20);
    r.frame();
    r.calls[2].resolve(at(20, 20));
    await tick();
    r.calls[1].resolve(at(9, 9)); // older, landing after the newer one
    await tick();
    assert.deepEqual(r.probe.peek(20, 20), at(20, 20), 'an old readback never overwrites a newer answer');
  });

  it('a timed-out readback landing before the next one is cached, then replaced by it', async () => {
    const r = rig();
    void r.probe.request(5, 5);
    r.frame();
    await tick();
    advance(SURFACE_PROBE_TIMEOUT_MS);
    await tick();
    void r.probe.request(80, 80);
    r.frame();
    await tick();
    r.calls[0].resolve(at(5, 5));
    await tick();
    assert.deepEqual(r.probe.peek(5, 5), at(5, 5));
    r.calls[1].resolve(at(80, 80));
    await tick();
    assert.deepEqual(r.probe.peek(80, 80), at(80, 80));
    assert.equal(r.probe.peek(5, 5), null, 'the newer answer replaced it');
  });

  it('a renderer that throws synchronously does not wedge probing', async () => {
    let calls = 0;
    const frames: Array<() => void> = [];
    const probe = createSurfaceProbe(
      () => { calls++; if (calls === 1) throw new Error('sync'); return Promise.resolve(at(2, 2)); },
      () => ({ getBoundingClientRect: () => ({ width: 800, height: 600 }) as DOMRect }),
      (p) => ({ x: p.x, y: p.y }),
      (run) => { frames.push(run); },
    );
    const realWarn = console.warn;
    console.warn = () => {};
    try {
      const first = probe.request(2, 2);
      frames.shift()!();
      assert.equal(await first, null);
      const second = probe.request(2, 2);
      frames.shift()!();
      assert.deepEqual(await second, at(2, 2));
    } finally {
      console.warn = realWarn;
    }
  });

  it('a failed readback answers null and keeps probing', async () => {
    const r = rig();
    const realWarn = console.warn;
    console.warn = () => {};
    try {
      const failed = r.probe.request(1, 1);
      r.frame();
      r.calls[0].reject(new Error('lost'));
      assert.equal(await failed, null);
      const next = r.probe.request(1, 1);
      r.frame();
      r.calls[1].resolve(at(1, 1));
      assert.deepEqual(await next, at(1, 1));
    } finally {
      console.warn = realWarn;
    }
  });
});
