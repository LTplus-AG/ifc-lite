/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The doubling-size timing ladder that pins "this decision does not blow up on
 * a long hostile input".
 *
 * ## Why this is one package and not two copies
 *
 * It was two copies, near line-for-line, in
 * `packages/encoding/src/numeric-literal.test.ts` and
 * `packages/ids/src/constraints/numeric-literal.test.ts` (#3224). They had
 * already diverged once: #3221 fixed an unequal-exposure bug in the ids copy
 * and left the encoding copy carrying it, even though the measurements that
 * justified the fix were taken against the encoding function. One
 * implementation means a hardening applied here cannot miss a caller.
 *
 * Placement: a PRIVATE workspace package, following
 * `@ifc-lite/world-frame-fixtures`. The alternative -- a subpath on
 * `@ifc-lite/encoding`, which `@ifc-lite/ids` already depends on -- would need
 * no new package, but it would put a test-only helper on a published package's
 * surface, and an unused public export is permanent semver liability. This
 * package is `private: true` and is a devDependency of both consumers, so it
 * adds no runtime dependency edge to either.
 *
 * ## Why CPU time and not the wall clock
 *
 * The property under test is "the algorithm does a bounded amount of WORK".
 * The wall clock does not measure work; it measures work plus however long the
 * operating system chose not to run us. On a loaded runner those are different
 * by two orders of magnitude, and the difference is what reddened unrelated
 * PRs.
 *
 * Measured on one 12-core machine, the same linear scan over the largest rung
 * (2.56M characters), 200 readings each:
 *
 *   idle          wall p50 3.87ms   p99 5.73ms    max 7.13ms
 *                 cpu  p50 3.87ms   p99 6.99ms    max 7.13ms
 *   900 busy      wall p50 548ms    p99 1533ms    max 1682ms
 *   processes     cpu  p50 5.67ms   p99 8.88ms    max 9.93ms
 *
 * Against a 500ms budget the wall clock is a coin flip at that load and the CPU
 * clock has 50x of margin. Idle, the two clocks agree to the last digit, which
 * is what says the swap changes the instrument's noise and not its reading.
 *
 * This is a TIGHTENING, not a relaxation. For a single-threaded decision CPU
 * time is always less than or equal to wall time, so every input this bound
 * rejects, the wall-clock bound rejected too; the converse is what stopped
 * being true. `process.cpuUsage()` also counts V8's background GC and compiler
 * threads, which can only push a reading up.
 *
 * ## What `process.cpuUsage()` counts, and why that is safe HERE
 *
 * It is a PROCESS-wide counter, not a per-thread one: it sums every thread in
 * the process, so a sibling `worker_threads` worker burning CPU alongside the
 * decision is added to the decision's reading. Measured on the same machine,
 * this exact linear scan over the 2.56M rung, 15 readings each: p50 4.57ms
 * alone, p50 30.40ms with eight sibling workers spinning -- a 6.6x inflation
 * of a number the ladder compares against a fixed budget.
 *
 * That does not bite today because the decision does not share a process with
 * anything. Vitest runs each test file in a forked CHILD PROCESS, and the
 * ladder runs on that child's MAIN thread -- probed in both consuming packages
 * (`@ifc-lite/encoding`, `@ifc-lite/ids`): `isMainThread` true, `threadId` 0,
 * and a pid distinct from the runner's. Sibling test files are separate
 * processes, so their CPU is invisible to this counter. Neither package pins
 * `pool` at all; `packages/parser/vitest.config.ts` is the one place in the
 * repo that spells `pool: 'forks'` out.
 *
 * The dependency is on the POOL, not on anything in this file. Switching a
 * consuming package to `pool: 'threads'` would put sibling test files in one
 * process as workers, and every one of their busy scans would be charged to
 * this reading -- turning a bound that has 50x of margin into a flake, with
 * nothing in the failure message pointing at the pool. Anyone making that
 * switch has to move this ladder's consumers back to `forks` or move the
 * measurement to a per-thread counter. The inflation is one-directional
 * (readings can only go up, never down), so it can produce a false RED but
 * never a false GREEN.
 *
 * What is knowingly given up: a regression that made the decision BLOCK --
 * sleep, or wait on I/O -- would burn wall time without burning CPU and would
 * no longer red. The decisions this ladder is pointed at are synchronous
 * character scans with no I/O in them, so that shape would have to be
 * introduced deliberately.
 *
 * ## Why ATTEMPTS survives, and why it was not enough on its own
 *
 * `Math.min` can only fall, so a reading already inside the budget is final and
 * no repeat is made -- the healthy path is one call per rung. It is kept as a
 * second line of defence, and it costs nothing when nothing is wrong.
 *
 * It was not sufficient by itself, and the reason is worth recording because
 * the comment it replaces claimed otherwise. Three attempts are taken
 * BACK-TO-BACK, so at the largest rung they span about 11ms of real work. They
 * are not independent samples of the runner's load; any contention burst
 * lasting longer than the three readings covers all three. Reproduced: this
 * exact linear scan, unmodified, running the real ladder 100 times under 900
 * busy processes on 12 cores, blew the 2.56M rung 3 times, with readings such
 * as `812.5, 968.1, 549.9` and `1226.1, 1168.2, 1137.6`. `2560000` is the value
 * that was reported from CI against an unrelated parser PR.
 */

/** Per-decision budget, in milliseconds of CPU time. */
export const BUDGET_MS = 500;

/**
 * Ascending, doubling. Ascending is what makes a quadratic implementation
 * REPORT instead of HANG: cost rises 4x per rung, so the first rung it blows
 * costs at most ~4x the budget, and the ladder stops there rather than
 * carrying on to 2.56M where the same implementation would grind for minutes.
 *
 * It self-adapts to the runner in both directions. A slower machine blows a
 * quadratic implementation at a lower rung; a faster one at a higher rung.
 * Either way some rung fails, so the negative controls in the consuming suites
 * need no hardware-tuned number -- the failure that a fixed `regexMs > 50`
 * floor could not survive.
 *
 * It runs past 640k on purpose. The shape an absolute budget alone does not
 * catch is a SUPERLINEAR regression with a constant small enough to stay under
 * the budget (#3226 review): one extra full scan per 4000 characters costs
 * ~143ms at 640k -- inside the budget, so a six-rung ladder would have missed
 * it -- and ~572ms at 1.28M, where it blows.
 */
export const SIZES: readonly number[] = [
  20_000, 40_000, 80_000, 160_000, 320_000, 640_000, 1_280_000, 2_560_000,
];

/** Readings taken at a rung before it is declared blown. See the docblock. */
export const ATTEMPTS = 3;

/** A decision under test: it must REJECT every fixture the ladder feeds it. */
export type Decide = (v: string) => boolean;

export interface LadderOptions {
  /**
   * Builds the hostile fixture of a given length. The trailing non-digit is
   * the whole point for a numeric scan: an all-digit string of any length
   * matches immediately, which is why plausible fixtures miss this.
   */
  readonly hostile: (n: number) => string;
  /** Override for a self-test. Consumers should leave these alone. */
  readonly sizes?: readonly number[];
  readonly budgetMs?: number;
  readonly attempts?: number;
}

/**
 * CPU milliseconds spent inside one call, plus its verdict.
 *
 * `process.cpuUsage()` is checked rather than assumed: a silent fallback to the
 * wall clock would reintroduce exactly the flake this package exists to remove,
 * and it would do so invisibly.
 */
function cpuMsOf(decide: Decide, v: string): { ms: number; verdict: boolean } {
  if (typeof process?.cpuUsage !== 'function') {
    throw new Error(
      'timing-ladder needs process.cpuUsage(); the wall clock is not a substitute (see the docblock in @ifc-lite/timing-ladder)'
    );
  }
  const before = process.cpuUsage();
  const verdict = decide(v);
  const after = process.cpuUsage(before);
  return { ms: (after.user + after.system) / 1000, verdict };
}

/** Fastest of up to `attempts` decisions, stopping as soon as one is in budget. */
function fastestMs(decide: Decide, n: number, opts: Required<Omit<LadderOptions, 'sizes'>> & { sizes: readonly number[] }): number {
  const v = opts.hostile(n);
  let best = Infinity;
  for (let attempt = 0; attempt < opts.attempts; attempt++) {
    const { ms, verdict } = cpuMsOf(decide, v);
    best = Math.min(best, ms);
    // A decision that says "accepted" would mean the timing measured an early
    // return rather than a full scan, so the reading would prove nothing. This
    // throws rather than returning, because a ladder quietly timing the wrong
    // thing is the failure mode this whole file is guarding against.
    if (verdict !== false) {
      throw new Error(
        `timing-ladder: the decision accepted the hostile fixture at n=${n}, so the reading timed an early return rather than a full scan`
      );
    }
    if (best < opts.budgetMs) break;
  }
  return best;
}

/**
 * The first size at which `decide` blew the budget, or `null` if it cleared
 * every rung.
 *
 * Throws if `decide` ever accepts a hostile fixture -- see `fastestMs`.
 */
export function firstBlownRung(decide: Decide, options: LadderOptions): number | null {
  const opts = {
    hostile: options.hostile,
    sizes: options.sizes ?? SIZES,
    budgetMs: options.budgetMs ?? BUDGET_MS,
    attempts: options.attempts ?? ATTEMPTS,
  };
  for (const n of opts.sizes) {
    if (fastestMs(decide, n, opts) >= opts.budgetMs) return n;
  }
  return null;
}
