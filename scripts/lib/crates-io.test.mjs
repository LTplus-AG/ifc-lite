#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Covers `waitUntilPublished` — the poll that replaces the false "cargo
 * publish blocks until visible" assumption (#3180). A `sleepFn` stub advances
 * a virtual clock instead of really waiting, so these run in milliseconds
 * while still exercising the real timeout arithmetic.
 *
 * Run: node --test scripts/lib/crates-io.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitUntilPublished, isPublished } from './crates-io.mjs';

/** A fake clock: `sleepFn` advances `now` by `ms` instead of really waiting. */
function fakeClock(start = 0) {
  let now = start;
  const realNow = Date.now;
  Date.now = () => now;
  return {
    sleepFn: async (ms) => {
      now += ms;
    },
    restore: () => {
      Date.now = realNow;
    },
  };
}

test('waitUntilPublished resolves ok:true as soon as the index shows the version', async () => {
  const clock = fakeClock();
  try {
    let calls = 0;
    const checkFn = async () => {
      calls++;
      return calls >= 3; // false, false, true
    };
    const result = await waitUntilPublished('ifc-lite-core', '6.0.0', {
      checkFn,
      intervalMs: 5000,
      timeoutMs: 60000,
      sleepFn: clock.sleepFn,
    });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 3);
    assert.equal(result.waitedMs, 10000); // two sleeps of 5000ms before the hit
  } finally {
    clock.restore();
  }
});

test('waitUntilPublished gives up and reports ok:false once the timeout elapses', async () => {
  const clock = fakeClock();
  try {
    const checkFn = async () => false; // never appears in the index
    const result = await waitUntilPublished('ifc-lite-geometry', '6.0.0', {
      checkFn,
      intervalMs: 5000,
      timeoutMs: 20000,
      sleepFn: clock.sleepFn,
    });
    assert.equal(result.ok, false);
    assert.ok(
      result.waitedMs >= 20000,
      `expected the poll to run for at least the 20000ms timeout, waited only ${result.waitedMs}ms`
    );
  } finally {
    clock.restore();
  }
});

test('waitUntilPublished never sleeps at all if the first check already succeeds', async () => {
  const clock = fakeClock();
  try {
    let sleptFor = null;
    const sleepFn = async (ms) => {
      sleptFor = ms;
    };
    const result = await waitUntilPublished('ifc-lite-clash', '6.0.0', {
      checkFn: async () => true,
      intervalMs: 5000,
      timeoutMs: 60000,
      sleepFn,
    });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 1);
    assert.equal(sleptFor, null, 'should not have slept when the first check already succeeded');
  } finally {
    clock.restore();
  }
});

test('isPublished treats a 404 as "not published" and a non-404 error status as a thrown error', async () => {
  const notFound = { status: 404, ok: false };
  const okBody = { status: 200, ok: true, json: async () => ({}) };
  const errored = { status: 200, ok: true, json: async () => ({ errors: [{ detail: 'nope' }] }) };
  const serverError = { status: 503, ok: false };

  assert.equal(await isPublished('ifc-lite-core', '6.0.0', async () => notFound), false);
  assert.equal(await isPublished('ifc-lite-core', '6.0.0', async () => okBody), true);
  assert.equal(await isPublished('ifc-lite-core', '6.0.0', async () => errored), false);
  await assert.rejects(
    () => isPublished('ifc-lite-core', '6.0.0', async () => serverError),
    /crates\.io returned 503/,
    'a registry outage should surface as a thrown error, not read as "not published" — collapsing the two is exactly the bug verify-npm-publish.js already documents fixing for npm'
  );
});
