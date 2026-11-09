/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Timeout option semantics for the re-mesh client (P5, PR #9483 review). */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { armDeadline, deadlineDelay, MAX_TIMER_DELAY_MS } from './deadline.js';

describe('deadlineDelay (P5)', () => {
  it('passes a positive finite delay through', () => {
    expect(deadlineDelay(30_000)).toBe(30_000);
  });

  it('clamps a delay setTimeout would overflow to 2^31-1 ms', () => {
    expect(deadlineDelay(2 ** 40)).toBe(MAX_TIMER_DELAY_MS);
    expect(deadlineDelay(MAX_TIMER_DELAY_MS + 1)).toBe(MAX_TIMER_DELAY_MS);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'reads %s as no deadline',
    (ms) => { expect(deadlineDelay(ms)).toBeNull(); },
  );
});

describe('armDeadline (P5)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('fires once at the delay and not after cancel', () => {
    vi.useFakeTimers();
    const fired = vi.fn();
    armDeadline(1_000, fired);
    vi.advanceTimersByTime(999);
    expect(fired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fired).toHaveBeenCalledTimes(1);
    const cancelled = vi.fn();
    armDeadline(1_000, cancelled)();
    vi.advanceTimersByTime(5_000);
    expect(cancelled).not.toHaveBeenCalled();
  });

  it('an overflowing delay does not fire early (would be ~1 ms unclamped)', () => {
    vi.useFakeTimers();
    const fired = vi.fn();
    armDeadline(2 ** 40, fired);
    vi.advanceTimersByTime(60_000);
    expect(fired).not.toHaveBeenCalled();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('arms no timer for "no deadline" (%s)', (ms) => {
    vi.useFakeTimers();
    const fired = vi.fn();
    // Count before cancelling: a cancelled timer would hide one wrongly armed.
    const cancel = armDeadline(ms, fired);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(MAX_TIMER_DELAY_MS);
    expect(fired).not.toHaveBeenCalled();
    cancel();
  });
});
