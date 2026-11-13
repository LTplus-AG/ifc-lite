/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { SETTLED_FRAME_BACKSTOP_MS, afterSettledFrame, createAfterSettledFrame } from './settled-frame';

/** Manual animation frames, timers (with their delays), submitted-frame count and pending-draw flag. */
function harness() {
  let frames: Array<() => void> = [];
  let timers: Array<{ fn: () => void; ms: number }> = [];
  let submitted = 0, pending = false;
  const wait = createAfterSettledFrame({
    frameCount: () => submitted,
    drawPending: () => pending,
    requestFrame: (fn) => { frames.push(fn); },
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return () => { timers = timers.filter((x) => x !== t); }; },
  });
  const runs: string[] = [];
  return {
    runs,
    start: (label = 'work') => wait(() => runs.push(label)),
    /** One animation frame; with `draw`, the viewport submits a live frame in it before the wait's check. */
    frame: (draw = false) => { if (draw) submitted++; const fns = frames; frames = []; for (const fn of fns) fn(); },
    /** The zero-delay tasks queued so far. */
    tasks: () => { const due = timers.filter((t) => t.ms === 0); timers = timers.filter((t) => t.ms !== 0); for (const t of due) t.fn(); },
    /** Every timer, backstops included (time passes). */
    allTimers: () => { const due = timers; timers = []; for (const t of due) t.fn(); },
    submitBeforeStart: () => { submitted++; },
    setPending: (value: boolean) => { pending = value; },
    backstops: () => timers.filter((t) => t.ms === SETTLED_FRAME_BACKSTOP_MS).length,
  };
}

describe('after the settled scene has been drawn', () => {
  it('waits for a live frame submitted after the call, then runs in a task of its own', () => {
    const h = harness();
    h.submitBeforeStart(); // a frame drawn before the call shows an older scene
    h.setPending(true); // the draw of the settled scene is queued (or held back by the frame pacer)
    h.start();
    h.frame(); h.frame(); h.frame(); h.tasks();
    assert.deepEqual(h.runs, [], 'no frame submitted since the call: the work must not run in front of it');
    h.frame(true);
    assert.deepEqual(h.runs, [], 'not inside the animation frame that drew the scene');
    h.tasks();
    assert.deepEqual(h.runs, ['work']);
  });

  it('proceeds after two animation frames in a row with nothing to draw (the screen is already final)', () => {
    const h = harness();
    h.start();
    h.frame(); h.tasks();
    assert.deepEqual(h.runs, [], 'one idle frame is not enough: a draw may be requested inside it');
    h.frame(); h.tasks();
    assert.deepEqual(h.runs, ['work']);
  });

  it('a draw requested between idle frames restarts the count', () => {
    const h = harness();
    h.start();
    h.frame();
    h.setPending(true); h.frame(); // requested, held back
    h.setPending(false); h.frame(); h.tasks();
    assert.deepEqual(h.runs, [], 'only one idle frame since the pending draw');
    h.frame(); h.tasks();
    assert.deepEqual(h.runs, ['work']);
  });

  it('frames that never come (hidden tab) end the wait at the backstop', () => {
    const h = harness();
    h.start();
    assert.equal(h.backstops(), 1);
    h.allTimers();
    assert.deepEqual(h.runs, ['work']);
  });

  it('a draw that stays pending and is never submitted ends the wait at the backstop', () => {
    const h = harness();
    h.setPending(true);
    h.start();
    for (let i = 0; i < 20; i++) h.frame();
    h.tasks();
    assert.deepEqual(h.runs, []);
    h.allTimers();
    assert.deepEqual(h.runs, ['work']);
  });

  it('runs at most once, and nothing once cancelled', () => {
    const h = harness();
    h.start('once');
    const cancel = h.start('cancelled');
    cancel();
    h.frame(true); h.tasks();
    assert.deepEqual(h.runs, ['once']);
    assert.equal(h.backstops(), 0, 'both backstops are cleared: the finished wait\'s and the cancelled one\'s');
    h.allTimers(); h.frame(); h.allTimers();
    assert.deepEqual(h.runs, ['once'], 'nothing runs again; the cancelled wait runs nothing');
  });
});

describe('the viewer wait', () => {
  afterEach(() => setGlobalRendererRef({ current: null } as RefObject<Renderer | null>));

  it('a renderer without a device has nothing to draw: the wait ends on idle frames, well before the backstop', async () => {
    const renderer = { getGPUDevice: () => null, peekRenderRequest: () => true } as unknown as Renderer;
    setGlobalRendererRef({ current: renderer } as RefObject<Renderer | null>);
    const t0 = performance.now();
    await new Promise<void>((resolve) => { afterSettledFrame(resolve); });
    assert.ok(performance.now() - t0 < SETTLED_FRAME_BACKSTOP_MS * 0.8, `took ${(performance.now() - t0).toFixed(0)} ms`);
  });
});
