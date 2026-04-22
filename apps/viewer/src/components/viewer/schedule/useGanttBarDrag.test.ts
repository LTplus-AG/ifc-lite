/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for the pure math inside the bar-drag hook. Drag interaction
 * itself is inherently manual-QA (pointer events + rAF), so the machinery
 * that matters for correctness lives in these two pure helpers —
 * `snapDeltaMs` and `pxPerMs`. Both are exercised on the round-trip
 * pattern the hook uses at runtime: pixel delta → ms delta → snap.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ScheduleTimeRange } from '@/store';
import { snapDeltaMs, pxPerMs } from './useGanttBarDrag';

const DAY = 86_400_000;
const HOUR = 3_600_000;

describe('snapDeltaMs', () => {
  it('snaps to the nearest unit', () => {
    assert.strictEqual(snapDeltaMs(1.4 * HOUR, HOUR), 1 * HOUR);
    assert.strictEqual(snapDeltaMs(1.6 * HOUR, HOUR), 2 * HOUR);
  });

  it('rounds half-way values up (Math.round semantics)', () => {
    assert.strictEqual(snapDeltaMs(0.5 * HOUR, HOUR), 1 * HOUR);
  });

  it('handles negative deltas symmetrically', () => {
    assert.strictEqual(snapDeltaMs(-0.4 * HOUR, HOUR), 0);
    assert.strictEqual(snapDeltaMs(-1.6 * HOUR, HOUR), -2 * HOUR);
  });

  it('is a no-op when unit is 0 or negative (Shift-held path)', () => {
    assert.strictEqual(snapDeltaMs(1234.5, 0), 1234.5);
    assert.strictEqual(snapDeltaMs(1234.5, -10), 1234.5);
  });

  it('returns 0 for 0 delta regardless of unit', () => {
    assert.strictEqual(snapDeltaMs(0, HOUR), 0);
    assert.strictEqual(snapDeltaMs(0, 0), 0);
  });
});

describe('pxPerMs', () => {
  const thirtyDayRange: ScheduleTimeRange = {
    start: 0,
    end: 30 * DAY,
    synthetic: false,
  };

  it('divides pixel width by time span', () => {
    // 1500 px over 30 days → 50 px/day → 50 / 86_400_000 ms.
    const ratio = pxPerMs(1500, thirtyDayRange);
    assert.ok(Math.abs(ratio - 1500 / (30 * DAY)) < 1e-12);
  });

  it('returns 0 when the range is degenerate', () => {
    assert.strictEqual(pxPerMs(1000, { start: 10, end: 10, synthetic: false }), 0);
    assert.strictEqual(pxPerMs(1000, { start: 100, end: 0, synthetic: false }), 0);
  });

  it('returns 0 when pixel width is zero or negative', () => {
    assert.strictEqual(pxPerMs(0, thirtyDayRange), 0);
    assert.strictEqual(pxPerMs(-50, thirtyDayRange), 0);
  });
});

describe('drag math — round-trip pattern the hook uses', () => {
  // The hook does: rawDeltaMs = (clientX - startClientX) / pxPerMs(...)
  // This guards the division: at sane widths + ranges, a 100-px drag
  // yields a sensible ms delta which then snaps to a day-ish unit.
  it('100 px drag over a 30-day schedule at 1500 px → ~2 days', () => {
    const range: ScheduleTimeRange = { start: 0, end: 30 * DAY, synthetic: false };
    const ratio = pxPerMs(1500, range);
    const ms = 100 / ratio;
    const snappedToDay = snapDeltaMs(ms, DAY);
    // 100 / (1500 / (30*DAY)) = 2 days exactly.
    assert.strictEqual(snappedToDay, 2 * DAY);
  });

  it('1 px drag over a 30-day schedule snaps to 0 with a day unit', () => {
    const range: ScheduleTimeRange = { start: 0, end: 30 * DAY, synthetic: false };
    const ratio = pxPerMs(1500, range);
    const ms = 1 / ratio;
    assert.strictEqual(snapDeltaMs(ms, DAY), 0);
  });
});
