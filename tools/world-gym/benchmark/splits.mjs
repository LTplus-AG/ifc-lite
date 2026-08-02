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
 * scorer). The reporting split's integrity model is
 * hidden-by-secret-salt-delivered-by-hosting.
 *
 * v1.2 IMPLEMENTS THE SALT HALF (B4.3). `generateModel` now takes a secret that
 * enters every RNG stream, `saltForSplit` below decides which split gets one,
 * and the scorer threads it through ground-truth regeneration. The DELIVERY
 * half is still missing: no hosted scorer exists, so no salt is configured in
 * any deployment and `saltForSplit` returns the unsalted universe everywhere by
 * default. Read that precisely - the mechanism is implemented and measured
 * (scripts/moonshot/b43-benchmark-salt/), the trust model is not yet in force.
 * See BENCHMARK.md section 1a (normative for the claim) and 1b (the salt's
 * lifecycle and rotation); do not restate either here.
 *
 * Bump SPEC_VERSION whenever any of: the constants below, the generator's
 * byte output for any in-universe seed, the task set, or the scoring math
 * changes. Leaderboard rows embed the version; rows from different versions
 * are not comparable.
 */

import { assertSecretSaltFormat, SaltFormatError } from '../lib/salt.mjs';

export const BENCHMARK_NAME = 'ifc-lite-world-gym';
export const SPEC_VERSION = '1.2.0';

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

/**
 * The REPORTING split: the only split a salt may ever apply to.
 *
 * Everything else is deliberately open. `dev` in particular is
 * attackable-by-design - `clean-twin-diff` works on it, will keep working on
 * it, and dev numbers carry no integrity claim - so that a submitter can score
 * themselves locally as often as they like without asking anyone for anything.
 */
export const REPORTING_SPLIT = 'test';

/**
 * Environment variable the reporting split's salt is read from. It is an env
 * var and not a flag because the salt is a deployment secret of the scoring
 * service: it must not be in the repo, in a config file, in argv (where `ps`
 * and every CI log can read it - the CLIs refuse `--salt <value>` outright) or
 * in a shell history.
 */
export const SALT_ENV_VAR = 'WORLD_GYM_SALT_TEST';

/**
 * The salt in force for `split`, or '' for the unsalted (public) universe.
 *
 * Two invariants, both load-bearing:
 *
 * 1. NON-REPORTING SPLITS ARE NEVER SALTED, whatever the environment says. Not
 *    a policy default - a hard return. If salting dev were reachable by setting
 *    a variable, "dev is open" would be a claim about a deployment rather than
 *    about the code, and nobody could check it.
 * 2. THE DEFAULT IS UNSALTED. With no variable set - which is every checkout
 *    and every CI run today - the reporting split is the same public universe
 *    it always was, and the committed anchors stay valid. Configuring the
 *    variable is the deliberate act of standing up a salted universe.
 *
 * 3. A CONFIGURED SALT MUST BE THE DOCUMENTED FORMAT. This is the boundary a
 *    real deployment secret crosses, so it is where the format is enforced:
 *    exactly 64 lowercase hex characters, i.e. 32 CSPRNG bytes. A weak or
 *    hand-chosen salt silently produces a weak split, which looks exactly like
 *    protection and is not - so it is a refusal (`SaltFormatError`), not a
 *    warning. See lib/salt.mjs for the two validation tiers and their reasons.
 *
 * @param {string} split
 * @param {Record<string, string|undefined>} [env]
 * @returns {string} '' (unsalted) or the configured salt
 * @throws {SaltFormatError} if the reporting split's salt is set but malformed
 */
export function saltForSplit(split, env = process.env) {
  if (split !== REPORTING_SPLIT) return '';
  const raw = env[SALT_ENV_VAR];
  // UNSET is the honest public universe and stays legal - that is how the
  // unsalted benchmark runs today. SET BUT BLANK is a misconfiguration wearing
  // the same face: a secret that failed to inject, `export VAR=`, a trimmed-away
  // quote. Left to `assertSecretSaltFormat` both trim to '' and the reporting
  // split would regenerate PUBLIC truth while the operator believed a secret
  // salt was active, which is the whole attack this split exists to stop.
  if (raw !== undefined && raw.trim() === '') {
    throw new SaltFormatError(
      `${SALT_ENV_VAR} is set but empty. The reporting split would score in the PUBLIC universe `
      + 'while looking configured, so this is a refusal. Unset it to run the unsalted benchmark '
      + 'deliberately, or give it a real salt.',
    );
  }
  return assertSecretSaltFormat(raw, SALT_ENV_VAR);
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
