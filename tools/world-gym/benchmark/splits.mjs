/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * World Gym Benchmark - versioned split arithmetic (see BENCHMARK.md).
 *
 * Everything about the benchmark's model universe is a pure function of the
 * seed plus the constants in this file. There is no seed list to download:
 * splits are DEFINED by seed arithmetic (`seed % 10`), and every model plus
 * its full ground truth is regenerable from its seed via
 * `../generator.mjs#generateModel(seed, 'auto', { corruptRate: CORRUPT_RATE })`.
 * That is a deliberate design decision: test-split labels are never
 * distributed as data, because distributing them is pointless when anyone
 * with this repo can regenerate them.
 *
 * v1.1 WITHDREW the "hidden-by-hosting" integrity story this file used to
 * assert. It was false, and the two lines above are the reason: if splits are
 * defined by arithmetic over a public seed universe and the generator takes no
 * secret, then hosting the bytes withholds nothing -- the attacker regenerates
 * both the corrupted model and its clean twin locally and diffs them
 * (`attacks/clean-twin-diff.mjs`, an exact 1.000 aggregate through the real
 * scorer). The reporting split's integrity model is now
 * hidden-by-secret-salt-delivered-by-hosting, and NEITHER HALF IS IMPLEMENTED:
 * until the scoring service exists, test carries no integrity property at all
 * and its rows are self-reported. See BENCHMARK.md section 1a, which is
 * normative for this; do not restate the claim here.
 *
 * Bump SPEC_VERSION whenever any of: the constants below, the generator's
 * byte output for any in-universe seed, the task set, or the scoring math
 * changes. Leaderboard rows embed the version; rows from different versions
 * are not comparable.
 */

export const BENCHMARK_NAME = 'ifc-lite-world-gym';
export const SPEC_VERSION = '1.1.0';

/** Seed universe: the benchmark is exactly seeds 0..UNIVERSE_SIZE-1. */
export const UNIVERSE_SIZE = 10_000;

/**
 * Fraction of seeds carrying planted defects. The Bernoulli draw is made
 * per-seed on the `{seed}:corrupt` RNG stream inside the generator, so
 * membership in the corrupted class is itself a pure function of the seed.
 */
export const CORRUPT_RATE = 0.3;

/** Family selection is left to the seed (the generator's 'auto' mode). */
export const FAMILY = 'auto';

/**
 * Split rule (the execution plan's "seed % 10" held-out suggestion):
 *   train: seed % 10 in 0..7   (8,000 seeds)
 *   dev:   seed % 10 == 8      (1,000 seeds)
 *   test:  seed % 10 == 9      (1,000 seeds)
 */
export const SPLIT_NAMES = ['train', 'dev', 'test'];

export function splitOf(seed) {
  if (!Number.isInteger(seed) || seed < 0 || seed >= UNIVERSE_SIZE) return null;
  const r = seed % 10;
  return r <= 7 ? 'train' : r === 8 ? 'dev' : 'test';
}

/** All seeds of one split, ascending. */
export function seedsForSplit(split) {
  if (!SPLIT_NAMES.includes(split)) {
    throw new Error(`Unknown split "${split}" (known: ${SPLIT_NAMES.join(', ')})`);
  }
  const seeds = [];
  for (let seed = 0; seed < UNIVERSE_SIZE; seed++) {
    if (splitOf(seed) === split) seeds.push(seed);
  }
  return seeds;
}

/** The three benchmark tasks, in canonical order. */
export const TASK_NAMES = ['defect-detection', 'quantity-estimation', 'validity-triage'];

/** Defect types a defect-detection submission must give a verdict for. */
export const DEFECT_TYPES = [
  'clash-pair',
  'degenerate-geometry',
  'duplicate-globalid',
  'missing-site',
  'multiple-project',
  'dangling-ref',
  'missing-quantities',
];

/** Quantity keys a quantity-estimation submission must predict (metric units: m3 / m2). */
export const QUANTITY_KEYS = [
  'wallGrossVolume',
  'slabGrossVolume',
  'columnGrossVolume',
  'beamGrossVolume',
  'roomNetFloorArea',
];
