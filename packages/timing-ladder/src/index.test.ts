/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The ladder's own tests. A timing harness that cannot go red is worse than no
 * timing harness, because it reads as protection -- and this particular ladder
 * has a history of it: one earlier negative control was accidentally linear and
 * proved nothing, and one earlier assertion could not fail at all (#3285). So
 * every claim the implementation makes is pinned here rather than described:
 * that it clears a linear decision, that it blows a quadratic one, that it
 * refuses a decision which accepts the fixture, and -- the load-bearing one --
 * that it is reading the CPU clock and not the wall clock.
 */
import { describe, it, expect } from 'vitest';
import { firstBlownRung, SIZES, BUDGET_MS, ATTEMPTS } from './index.js';

/** The fixture shape the consuming suites use: a digit run plus one non-digit. */
const hostile = (n: number): string => `-${'9'.repeat(n)}X`;

/** Linear: one pass, rejects on the trailing character. */
const linear = (v: string): boolean => {
  let i = 0;
  if (i < v.length && (v[i] === '+' || v[i] === '-')) i++;
  let digits = 0;
  while (i < v.length && v[i] >= '0' && v[i] <= '9') { i++; digits++; }
  return digits > 0 && i === v.length;
};

/** Quadratic on a failing input: re-scans the tail at every split point. */
const quadratic = (v: string): boolean => {
  let run = 0;
  while (run < v.length && (v[run] === '+' || v[run] === '-' || (v[run] >= '0' && v[run] <= '9'))) run++;
  for (let take = run; take >= 1; take--) {
    let i = take;
    while (i < v.length && v[i] >= '0' && v[i] <= '9') i++;
    if (i === v.length) return true;
  }
  return false;
};

describe('the ladder is a real instrument', () => {
  it('exposes the shape the consuming suites pin their comments to', () => {
    // These are quoted as figures in both consumers' docblocks; changing one
    // without re-recording those figures is meant to red here.
    expect(BUDGET_MS).toBe(500);
    expect(ATTEMPTS).toBe(3);
    expect([...SIZES]).toEqual([20_000, 40_000, 80_000, 160_000, 320_000, 640_000, 1_280_000, 2_560_000]);
  });

  it('clears every rung for a linear decision', { timeout: 60_000 }, () => {
    expect(firstBlownRung(linear, { hostile })).toBeNull();
  });

  it('can fail: a quadratic decision blows a rung', { timeout: 60_000 }, () => {
    expect(firstBlownRung(quadratic, { hostile })).not.toBeNull();
  });

  it('refuses a decision that accepts the fixture, instead of timing an early return', () => {
    // Without this the ladder would happily report `null` for a decision that
    // returns immediately, which is the vacuous-instrument failure mode.
    expect(() => firstBlownRung(() => true, { hostile, sizes: [20_000] })).toThrow(
      /accepted the hostile fixture at n=20000/
    );
  });

  it('measures a real cost: a decision made 100x more expensive blows a budget the cheap one clears', () => {
    // Pins that the reading is a MEASUREMENT and not a constant. A ladder that
    // always read zero would clear both of these.
    const heavy = (v: string): boolean => {
      let sink = 0;
      for (let pass = 0; pass < 100; pass++) for (let i = 0; i < v.length; i++) if (v[i] >= '0') sink++;
      if (sink < 0) return true;
      return linear(v);
    };
    const opts = { hostile, sizes: [320_000], budgetMs: 20 } as const;
    expect(firstBlownRung(linear, opts)).toBeNull();
    expect(firstBlownRung(heavy, opts)).toBe(320_000);
  });
});

describe('it reads the CPU clock, not the wall clock (#3224)', () => {
  /**
   * The discriminator, and the whole reason the flake is gone. `Atomics.wait`
   * blocks the thread for a real wall-clock second while burning essentially no
   * CPU -- which is what a descheduled process on a loaded runner looks like
   * from the inside. Under the wall clock this decision blows a 500ms budget
   * every single time; under the CPU clock it clears it.
   *
   * If someone swaps `process.cpuUsage()` back to `performance.now()`, this is
   * the test that reds.
   */
  it('a decision that blocks for a wall-clock second still clears a 500ms budget', () => {
    const lock = new Int32Array(new SharedArrayBuffer(4));
    const blocking = (v: string): boolean => {
      Atomics.wait(lock, 0, 0, 1_000);
      return linear(v);
    };
    const t0 = performance.now();
    const blown = firstBlownRung(blocking, { hostile, sizes: [20_000], budgetMs: BUDGET_MS });
    const wallMs = performance.now() - t0;

    // The block really happened -- otherwise the assertion below is vacuous.
    expect(wallMs).toBeGreaterThan(900);
    // ...and the ladder did not count it, because it is not work.
    expect(blown).toBeNull();
  });
});
