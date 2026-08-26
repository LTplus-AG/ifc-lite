#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Covers `verifyAll` (#3181): the crates.io half of the release must be
 * checked independently of npm — the v6.0.0 incident this issue names had
 * npm 100% complete and 4 of 7 crates missing, and `verify-npm-publish.js`
 * had no way to see that. Simulates a stubbed registry (no real network
 * call), first with a partial publish (must FAIL), then with a complete one
 * (must PASS).
 *
 * Run: node --test scripts/verify-crates-publish.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAll, parseArgs, runMain } from './verify-crates-publish.js';
import { CRATES } from './lib/crates-io.mjs';

// Imported, never hand-copied: a hand-written list is the exact drift the
// shared module exists to prevent — add an eighth crate and a copy would
// still assert on seven and pass.
const ALL_CRATES = CRATES.map((name) => ({ name, version: '6.0.0' }));
const SEVEN_CRATES = ALL_CRATES;

test('the crate list under test is the shipped one', () => {
  assert.ok(CRATES.length >= 7, `expected at least the seven released crates, got ${CRATES.length}`);
  assert.equal(new Set(CRATES).size, CRATES.length, 'CRATES must not contain duplicates');
});

test('verifyAll FAILS (reports the missing crates) on the exact v6.0.0 partial-publish shape', async () => {
  // Reproduces the incident from #3180/#3181: 3 of 7 crates reached
  // crates.io, 4 did not.
  const onRegistry = new Set(['ifc-lite-core', 'ifc-lite-geometry', 'ifc-lite-clash']);
  const checkFn = async (name, version) => onRegistry.has(name) && version === '6.0.0';

  const failed = await verifyAll(SEVEN_CRATES, { retries: 1, delay: 0, checkFn, sleepFn: async () => {} });

  // Derived from CRATES, not hand-listed: an eighth crate must widen this
  // expectation automatically instead of leaving the test asserting on seven.
  assert.deepEqual(
    failed.map((f) => f.name).sort(),
    CRATES.filter((name) => !onRegistry.has(name)).sort()
  );
});

test('verifyAll PASSES with an empty failure list once every crate is on the registry', async () => {
  const onRegistry = new Set(SEVEN_CRATES.map((c) => c.name));
  const checkFn = async (name, version) => onRegistry.has(name) && version === '6.0.0';

  const failed = await verifyAll(SEVEN_CRATES, { retries: 1, delay: 0, checkFn, sleepFn: async () => {} });

  assert.deepEqual(failed, []);
});

test('verifyAll retries a not-yet-propagated crate before giving up', async () => {
  let calls = 0;
  const checkFn = async () => {
    calls++;
    return calls >= 3; // shows up on the 3rd check
  };
  const sleeps = [];
  const failed = await verifyAll([{ name: 'ifc-lite-core', version: '6.0.0' }], {
    retries: 5,
    delay: 10,
    checkFn,
    sleepFn: async (ms) => sleeps.push(ms),
  });

  assert.deepEqual(failed, []);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [10, 10]);
});

// ── main(), parseArgs and the exit code ─────────────────────────────────────
//
// Everything below covers what the CI step named "Check the crates.io publish
// verifier catches a partial publish" previously did NOT: the pure `verifyAll`
// was unit-tested, but `main()`, `parseArgs` and the exit code were not — so
// `if (failed.length > 0)` → `if (false)` survived the whole suite while a
// partial publish exited 0.

test('runMain exits 1 — not 0 — when a crate is missing', async () => {
  const onRegistry = new Set(['ifc-lite-core', 'ifc-lite-geometry', 'ifc-lite-clash']);
  const code = await runMain({
    argv: ['--retries', '1', '--delay', '0'],
    version: '6.0.0',
    checkFn: async (name) => onRegistry.has(name),
    sleepFn: async () => {},
    log: () => {},
    logError: () => {},
  });
  assert.equal(code, 1, 'a partial publish must be a non-zero exit — this is the whole purpose of the script');
});

test('runMain exits 0 on a fully published release', async () => {
  const code = await runMain({
    argv: [],
    version: '6.0.0',
    checkFn: async () => true,
    sleepFn: async () => {},
    log: () => {},
    logError: () => {},
  });
  assert.equal(code, 0);
});

test('runMain exits 2 rather than 0 when there are no crates to verify', async () => {
  // Absence must not read as success: exiting 0 having made zero registry
  // calls would report a release as verified having checked nothing.
  // `scripts/verify-npm-publish.js` uses the same code for the same reason.
  const errors = [];
  let called = 0;
  const code = await runMain({
    argv: [],
    crates: [],
    version: '6.0.0',
    checkFn: async () => {
      called++;
      return true;
    },
    log: () => {},
    logError: (line) => errors.push(line),
  });
  assert.equal(code, 2);
  assert.equal(called, 0, 'nothing should have been checked');
  assert.match(errors.join('\n'), /nothing was verified/);
});

test('runMain exits 2 on an invalid --retries / --delay instead of silently mis-running', async () => {
  for (const argv of [['--retries', 'abc'], ['--delay', 'abc'], ['--retries'], ['--wat', '1']]) {
    let called = 0;
    const code = await runMain({
      argv,
      version: '6.0.0',
      checkFn: async () => {
        called++;
        return true;
      },
      log: () => {},
      logError: () => {},
    });
    assert.equal(code, 2, `expected ${JSON.stringify(argv)} to be rejected`);
    assert.equal(called, 0, `expected ${JSON.stringify(argv)} to abort before touching the registry`);
  }
});

test('parseArgs accepts valid values and rejects every silent-misconfiguration shape', () => {
  assert.deepEqual(parseArgs([]), { retries: 3, delay: 5000 });
  assert.deepEqual(parseArgs(['--retries', '12', '--delay', '20000']), { retries: 12, delay: 20000 });

  // NaN: the loop `attempt <= NaN` never runs, so EVERY crate is reported
  // missing — fail-closed, but pointing at crates.io instead of the typo.
  assert.throws(() => parseArgs(['--retries', 'abc']), /--retries expects a non-negative integer/);
  // NaN: `setTimeout(fn, NaN)` fires immediately, so the retry budget the
  // flag exists to set silently evaporates.
  assert.throws(() => parseArgs(['--delay', 'abc']), /--delay expects a non-negative integer/);
  // Trailing flag: silently ignored by an `argv[i + 1]` truthiness test.
  assert.throws(() => parseArgs(['--delay', '10', '--retries']), /--retries requires a value/);
  assert.throws(() => parseArgs(['--retries', '0']), /at least 1/);
  assert.throws(() => parseArgs(['--retries', '3abc']), /non-negative integer/);
  assert.throws(() => parseArgs(['--typo', '3']), /Unknown argument: --typo/);
});

test('verifyAll survives a throwing checkFn: it retries, and a recovery still verifies', async () => {
  // The retry loop exists for propagation delay. Before this, the first
  // transient error propagated out of verifyAll and surfaced as
  // `Unexpected error:` — reading as a bug in the script, not a blip.
  let calls = 0;
  const checkFn = async () => {
    calls++;
    if (calls < 3) throw new Error('crates.io returned 503 for ifc-lite-core@6.0.0');
    return true;
  };
  const failed = await verifyAll([{ name: 'ifc-lite-core', version: '6.0.0' }], {
    retries: 5,
    delay: 10,
    checkFn,
    sleepFn: async () => {},
  });
  assert.deepEqual(failed, []);
  assert.equal(calls, 3);
});

test('verifyAll fails closed, naming the registry error, when every attempt throws', async () => {
  const checkFn = async () => {
    throw new Error('crates.io returned 503 for ifc-lite-wasm@6.0.0');
  };
  const failed = await verifyAll([{ name: 'ifc-lite-wasm', version: '6.0.0' }], {
    retries: 3,
    delay: 0,
    checkFn,
    sleepFn: async () => {},
  });
  assert.equal(failed.length, 1, 'an unverifiable crate must NOT be reported as verified');
  assert.match(failed[0].error, /503/);
});

test('runMain exits 1 when the registry is unreachable throughout', async () => {
  const code = await runMain({
    argv: ['--retries', '2', '--delay', '0'],
    version: '6.0.0',
    checkFn: async () => {
      throw new Error('fetch failed');
    },
    sleepFn: async () => {},
    log: () => {},
    logError: () => {},
  });
  assert.equal(code, 1, 'an outage must not be reported as a verified release');
});
