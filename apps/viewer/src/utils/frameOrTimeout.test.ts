/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { waitForFrameOrTimeout, type FrameOrTimeoutDeps } from './frameOrTimeout.js';

/** A rAF stand-in that NEVER calls its callback — simulates a hidden tab, where
 * the browser suspends the callback queue indefinitely. */
function hiddenTabDeps(log: string[]): FrameOrTimeoutDeps {
  let timeoutId = 0;
  const timers = new Map<number, () => void>();
  return {
    requestFrame: () => {
      log.push('rAF queued (never fires)');
      return -1;
    },
    setTimeoutFn: (cb, ms) => {
      const id = ++timeoutId;
      timers.set(id, cb);
      log.push(`timeout armed (${ms}ms)`);
      // Fire synchronously for the test — stands in for "the timer elapsed".
      queueMicrotask(() => {
        if (timers.has(id)) {
          timers.delete(id);
          log.push('timeout fired');
          cb();
        }
      });
      return id;
    },
    clearTimeoutFn: (id) => {
      if (timers.delete(id as number)) log.push('timeout cleared');
    },
  };
}

/** A rAF stand-in that fires immediately (synchronously via microtask) — the
 * normal, visible-tab case. */
function visibleTabDeps(log: string[]): FrameOrTimeoutDeps {
  let timeoutId = 0;
  const timers = new Map<number, () => void>();
  return {
    requestFrame: (cb) => {
      log.push('rAF fires');
      queueMicrotask(cb);
      return -1;
    },
    setTimeoutFn: (cb, ms) => {
      const id = ++timeoutId;
      timers.set(id, cb);
      log.push(`timeout armed (${ms}ms)`);
      return id;
    },
    clearTimeoutFn: (id) => {
      if (timers.delete(id as number)) log.push('timeout cleared');
    },
  };
}

describe('waitForFrameOrTimeout', () => {
  it('RED: an unbounded bare-rAF wait never settles when rAF never fires (hidden tab)', async () => {
    // Demonstrates the exact bug shape from #2385: a plain
    // `new Promise(resolve => requestAnimationFrame(resolve))` awaited
    // directly against an rAF stand-in that never calls back.
    let requestFrame: (cb: () => void) => void = () => {
      /* never calls cb — simulates a hidden tab's suspended rAF queue */
    };
    const bareWait = new Promise<void>((resolve) => requestFrame(() => resolve()));
    const bounded = Promise.race([
      bareWait.then(() => 'resolved' as const),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 50)),
    ]);
    const outcome = await bounded;
    // The bare wait never resolves on its own — only the test's own outer
    // timeout saves us here. This is the hang the issue describes.
    assert.equal(outcome, 'timed-out');
  });

  it('hidden tab: falls back to the timeout and resolves within the bound', async () => {
    const log: string[] = [];
    const start = Date.now();
    await waitForFrameOrTimeout(1, 200, hiddenTabDeps(log));
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 1000, `expected to resolve well under 1s, took ${elapsed}ms`);
    assert.ok(log.includes('timeout fired'), 'expected the timeout fallback to fire');
  });

  it('visible tab: resolves via rAF and clears the fallback timer (bounding control)', async () => {
    const log: string[] = [];
    await waitForFrameOrTimeout(1, 200, visibleTabDeps(log));
    assert.ok(log.includes('rAF fires'), 'expected rAF to be requested');
    assert.ok(log.includes('timeout cleared'), 'expected the fallback timer to be cleared by rAF winning the race');
    assert.ok(!log.includes('timeout fired'), 'the fallback timer must not fire once rAF has already resolved');
  });

  it('does not resolve twice when both the frame and the timeout could fire', async () => {
    let resolveCount = 0;
    let capturedCb: (() => void) | null = null;
    let capturedTimeoutCb: (() => void) | null = null;
    const deps: FrameOrTimeoutDeps = {
      requestFrame: (cb) => {
        capturedCb = cb;
        return -1;
      },
      setTimeoutFn: (cb) => {
        capturedTimeoutCb = cb;
        return -1;
      },
      clearTimeoutFn: () => {
        /* no-op: deliberately don't clear, to prove `done()` is still idempotent */
      },
    };
    const p = waitForFrameOrTimeout(1, 200, deps).then(() => {
      resolveCount++;
    });
    // Fire the frame callback AND the timeout callback — both "win" the race
    // at the deps level; the promise must still only settle once.
    capturedCb!();
    capturedTimeoutCb!();
    capturedCb!();
    capturedTimeoutCb!();
    await p;
    assert.equal(resolveCount, 1);
  });

  it('frames=2 waits two rAF ticks deep before resolving', async () => {
    const calls: number[] = [];
    const deps: FrameOrTimeoutDeps = {
      requestFrame: (cb) => {
        calls.push(calls.length + 1);
        cb();
        return -1;
      },
      setTimeoutFn: () => -1,
      clearTimeoutFn: () => {},
    };
    await waitForFrameOrTimeout(2, 200, deps);
    assert.deepEqual(calls, [1, 2]);
  });
});
