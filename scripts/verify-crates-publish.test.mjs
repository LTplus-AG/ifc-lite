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
import { verifyAll } from './verify-crates-publish.js';

const SEVEN_CRATES = [
  'ifc-lite-core',
  'ifc-lite-clash',
  'ifc-lite-geometry',
  'ifc-lite-processing',
  'ifc-lite-export',
  'ifc-lite-ffi',
  'ifc-lite-wasm',
].map((name) => ({ name, version: '6.0.0' }));

test('verifyAll FAILS (reports the missing crates) on the exact v6.0.0 partial-publish shape', async () => {
  // Reproduces the incident from #3180/#3181: 3 of 7 crates reached
  // crates.io, 4 did not.
  const onRegistry = new Set(['ifc-lite-core', 'ifc-lite-geometry', 'ifc-lite-clash']);
  const checkFn = async (name, version) => onRegistry.has(name) && version === '6.0.0';

  const failed = await verifyAll(SEVEN_CRATES, { retries: 1, delay: 0, checkFn, sleepFn: async () => {} });

  assert.deepEqual(
    failed.map((f) => f.name).sort(),
    ['ifc-lite-export', 'ifc-lite-ffi', 'ifc-lite-processing', 'ifc-lite-wasm'].sort()
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
