/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest';
import type { ActionEvent } from '../log/types.js';
import { IdleMineScheduler } from './scheduler.js';

let seq = 1;
function event(intent: ActionEvent['intent'], ts: string): ActionEvent {
  return { seq: seq++, ts, intent, params: {} as never, success: true } as ActionEvent;
}

function fakeTimer() {
  let pending: { cb: () => void; ms: number } | null = null;
  return {
    set(cb: () => void, ms: number) {
      pending = { cb, ms };
      return () => { pending = null; };
    },
    fire() {
      const p = pending;
      pending = null;
      p?.cb();
    },
    pending: () => pending,
  };
}

describe('IdleMineScheduler', () => {
  it('schedules a mine after idle, surfaces patterns via subscribe', () => {
    const timer = fakeTimer();
    let nowMs = 0;
    const scheduler = new IdleMineScheduler({
      idleAfterMs: 1000,
      minIntervalMs: 0,
      setTimer: timer.set,
      now: () => nowMs,
      miner: { minOccurrences: 2, minSessions: 2, minLength: 2 },
    });
    const listener = vi.fn();
    scheduler.subscribe(listener);
    // Two sessions of the same pattern.
    scheduler.push(event('model.load', '2026-01-01T10:00:00.000Z'));
    scheduler.push(event('lens.apply', '2026-01-01T10:00:01.000Z'));
    nowMs = 10 * 60 * 60 * 1000; // shift far enough to make a new session
    scheduler.push(event('model.load', '2026-01-02T10:00:00.000Z'));
    scheduler.push(event('lens.apply', '2026-01-02T10:00:01.000Z'));

    expect(listener).not.toHaveBeenCalled();
    timer.fire();
    expect(listener).toHaveBeenCalledTimes(1);
    const ev = listener.mock.calls[0][0];
    expect(ev.patterns.length).toBeGreaterThanOrEqual(1);
  });

  it('respects the minInterval floor', () => {
    const timer = fakeTimer();
    let nowMs = 1_000_000;
    const scheduler = new IdleMineScheduler({
      idleAfterMs: 100,
      minIntervalMs: 1000,
      setTimer: timer.set,
      now: () => nowMs,
    });
    scheduler.push(event('model.load', '2026-01-01T10:00:00.000Z'));
    timer.fire();
    // First fire goes through.
    scheduler.push(event('lens.apply', '2026-01-01T10:00:01.000Z'));
    // Schedule fires immediately again; floor not yet met (we haven't
    // advanced the clock). Should schedule a follow-up.
    timer.fire();
    expect(timer.pending()).not.toBeNull();
  });

  it('fireNow runs synchronously', () => {
    const scheduler = new IdleMineScheduler({
      minIntervalMs: 0,
      setTimer: () => () => {},
      miner: { minOccurrences: 1, minSessions: 1, minLength: 1 },
    });
    scheduler.push(event('model.load', '2026-01-01T10:00:00.000Z'));
    const result = scheduler.fireNow();
    expect(result.patterns.length).toBeGreaterThan(0);
  });

  it('dispose cancels pending + drops listeners', () => {
    const timer = fakeTimer();
    const scheduler = new IdleMineScheduler({ idleAfterMs: 100, setTimer: timer.set });
    const listener = vi.fn();
    scheduler.subscribe(listener);
    scheduler.push(event('model.load', '2026-01-01T10:00:00.000Z'));
    scheduler.dispose();
    expect(timer.pending()).toBeNull();
  });
});
