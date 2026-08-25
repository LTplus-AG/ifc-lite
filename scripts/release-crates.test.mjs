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
    const indexCheckFn = async (crate, ver) => indexed.has(crate) && ver === '6.0.0';

    await assert.rejects(
      () =>
        publishAllCrates({
          crates: ['ifc-lite-core', 'ifc-lite-geometry', 'ifc-lite-processing'],
          version: '6.0.0',
          publishFn,
          preCheckFn: async () => false,
          indexCheckFn,
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
    const indexCheckFn = async (crate) => indexed.has(crate);

    await publishAllCrates({
      crates: ['ifc-lite-core', 'ifc-lite-geometry', 'ifc-lite-clash'],
      version: '6.0.0',
      publishFn,
      preCheckFn: async () => false,
      indexCheckFn,
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
    // The pre-check (API record) and the index agree here: core was
    // published long enough ago that both see it.
    const preCheckFn = async (crate) => indexed.has(crate);
    const indexCheckFn = async (crate) => indexed.has(crate);

    await publishAllCrates({
      crates: ['ifc-lite-core', 'ifc-lite-geometry'],
      version: '6.0.0',
      publishFn,
      preCheckFn,
      indexCheckFn,
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
  // non-404 non-ok status and `waitUntilInIndex` had no try/catch, so one
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
    const indexCheckFn = async (crate) => {
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
      preCheckFn: async () => false,
      indexCheckFn,
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
    const indexCheckFn = async () => {
      throw new Error('crates.io returned 503 for ifc-lite-core@6.0.0');
    };

    await assert.rejects(
      () =>
        publishAllCrates({
          crates: ['ifc-lite-core'],
          version: '6.0.0',
          publishFn: () => {},
          preCheckFn: async () => false,
          indexCheckFn,
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

test('the API reporting a version does NOT satisfy the poll while the index lags (the v6.0.1 race)', async () => {
  // Run 32867366010: `ifc-lite-core`'s upload succeeded — which writes the
  // API record — while the index cargo resolves against lagged over a
  // minute, and `ifc-lite-geometry` failed on `ifc-lite-core = ^6.0.1`.
  // A poll wired to the API record (the pre-check) instead of the index
  // returns true inside exactly that window and lets geometry race ahead;
  // this test fails under that wiring.
  const clock = fakeClock();
  try {
    const published = [];
    const apiVisible = new Set(); // what the publish request writes, immediately
    const publishFn = (crate) => {
      published.push(crate);
      apiVisible.add(crate); // the upload's DB write — the API sees it at once
      // …but the index never catches up for anything in this scenario.
    };
    const preCheckFn = async (crate) => apiVisible.has(crate);
    const indexCheckFn = async () => false;

    await assert.rejects(
      () =>
        publishAllCrates({
          crates: ['ifc-lite-core', 'ifc-lite-clash', 'ifc-lite-geometry'],
          version: '6.0.1',
          publishFn,
          preCheckFn,
          indexCheckFn,
          intervalMs: 5000,
          timeoutMs: 20000,
          sleepFn: clock.sleepFn,
        }),
      /ifc-lite-core@6\.0\.1 did not appear in the crates\.io index/
    );

    assert.deepEqual(
      published,
      ['ifc-lite-core'],
      'the release must stop at the index-stuck crate, not publish past it on the API record'
    );
  } finally {
    clock.restore();
  }
});

test('a crate SKIPPED as already-published still gates the next crate on its index visibility', async () => {
  // The resume shape: a re-run shortly after a failure sees the stuck crate
  // "already published" via the API record. Skipping straight past it while
  // its index entry is still absent re-creates the original failure at its
  // first dependent — the skip path must poll the index too.
  const clock = fakeClock();
  try {
    const published = [];
    const preCheckFn = async (crate) => crate === 'ifc-lite-core'; // API has it
    const indexCheckFn = async () => false; // the index still does not

    await assert.rejects(
      () =>
        publishAllCrates({
          crates: ['ifc-lite-core', 'ifc-lite-geometry'],
          version: '6.0.1',
          publishFn: (crate) => published.push(crate),
          preCheckFn,
          indexCheckFn,
          intervalMs: 5000,
          timeoutMs: 20000,
          sleepFn: clock.sleepFn,
        }),
      /ifc-lite-core@6\.0\.1 did not appear in the crates\.io index/
    );

    assert.deepEqual(published, [], 'neither crate may be published: core is up already, geometry cannot resolve it yet');
  } finally {
    clock.restore();
  }
});

test('the DEFAULT wiring polls the sparse index and pre-checks the API — not one endpoint twice', async () => {
  // Every other test in this file injects BOTH `preCheckFn` and
  // `indexCheckFn`, so none of them observes the wiring a real release runs.
  // That left the v6.0.1 defect itself unpinned: putting the `indexCheckFn`
  // default back to `isPublished` — the exact regression this file exists to
  // prevent — keeps every other test here green. This one drives the real
  // defaults through a stubbed global `fetch` and asserts on the URLs they
  // reach, so the two endpoints cannot be collapsed into one again.
  const clock = fakeClock();
  const realFetch = globalThis.fetch;
  const urls = [];
  try {
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      if (String(url).startsWith('https://index.crates.io/')) {
        const line = JSON.stringify({ name: 'ifc-lite-core', vers: '6.0.1', yanked: false });
        return new Response(`${line}\n`, { status: 200 });
      }
      // The API record says "not uploaded yet", so the publish runs.
      return new Response('{"errors":[{"detail":"Not Found"}]}', { status: 404 });
    };

    const published = [];
    await publishAllCrates({
      crates: ['ifc-lite-core'],
      version: '6.0.1',
      publishFn: (crate) => published.push(crate),
      intervalMs: 5000,
      timeoutMs: 20000,
      sleepFn: clock.sleepFn,
    });

    assert.deepEqual(published, ['ifc-lite-core']);
    assert.ok(
      urls.includes('https://crates.io/api/v1/crates/ifc-lite-core/6.0.1'),
      `the pre-check must read the API version record; saw ${JSON.stringify(urls)}`
    );
    assert.ok(
      urls.includes('https://index.crates.io/if/c-/ifc-lite-core'),
      `the poll must read the sparse index cargo resolves from; saw ${JSON.stringify(urls)}`
    );
  } finally {
    globalThis.fetch = realFetch;
    clock.restore();
  }
});
