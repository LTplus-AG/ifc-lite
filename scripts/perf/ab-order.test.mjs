/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * scripts/perf/ab-order.mjs (#4221).
 *
 * The regression this guards: ab.sh ran every interleaved round as
 * `base, branch` — a fixed order. Interleaving cancels drift ACROSS rounds
 * but not a penalty tied to POSITION within a round (thermal ramp, a warm
 * cache left by the preceding process, a frequency step). Whichever side
 * always went first paid that penalty every round, and it survived the
 * median untouched — a commit compared against itself reported a confident
 * "23.5% faster" with a byte-identical build on both sides.
 *
 * roundOrder() is the fix: for N rounds it hands out ceil(N/2) "base-first"
 * and floor(N/2) "branch-first" slots (as close to a 50/50 split as N
 * allows) and shuffles which specific round gets which. These tests pin:
 *   - the balance property (this is what makes a constant positional
 *     penalty cancel instead of accumulate),
 *   - that it's actually randomized (not a fixed alternating pattern, which
 *     could resonate with a periodic effect instead of cancelling it),
 *   - and the end-to-end demonstration: feeding a synthetic per-POSITION
 *     (not per-side) time penalty through ab-report.mjs's own reporting
 *     logic reports a confident false regression under the OLD fixed order
 *     and "within noise" under the balanced/randomized order — the exact
 *     mechanism from #4221, reproduced deterministically without a real
 *     machine's thermal behaviour.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { roundOrder, seededRand } from './ab-order.mjs';

test('the CLI prints one pairing per round on every platform (#4439: the file-URL guard never matched a Windows argv[1])', () => {
  const cli = fileURLToPath(new URL('./ab-order.mjs', import.meta.url));
  const out = execFileSync(process.execPath, [cli, '5', '4439'], { encoding: 'utf8' });
  const lines = out.trim().split(/\r?\n/);
  assert.equal(lines.length, 5, `expected 5 order lines, got: ${JSON.stringify(out)}`);
  for (const line of lines) {
    assert.ok(line === 'base branch' || line === 'branch base', line);
  }
  assert.deepEqual(
    lines.map((l) => l.split(' ')),
    roundOrder(5, seededRand(4439)),
    'the CLI and the exported roundOrder must agree for the same seed',
  );
});

test('balance: base-first count is ceil(iters/2) for a range of round counts', () => {
  for (const iters of [1, 2, 3, 4, 5, 6, 7, 10, 11, 20]) {
    const order = roundOrder(iters, seededRand(iters * 7919 + 1));
    const baseFirst = order.filter(([first]) => first === 'base').length;
    assert.equal(order.length, iters);
    assert.equal(baseFirst, Math.ceil(iters / 2), `iters=${iters}`);
  }
});

test('every round is a valid pairing of exactly base and branch', () => {
  const order = roundOrder(9, seededRand(42));
  for (const [first, second] of order) {
    assert.ok(
      (first === 'base' && second === 'branch') || (first === 'branch' && second === 'base'),
      `unexpected pair: ${first},${second}`,
    );
  }
});

test('randomized: two different seeds do not produce the same round-by-round order', () => {
  const a = roundOrder(12, seededRand(1)).map(([f]) => f).join('');
  const b = roundOrder(12, seededRand(2)).map(([f]) => f).join('');
  assert.notEqual(a, b, 'two different seeds produced identical orderings — not randomized');
});

test('THE REGRESSION (#4221) would NOT be a fixed alternating pattern either', () => {
  // A fixed base,branch,base,branch,... pattern is what shipped before the
  // fix. A fixed STRICT ALTERNATION (base-first, branch-first, base-first, …)
  // is a different but related failure mode: it's balanced but not random,
  // so it could still resonate with a periodic drift source. Confirm the
  // generator does not degenerate into strict alternation across seeds.
  const patterns = new Set();
  for (let seed = 0; seed < 8; seed++) {
    patterns.add(roundOrder(8, seededRand(seed)).map(([f]) => f).join(''));
  }
  assert.ok(patterns.size > 1, 'every seed produced the same order — generator is not actually randomizing');
});

test('rejects non-positive-integer iters', () => {
  assert.throws(() => roundOrder(0));
  assert.throws(() => roundOrder(-3));
  assert.throws(() => roundOrder(2.5));
  assert.throws(() => roundOrder(NaN));
});

test('seededRand is deterministic and reproducible', () => {
  const a = roundOrder(10, seededRand(123));
  const b = roundOrder(10, seededRand(123));
  assert.deepEqual(a, b);
});

// --- End-to-end demonstration of the #4221 mechanism, deterministically ---
//
// A per-POSITION (not per-side) time penalty simulates the thermal-ramp /
// warm-cache effect the issue describes: whichever process runs first in a
// round is slower by a fixed amount, regardless of whether it's base or
// branch. Feed that through ab-report.mjs's own median+noise-gate logic
// (imported inline below, mirroring its exact formulas) under the OLD fixed
// order and the NEW balanced/randomized order.

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const spreadPct = (xs) => {
  if (xs.length < 2) return 0;
  const med = median(xs);
  if (med <= 0) return 0;
  return ((Math.max(...xs) - Math.min(...xs)) / med) * 100;
};
const pct = (cur, base) => (base > 0 ? ((cur - base) / base) * 100 : null);

/**
 * Simulate ITERS rounds under a given per-round [first, second] order,
 * where the process running first pays POSITION_PENALTY_MS on top of the
 * (identical) true cost, plus a small amount of genuine machine jitter.
 */
function simulate(order, { truCostMs = 40, positionPenaltyMs = 9, jitter }) {
  const values = { base: [], branch: [] };
  let round = 0;
  for (const [first, second] of order) {
    round += 1;
    for (const [side, position] of [[first, 1], [second, 2]]) {
      const penalty = position === 1 ? positionPenaltyMs : 0;
      values[side].push(truCostMs + penalty + jitter(round, side));
    }
  }
  return values;
}

function verdictFor(values) {
  const bMed = median(values.base);
  const brMed = median(values.branch);
  const d = pct(brMed, bMed);
  const noise = spreadPct(values.base);
  const real = d != null && Math.abs(d) > Math.max(noise, 3) && Math.abs(brMed - bMed) >= 1;
  return { bMed, brMed, d, noise, real };
}

test('THE REGRESSION: fixed base-first order reports a confident false regression on byte-identical code', () => {
  const ITERS = 7;
  // Deterministic small jitter (±0.5ms), same generator reused for both
  // scenarios below so only the ORDER differs.
  const jitter = (round, side) => seededRand(round * 97 + (side === 'base' ? 1 : 2))() - 0.5;
  const fixedOrder = Array.from({ length: ITERS }, () => ['base', 'branch']);
  const values = simulate(fixedOrder, { jitter });
  const v = verdictFor(values);
  assert.ok(v.real, `expected a "real" (confident) verdict under fixed order, got ${JSON.stringify(v)}`);
  assert.ok(v.d < 0, 'branch (always second, never pays the position penalty) reads as the faster side');
});

test('THE FIX: balanced/randomized order reports within-noise on the identical scenario (#4221)', () => {
  const ITERS = 7;
  const jitter = (round, side) => seededRand(round * 97 + (side === 'base' ? 1 : 2))() - 0.5;
  const balancedOrder = roundOrder(ITERS, seededRand(4221));
  const values = simulate(balancedOrder, { jitter });
  const v = verdictFor(values);
  assert.ok(!v.real, `expected "within noise" under balanced order, got a real verdict: ${JSON.stringify(v)}`);
});

test('the fix still flags a REAL regression (a genuine per-SIDE, not per-position, slowdown)', () => {
  const ITERS = 7;
  const jitter = (round, side) => seededRand(round * 97 + (side === 'base' ? 1 : 2))() - 0.5;
  const balancedOrder = roundOrder(ITERS, seededRand(4221));
  // branch is genuinely 30% slower than base, regardless of position.
  const values = { base: [], branch: [] };
  let round = 0;
  for (const [first, second] of balancedOrder) {
    round += 1;
    for (const side of [first, second]) {
      const truCost = side === 'branch' ? 40 * 1.3 : 40;
      values[side].push(truCost + jitter(round, side));
    }
  }
  const v = verdictFor(values);
  assert.ok(v.real, `expected the gate to still catch a genuine 30% regression, got ${JSON.stringify(v)}`);
  assert.ok(v.d > 0, 'branch should read as slower, not faster');
});
