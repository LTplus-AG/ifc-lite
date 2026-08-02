/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-split generation SALT for the World Gym Benchmark (B4.3).
 *
 * WHY. The benchmark's model universe is a pure function of the seed, and its
 * splits are seed arithmetic over a public range, so hosting the model bytes
 * withholds nothing: an adversary regenerates both the corrupted model and its
 * CLEAN TWIN locally and diffs them (`benchmark/attacks/clean-twin-diff.mjs`,
 * an exact 1.000 aggregate through the real scorer). The only thing that
 * changes that is a SECRET THAT ENTERS GENERATION. This module is that secret's
 * plumbing: `Rng` takes a salt, every stream in the generation path takes the
 * same salt, and without it neither the twin nor the corrupted model is
 * computable. BENCHMARK.md section 1a is normative; section 1b is the lifecycle
 * and rotation procedure.
 *
 * WHY IT IS NOT JUST A STRING CONCATENATION ONTO THE EXISTING SEED. That was
 * the obvious implementation and it does not work. The unsalted stream is
 * `mulberry32(FNV-1a(key))`: 32 bits of hashed key, 32 bits of state. Whatever
 * you concatenate into the key, the stream the generator actually consumes is
 * one of 2^32 streams, and the served bytes are a cheap oracle for testing a
 * candidate - the drawn parameters show up as dimensions in the file, and the
 * GlobalIds are a literal readout of the `guid:` stream. An attacker who never
 * learns the salt can therefore sweep 2^32 candidate stream states per seed,
 * confirm against the bytes they were served, recover the parameters, rebuild
 * the clean twin exactly and rerun the twin diff. See
 * `scripts/moonshot/b43-benchmark-salt/` for the measured cost of that sweep.
 * So the salted path is KEYED rather than hashed: HMAC-SHA256(salt, streamKey)
 * expanded into a 128-bit sfc32 state (`lib/rng.mjs`). The unsalted path is
 * left byte-for-byte alone, because the whole committed corpus depends on it.
 *
 * WHAT THIS MODULE DOES NOT DO. It does not decide WHICH split is salted (that
 * is `benchmark/splits.mjs#saltForSplit`, and the answer is: the reporting
 * split only - dev stays open and attackable by design), and it does not
 * deliver the salt to submitters. Delivery needs the hosted scorer, which does
 * not exist; the salt is nevertheless a complete and testable mechanism without
 * it, which is what B4.3's exam measures.
 */

import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

/**
 * Minimum accepted salt length. The salt's job is to be unguessable, and a
 * short one is guessable by the same offline oracle that motivates the keyed
 * construction above: candidate salt -> regenerate -> compare to served bytes.
 * 16 chars is the floor; 64 hex chars (32 bytes from a CSPRNG) is the
 * documented production value - see BENCHMARK.md section 1b.
 */
export const MIN_SALT_LENGTH = 16;

/** Domain separation tag; changing it invalidates every existing salted split. */
const KDF_DOMAIN = 'ifc-lite-world-gym/salt/v1';

/**
 * Canonical salt form: `''` means UNSALTED (the public, backward-compatible
 * universe). `null`/`undefined`/`''` all normalize to unsalted; anything else
 * is trimmed and validated.
 *
 * @param {string|null|undefined} salt
 * @returns {string} '' (unsalted) or the validated salt
 */
export function normalizeSalt(salt) {
  if (salt === undefined || salt === null) return '';
  if (typeof salt !== 'string') {
    throw new TypeError(`salt must be a string (got ${typeof salt})`);
  }
  const s = salt.trim();
  if (s === '') return '';
  if (s.length < MIN_SALT_LENGTH) {
    throw new Error(
      `salt is too short (${s.length} chars, minimum ${MIN_SALT_LENGTH}). A guessable salt is no salt: `
      + 'generate one with `node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))"`.',
    );
  }
  return s;
}

/** True when this salt selects the salted (keyed) generation path. */
export function isSalted(salt) {
  return normalizeSalt(salt) !== '';
}

/**
 * PUBLISHABLE IDENTITY of a salt: a truncated HMAC over a fixed label, so a
 * leaderboard row can say WHICH salted universe it was scored in without
 * revealing the salt. Rotation depends on this: after a leak, rows carrying the
 * retired fingerprint are the exact set that has to be re-run or retired
 * (BENCHMARK.md section 1b).
 *
 * Returns `null` for the unsalted universe, which is itself the honest label.
 *
 * @param {string} salt
 * @returns {string|null} e.g. 'salt:9f2c1ab3d4e5f607' or null
 */
export function saltFingerprint(salt) {
  const s = normalizeSalt(salt);
  if (s === '') return null;
  const mac = createHmac('sha256', s).update(`${KDF_DOMAIN}/fingerprint`).digest('hex');
  return `salt:${mac.slice(0, 16)}`;
}

/**
 * Derive a 128-bit stream state (4 uint32 words) for one named RNG stream
 * under one salt. The salt is the HMAC KEY, so the streams of two different
 * salts are unrelated and no amount of observing one salted universe says
 * anything about another.
 *
 * @param {string} salt - a normalized, non-empty salt
 * @param {string|number} streamKey - the public stream name, e.g. '42:corrupt'
 * @returns {[number, number, number, number]}
 */
export function deriveStreamState(salt, streamKey) {
  const digest = createHmac('sha256', salt).update(`${KDF_DOMAIN}/stream/${streamKey}`).digest();
  return [
    digest.readUInt32LE(0),
    digest.readUInt32LE(4),
    digest.readUInt32LE(8),
    digest.readUInt32LE(12),
  ];
}

/**
 * Constant-time comparison of a presented salt against the expected one, for
 * any future code path that accepts a salt from a request. Returns false for
 * the unsalted universe on either side rather than treating '' as a match.
 */
export function saltEquals(a, b) {
  const x = normalizeSalt(a);
  const y = normalizeSalt(b);
  if (x === '' || y === '') return false;
  const bx = Buffer.from(createHash('sha256').update(x).digest());
  const by = Buffer.from(createHash('sha256').update(y).digest());
  return timingSafeEqual(bx, by);
}
