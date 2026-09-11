#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Within-pair execution order for ab.sh's interleaved rounds (#4221).
//
// ab.sh used to run every round as `base, branch` — interleaving guards
// against drift ACROSS rounds (a machine that slows down mid-run drags both
// sides equally), but a fixed order does nothing about a penalty tied to
// POSITION within a round (thermal ramp, a cache state left by the
// preceding process, a frequency step on the first process after idle).
// Whichever side always runs first pays that penalty every round, and it
// survives the median untouched — a commit compared against itself came out
// "23.5% faster", confidently, because of this alone.
//
// The fix: for each invocation, decide per round which side runs first, but
// keep the two options BALANCED across all rounds (as close to half base
// first / half branch first as the round count allows) and RANDOMIZE which
// specific rounds get which order. Balance makes a constant positional
// penalty land on both sides equally often, so it cancels in the median
// instead of accumulating on one side. Randomizing which rounds are which
// stops the position assignment from correlating with time-based drift too
// (a fixed alternating pattern, e.g. round 1 base-first / round 2
// branch-first / round 3 base-first…, could still resonate with a
// periodic effect).

import { pathToFileURL } from 'node:url';

/**
 * @param {number} iters positive integer round count
 * @param {() => number} rand uniform [0,1) generator (defaults to Math.random)
 * @returns {Array<['base'|'branch', 'base'|'branch']>} one [first, second]
 *   pair per round.
 */
export function roundOrder(iters, rand = Math.random) {
  if (!Number.isInteger(iters) || iters < 1) {
    throw new Error(`roundOrder: iters must be a positive integer (got ${iters})`);
  }
  const baseFirstCount = Math.ceil(iters / 2);
  const slots = Array.from({ length: iters }, (_, i) => (i < baseFirstCount ? 'base-first' : 'branch-first'));
  // Fisher-Yates shuffle.
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }
  return slots.map((s) => (s === 'base-first' ? ['base', 'branch'] : ['branch', 'base']));
}

// Deterministic PRNG for `--seed`, so a reported run can be replayed exactly
// (and so tests don't depend on Math.random). mulberry32.
export function seededRand(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// CLI: `node ab-order.mjs <iters> [seed]` prints one "first second" line per
// round (e.g. "base branch"), consumed by ab.sh.
//
// The guard goes through `pathToFileURL` rather than string-prefixing
// `file://`: on Windows `process.argv[1]` is `C:\...b-order.mjs` while
// `import.meta.url` is `file:///C:/.../ab-order.mjs`, so the naive comparison
// never matched there and ab.sh ran ZERO rounds while still printing a
// "within noise, counts matched" verdict (#4439).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const iters = Number(process.argv[2]);
  const seedArg = process.argv[3];
  const rand = seedArg !== undefined ? seededRand(Number(seedArg)) : Math.random;
  for (const [first, second] of roundOrder(iters, rand)) {
    console.log(`${first} ${second}`);
  }
}
