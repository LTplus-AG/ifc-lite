/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared CLI-flag parsing for the world-gym ops scripts. The point is to
 * fail FAST on typos: a bare `Number(getFlag(...))` turns `--seeds=20x`
 * into `NaN`, which silently produces a successful no-op run (NaN loop
 * bounds, NaN modulo filters) instead of an error.
 */

/** Positional `--name value` lookup. Returns undefined when absent. */
export function getFlag(args, name) {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  const value = args[idx + 1];
  // A following token that is itself a flag means the value is missing
  // (`--seed --out x` must not silently use '--out' as the seed).
  if (typeof value === 'string' && value.startsWith('--')) return undefined;
  return value;
}

/**
 * Validated numeric flag. Exits with a clear message on anything that is
 * not a finite number (or violates min/max/integer constraints).
 *
 * @param {string[]} args
 * @param {string} name flag name including dashes, e.g. '--count'
 * @param {{ def?: number, min?: number, max?: number, integer?: boolean }} [opts]
 */
export function numberFlag(args, name, opts = {}) {
  const raw = getFlag(args, name);
  if (raw === undefined) {
    if (opts.def !== undefined) return opts.def;
    console.error(`error: ${name} is required`);
    process.exit(2);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.error(`error: ${name} expects a number, got ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  if (opts.integer && !Number.isInteger(n)) {
    console.error(`error: ${name} expects an integer, got ${raw}`);
    process.exit(2);
  }
  if (opts.min !== undefined && n < opts.min) {
    console.error(`error: ${name} must be >= ${opts.min}, got ${raw}`);
    process.exit(2);
  }
  if (opts.max !== undefined && n > opts.max) {
    console.error(`error: ${name} must be <= ${opts.max}, got ${raw}`);
    process.exit(2);
  }
  return n;
}

/**
 * Benchmark seed flag: a non-negative integer, or (for ad-hoc local runs)
 * any non-flag string. Exits when the flag is missing/empty.
 */
export function seedFlag(args, name = '--seed') {
  const raw = getFlag(args, name);
  if (raw === undefined || raw.length === 0) {
    console.error(`error: ${name} <seed> is required`);
    process.exit(2);
  }
  const n = Number(raw);
  if (Number.isFinite(n)) {
    if (!Number.isInteger(n) || n < 0) {
      console.error(`error: numeric ${name} must be a non-negative integer, got ${raw}`);
      process.exit(2);
    }
    return n;
  }
  return raw;
}
