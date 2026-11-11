/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `whenQuiet` decides when the start screen's 3D mark may start. With
 * `requestIdleCallback` it is the browser's idle period, bounded at the
 * timeout. Without it (Safari) a 50 ms timer samples the main thread: two
 * on-time samples in a row start the mark, a busy page holds it until the
 * timeout. Driven here by a scripted clock whose timers can be made late.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LATE_MS, SAMPLE_MS, whenQuiet, type IdleHost } from './welcome-mark-schedule.js';

/** A clock with timers; each timer fires `lateBy()` ms after it is due (a task held the thread). */
function clock(lateBy: () => number = () => 0) {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; cb: () => void }>();
  const cleared: number[] = [];
  const host: IdleHost = {
    setTimeout: (cb, ms) => { const h = next++; timers.set(h, { at: now + ms + lateBy(), cb }); return h; },
    clearTimeout: (h) => { cleared.push(h); timers.delete(h); },
    now: () => now,
  };
  return {
    host,
    cleared,
    pending: () => timers.size,
    /** Advance to `until`, firing timers in order. */
    run(until: number) {
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].cb();
      }
      now = until;
    },
  };
}

describe('when the welcome mark may start without requestIdleCallback', () => {
  it('a quiet page starts it after two on-time samples', () => {
    const c = clock();
    let started = -1;
    whenQuiet(() => { started = c.host.now(); }, 2000, c.host);
    c.run(SAMPLE_MS);
    assert.equal(started, -1, 'one quiet sample is not enough');
    c.run(1000);
    assert.equal(started, 2 * SAMPLE_MS);
  });

  it('a busy page holds it until the timeout, not a fixed wall-clock delay', () => {
    const c = clock(() => LATE_MS + 25); // every sample runs late: the thread is busy
    let started = -1;
    whenQuiet(() => { started = c.host.now(); }, 2000, c.host);
    c.run(1999);
    assert.equal(started, -1, 'still busy before the timeout');
    c.run(5000);
    assert.ok(started >= 2000 && started < 2000 + SAMPLE_MS + LATE_MS + 25, `started at ${started}`);
  });

  it('cancel clears the pending sample and it never starts', () => {
    const c = clock();
    let started = false;
    const cancel = whenQuiet(() => { started = true; }, 2000, c.host);
    c.run(SAMPLE_MS); // one sample in
    cancel();
    assert.equal(c.pending(), 0);
    assert.equal(c.cleared.length, 1);
    c.run(5000);
    assert.equal(started, false);
  });
});

describe('when the welcome mark may start with requestIdleCallback', () => {
  it('waits for the idle period, bounded by the timeout, and cancels through cancelIdleCallback', () => {
    const calls: Array<{ timeout: number }> = [];
    const cancelled: number[] = [];
    const host: IdleHost = {
      requestIdleCallback: (_cb, options) => { calls.push(options); return 7; },
      cancelIdleCallback: (h) => { cancelled.push(h); },
      setTimeout: () => { throw new Error('no timer fallback when idle callbacks exist'); },
      clearTimeout: () => {},
      now: () => 0,
    };
    const cancel = whenQuiet(() => {}, 2000, host);
    assert.deepEqual(calls, [{ timeout: 2000 }]);
    cancel();
    assert.deepEqual(cancelled, [7]);
  });
});
