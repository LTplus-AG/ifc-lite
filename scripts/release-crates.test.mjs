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

test('a transient crates.io error mid-list does NOT abort the release into a partial publish', async () => {
  // The exact shape that used to break it: `isPublished` threw on any
  // non-404 non-ok status and `waitUntilPublished` had no try/catch, so one
  // 503 while polling the SECOND crate propagated to process.exit(1) with
  // the first crate already on crates.io — producing the partial-publish
  // state this script exists to prevent. Reproduced by a checkFn that
  // throws once during the poll and then recovers.
  const clock = fakeClock();
  try {
    const published = [];
    const indexed = new Set();
    let blipsLeft = 2;
    const publishFn = (crate) => {
      published.push(crate);
      indexed.add(crate);
    };
    const checkFn = async (crate) => {
      if (crate === 'ifc-lite-geometry' && blipsLeft > 0) {
        blipsLeft--;
        throw new Error('crates.io returned 503 for ifc-lite-geometry@6.0.0');
      }
      return indexed.has(crate);
    };

    await publishAllCrates({
      crates: ['ifc-lite-core', 'ifc-lite-geometry', 'ifc-lite-clash'],
      version: '6.0.0',
      publishFn,
      checkFn,
      intervalMs: 5000,
      timeoutMs: 60000,
      sleepFn: clock.sleepFn,
    });

    assert.deepEqual(
      published,
      ['ifc-lite-core', 'ifc-lite-geometry', 'ifc-lite-clash'],
      'a blip must not leave the release stopped part-way down the list'
    );
  } finally {
    clock.restore();
  }
});

test('a crates.io outage that outlasts the timeout still FAILS the release, and names the error', async () => {
  // The other direction of the same rule: swallowing errors must not turn a
  // dead registry into a green release.
  const clock = fakeClock();
  try {
    const checkFn = async () => {
      throw new Error('crates.io returned 503 for ifc-lite-core@6.0.0');
    };

    await assert.rejects(
      () =>
        publishAllCrates({
          crates: ['ifc-lite-core'],
          version: '6.0.0',
          publishFn: () => {},
          checkFn,
          intervalMs: 5000,
          timeoutMs: 20000,
          sleepFn: clock.sleepFn,
        }),
      /did not appear in the crates\.io index[\s\S]*Last error from crates\.io: crates\.io returned 503/
    );
  } finally {
    clock.restore();
  }
});
