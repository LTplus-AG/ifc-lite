#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Verifies that every crate in `scripts/lib/crates-io.mjs`'s `CRATES` list is
 * published on crates.io at the workspace version, is NOT yanked, is visible
 * in the sparse index that `cargo` resolves against (which lags the API —
 * see `isInSparseIndex`), and has a downloadable `.crate` artifact. Run this
 * after a release
 * to catch a partial crates.io publish that `verify-npm-publish.js` cannot
 * see — npm and crates.io are two independent registries (`release-all.mjs`),
 * and npm completing tells you nothing about crates.io (#3181: the v6.0.0
 * release published all 34 npm packages while only 3 of 7 crates reached
 * crates.io, and the npm-only verifier reported nothing wrong).
 *
 * Usage:
 *   node scripts/verify-crates-publish.js
 *   node scripts/verify-crates-publish.js --retries 5 --delay 10000
 *
 * Options:
 *   --retries <n>   Number of retry attempts per crate (default: 3).
 *                    Useful right after a fresh publish while the index is
 *                    still propagating.
 *   --delay <ms>    Milliseconds to wait between retries (default: 5000).
 *
 * Exit codes: 0 all crates verified, 1 at least one crate missing/yanked/
 * unverifiable, 2 bad arguments or nothing to verify.
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { CRATES, readWorkspaceVersion, isFullyPublished, sleep } from './lib/crates-io.mjs';
import { isMainEntry } from './lib/is-main-entry.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Parse `--retries` / `--delay`, THROWING on anything that is not a positive
 * integer.
 *
 * The unvalidated version turned every typo into a silent misconfiguration
 * rather than an error: `--retries abc` gave `NaN`, so `attempt <= retries`
 * was false on the first iteration, the loop never ran, and every crate was
 * reported missing from crates.io — fail-closed, but pointing the reader at
 * the registry instead of at their own command line. `--delay abc` gave
 * `setTimeout(fn, NaN)`, which fires immediately, so the retry budget the
 * flag exists to set evaporated while still printing "waiting 5s". And
 * `--retries` as the final argument was skipped in silence by the
 * `argv[i + 1]` truthiness test, quietly keeping the default.
 */
export function parseArgs(argv) {
  const parsed = { retries: 3, delay: 5000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg !== '--retries' && arg !== '--delay') {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const key = arg === '--retries' ? 'retries' : 'delay';
    if (i + 1 >= argv.length) {
      throw new Error(`${arg} requires a value`);
    }
    const raw = argv[++i];
    // `parseInt` alone accepts '12abc' and returns 12; a whole-string match
    // is what makes this a validation rather than a coercion.
    if (!/^\d+$/.test(raw)) {
      throw new Error(`${arg} expects a non-negative integer, got: ${raw}`);
    }
    parsed[key] = Number(raw);
  }
  if (parsed.retries < 1) {
    throw new Error(`--retries must be at least 1, got: ${parsed.retries}`);
  }
  return parsed;
}

/**
 * Checks every `{ name, version }` in `toCheck` against `checkFn`, retrying
 * up to `retries` times with `delay` between attempts. Returns the list that
 * never came back published. Pure of `process.exit`/console noise so tests
 * can drive it with a stub registry and a fake clock.
 */
export async function verifyAll(toCheck, { retries = 3, delay = 5000, checkFn = isFullyPublished, sleepFn = sleep, log = () => {} } = {}) {
  const failed = [];
  for (const { name, version } of toCheck) {
    let published = false;
    let lastError = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        published = await checkFn(name, version);
        lastError = null;
      } catch (err) {
        // A registry error is one failed LOOK, not a verdict. Letting it
        // propagate made the retry budget theatre: the loop exists for
        // propagation delay, and the first transient error ended it and
        // surfaced as `Unexpected error:` — which reads as a bug in this
        // script rather than a blip at crates.io.
        published = false;
        lastError = err;
        log(`  ⚠️   ${name}@${version} — crates.io error on attempt ${attempt}/${retries}: ${err.message}`);
      }
      if (published) break;
      if (attempt < retries) {
        log(`  ⏳  ${name}@${version} not yet visible — waiting ${delay / 1000}s (attempt ${attempt}/${retries})…`);
        await sleepFn(delay);
      }
    }
    if (published) {
      log(`  ✅  ${name}@${version}`);
    } else if (lastError) {
      log(`  ❌  ${name}@${version} — could not be verified (${lastError.message})`);
      failed.push({ name, version, error: lastError.message });
    } else {
      log(`  ❌  ${name}@${version} — NOT found on crates.io`);
      failed.push({ name, version });
    }
  }
  return failed;
}

/**
 * The whole command, minus the process plumbing: returns the exit code
 * instead of calling `process.exit`, so the exit contract — 2 for "verified
 * nothing", 1 for "a crate is missing", 0 for "all good" — is reachable from
 * a test. Before this split, `main()`, `parseArgs` and the exit code were
 * untested and `if (failed.length > 0) → if (false)` survived the suite.
 */
export async function runMain({
  argv = [],
  crates = CRATES,
  version,
  checkFn = isFullyPublished,
  sleepFn = sleep,
  log = console.log,
  logError = console.error,
} = {}) {
  let retries;
  let delay;
  try {
    ({ retries, delay } = parseArgs(argv));
  } catch (err) {
    logError(`${err.message}\n`);
    logError('Usage: node scripts/verify-crates-publish.js [--retries <n>] [--delay <ms>]');
    return 2;
  }

  const ver = version ?? readWorkspaceVersion(rootDir);
  const toCheck = crates.map((name) => ({ name, version: ver }));

  // Distinct from "every crate is published": an empty list means the crate
  // list itself failed to arrive, and exiting 0 there would report a release
  // as verified having made zero registry calls — the same
  // absence-reads-as-success shape this script exists to catch, one level up.
  // `scripts/verify-npm-publish.js` guards the same way, with the same
  // exit code.
  if (toCheck.length === 0) {
    logError('No crates to verify — the crate list is empty, so nothing was verified.');
    return 2;
  }

  log(`\nVerifying ${toCheck.length} crate(s) on crates.io (up to ${retries} retries each)…\n`);

  const failed = await verifyAll(toCheck, { retries, delay, checkFn, sleepFn, log });

  log('');

  if (failed.length > 0) {
    logError(`${failed.length} crate(s) missing from crates.io after publish:\n`);
    for (const entry of failed) {
      logError(`  • ${entry.name}@${entry.version}${entry.error ? ` (${entry.error})` : ''}`);
    }
    logError(
      '\nThis means `release:crates` failed partway through (see the release job\n' +
      'logs), a version was yanked, or the index has not propagated yet.\n' +
      'Re-running `pnpm release:crates` is safe — it skips crates already\n' +
      'published and only publishes what is missing.\n'
    );
    return 1;
  }

  log('All crates are published. 🎉');
  return 0;
}

if (isMainEntry(import.meta.url)) {
  runMain({ argv: process.argv.slice(2) })
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('Unexpected error:', err);
      process.exit(1);
    });
}
