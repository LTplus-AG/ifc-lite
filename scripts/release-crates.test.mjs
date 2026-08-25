#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Covers `publishAllCrates` (#3180): a `cargo publish` that reports success
 * locally but whose crate never becomes visible in the crates.io index must
 * FAIL the release, not warn-and-continue the way `cargo publish`'s own
 * internal wait does. Simulates a stuck index with a stub `checkFn` and a
 * fake clock — no real `cargo publish` or network call.
 *
 * Run: node --test scripts/release-crates.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishAllCrates } from './release-crates.mjs';

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

test('publishAllCrates FAILS when a published crate never appears in the index (the #3180 race)', async () => {
  const clock = fakeClock();
  try {
    const published = new Set(); // crates cargo has "published" locally
    const indexed = new Set(); // crates actually visible in the crates.io index

    // ifc-lite-geometry: cargo publish "succeeds" but the index never catches
    // up within the timeout — this is exactly run 32780162744's failure mode.
    const publishFn = (crate) => {
      published.add(crate);
      if (crate !== 'ifc-lite-geometry') indexed.add(crate);
    };
    const checkFn = async (crate, ver) => indexed.has(crate) && ver === '6.0.0';

    await assert.rejects(
      () =>
        publishAllCrates({
          crates: ['ifc-lite-core', 'ifc-lite-geometry', 'ifc-lite-processing'],
          version: '6.0.0',
          publishFn,
          checkFn,
          intervalMs: 5000,
          timeoutMs: 20000,
          sleepFn: clock.sleepFn,
        }),
      /ifc-lite-geometry@6\.0\.0 did not appear in the crates\.io index within 20s/
    );

    // The crate before it in dependency order did complete; the stuck one
    // stopped the run before touching the one after it — no silent skip.
    assert.deepEqual([...published], ['ifc-lite-core', 'ifc-lite-geometry']);
  } finally {
    clock.restore();
  }
});

test('publishAllCrates succeeds end-to-end when every crate appears in the index promptly', async () => {
  const clock = fakeClock();
  try {
    const published = [];
    const indexed = new Set();
    const publishFn = (crate) => {
      published.push(crate);
      indexed.add(crate); // index catches up instantly in this scenario
    };
    const checkFn = async (crate) => indexed.has(crate);

    await publishAllCrates({
      crates: ['ifc-lite-core', 'ifc-lite-geometry', 'ifc-lite-clash'],
      version: '6.0.0',
      publishFn,
      checkFn,
      intervalMs: 5000,
      timeoutMs: 20000,
      sleepFn: clock.sleepFn,
    });

    assert.deepEqual(published, ['ifc-lite-core', 'ifc-lite-geometry', 'ifc-lite-clash']);
  } finally {
    clock.restore();
  }
});

test('publishAllCrates skips a crate already on crates.io without calling publishFn', async () => {
  const clock = fakeClock();
  try {
    const published = [];
    const indexed = new Set(['ifc-lite-core']); // already published before this run starts
    const publishFn = (crate) => {
      published.push(crate);
      indexed.add(crate);
    };
    const checkFn = async (crate) => indexed.has(crate);

    await publishAllCrates({
      crates: ['ifc-lite-core', 'ifc-lite-geometry'],
      version: '6.0.0',
      publishFn,
      checkFn,
      intervalMs: 5000,
      timeoutMs: 20000,
      sleepFn: clock.sleepFn,
    });

    assert.deepEqual(published, ['ifc-lite-geometry'], 'ifc-lite-core was already published and should not be re-published');
  } finally {
    clock.restore();
  }
});
