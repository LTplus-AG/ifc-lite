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
import {
  waitUntilPublished,
  isPublished,
  isArtifactFetchable,
  isFullyPublished,
  isTransientStatus,
  USER_AGENT,
} from './crates-io.mjs';

/** A crates.io version record, in the shape the live API returns it. */
function versionBody({ yanked = false, crate = 'ifc-lite-core', ver = '6.0.0' } = {}) {
  return {
    status: 200,
    ok: true,
    json: async () => ({ version: { num: ver, yanked, dl_path: `/api/v1/crates/${crate}/${ver}/download` } }),
  };
}

/** A `.crate` tarball response with `bytes` bytes of body. */
function artifactBody(bytes = 210109) {
  return { status: 200, ok: true, arrayBuffer: async () => new ArrayBuffer(bytes) };
}

const NO_SLEEP = { sleepFn: async () => {} };

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

test('isPublished treats a 404 as "not published" and a persistent non-404 error status as a thrown error', async () => {
  const notFound = { status: 404, ok: false };
  const errored = { status: 200, ok: true, json: async () => ({ errors: [{ detail: 'nope' }] }) };
  const serverError = { status: 503, ok: false };

  assert.equal(await isPublished('ifc-lite-core', '6.0.0', async () => notFound), false);
  assert.equal(await isPublished('ifc-lite-core', '6.0.0', async () => versionBody()), true);
  assert.equal(await isPublished('ifc-lite-core', '6.0.0', async () => errored), false);
  await assert.rejects(
    () => isPublished('ifc-lite-core', '6.0.0', async () => serverError, NO_SLEEP),
    /crates\.io returned 503/,
    'a registry outage that outlasts the retry budget should surface as a thrown error, not read as "not published" — collapsing the two is exactly the bug verify-npm-publish.js already documents fixing for npm'
  );
});

test('every crates.io request carries a User-Agent — crates.io answers 403 without one', async () => {
  // Measured against the live API on 2026-08-25:
  //   GET /api/v1/crates/ifc-lite-core/6.0.0  no UA -> 403
  //                                          with UA -> 200
  // Deleting the header therefore 403s every call, which is not a 404, so it
  // throws — aborting every release and reddening every verify. Both fetches
  // are asserted: the metadata one and the artifact download.
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, ua: init?.headers?.['User-Agent'] });
    return url.endsWith('/download') ? artifactBody() : versionBody();
  };

  assert.equal(await isFullyPublished('ifc-lite-core', '6.0.0', fetchImpl, NO_SLEEP), true);

  assert.equal(seen.length, 2, 'expected a metadata call and an artifact download');
  for (const { url, ua } of seen) {
    assert.equal(ua, USER_AGENT, `no User-Agent sent to ${url} — crates.io answers 403 without one`);
  }
  // The UA must be a real identifier, not an empty string that would satisfy
  // a bare presence check while still being rejected by crates.io.
  assert.match(USER_AGENT, /ifc-lite/);
});

test('a transient status is retried within a bounded budget, and succeeds when the registry recovers', async () => {
  let calls = 0;
  const sleeps = [];
  const fetchImpl = async () => {
    calls++;
    return calls < 3 ? { status: 503, ok: false } : versionBody();
  };

  const published = await isPublished('ifc-lite-core', '6.0.0', fetchImpl, {
    sleepFn: async (ms) => sleeps.push(ms),
  });

  assert.equal(published, true, 'a 503 that clears should not be reported as "not published"');
  assert.equal(calls, 3);
  assert.equal(sleeps.length, 2, 'expected a backoff between each retry');
});

test('a network-level failure is retried too, and gives up with a bounded number of attempts', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    throw new TypeError('fetch failed');
  };

  await assert.rejects(
    () => isPublished('ifc-lite-core', '6.0.0', fetchImpl, NO_SLEEP),
    /fetch failed/
  );
  assert.equal(calls, 3, 'the retry budget must be bounded — an unreachable registry must not loop forever');
});

test('a 404 is definitive and is NOT retried — the budget is for blips, not for answers', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { status: 404, ok: false };
  };

  assert.equal(await isPublished('ifc-lite-core', '6.0.0', fetchImpl, NO_SLEEP), false);
  assert.equal(calls, 1);
  assert.equal(isTransientStatus(404), false);
  assert.equal(isTransientStatus(403), false);
  assert.equal(isTransientStatus(503), true);
  assert.equal(isTransientStatus(429), true);
});

test('a YANKED version does not count as published', async () => {
  // crates.io cannot unpublish, only yank — so "yanked" is the only way a
  // published crate goes bad, and `!body.errors` was blind to it: the record
  // is still there, errors is still absent, and a yanked release read green.
  const fetchImpl = async () => versionBody({ yanked: true });

  assert.equal(await isPublished('ifc-lite-core', '6.0.0', fetchImpl, NO_SLEEP), false);
  assert.equal(await isFullyPublished('ifc-lite-core', '6.0.0', fetchImpl, NO_SLEEP), false);
});

test('isFullyPublished fetches the artifact itself, and fails when it is missing or empty', async () => {
  // A version RECORD existing and the tarball being downloadable are
  // different facts. #3180 was an incident where a claim of success outlived
  // the artifact, so the record alone is not the check.
  const missingArtifact = async (url) =>
    url.endsWith('/download') ? { status: 404, ok: false } : versionBody();
  const emptyArtifact = async (url) =>
    url.endsWith('/download') ? artifactBody(0) : versionBody();

  assert.equal(await isFullyPublished('ifc-lite-core', '6.0.0', missingArtifact, NO_SLEEP), false);
  assert.equal(await isFullyPublished('ifc-lite-core', '6.0.0', emptyArtifact, NO_SLEEP), false);
  // …and the good direction: record present, not yanked, artifact has bytes.
  const good = async (url) => (url.endsWith('/download') ? artifactBody() : versionBody());
  assert.equal(await isFullyPublished('ifc-lite-core', '6.0.0', good, NO_SLEEP), true);
});

test('isFullyPublished follows the registry-supplied dl_path rather than reconstructing one', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.includes('/download')) return artifactBody();
    return {
      status: 200,
      ok: true,
      json: async () => ({ version: { yanked: false, dl_path: '/api/v1/crates/renamed/9.9.9/download' } }),
    };
  };

  assert.equal(await isFullyPublished('ifc-lite-core', '6.0.0', fetchImpl, NO_SLEEP), true);
  assert.equal(urls[1], 'https://crates.io/api/v1/crates/renamed/9.9.9/download');
});

test('isArtifactFetchable surfaces a persistent non-404 error rather than reading it as "missing"', async () => {
  await assert.rejects(
    () => isArtifactFetchable('ifc-lite-core', '6.0.0', { fetchImpl: async () => ({ status: 500, ok: false }), ...NO_SLEEP }),
    /crates\.io returned 500/
  );
  // 403 is definitive (it is what a missing User-Agent produces) and must not
  // be silently read as "no artifact".
  await assert.rejects(
    () => isArtifactFetchable('ifc-lite-core', '6.0.0', { fetchImpl: async () => ({ status: 403, ok: false }), ...NO_SLEEP }),
    /crates\.io returned 403/
  );
});

test('waitUntilPublished keeps polling through a throwing checkFn instead of aborting the release', async () => {
  // The whole point: a transient error mid-publish used to propagate out of
  // here to process.exit(1) with some crates already on crates.io — the
  // partial-publish state this poll exists to prevent.
  const clock = fakeClock();
  try {
    let calls = 0;
    const checkFn = async () => {
      calls++;
      if (calls < 3) throw new Error('crates.io returned 503 for ifc-lite-clash@6.0.0');
      return true;
    };
    const result = await waitUntilPublished('ifc-lite-clash', '6.0.0', {
      checkFn,
      intervalMs: 5000,
      timeoutMs: 60000,
      sleepFn: clock.sleepFn,
    });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 3);
    assert.equal(result.lastError, null, 'a recovered error must not be reported alongside a success');
  } finally {
    clock.restore();
  }
});

test('waitUntilPublished still fails closed, and names the registry error, when the outage outlasts the timeout', async () => {
  const clock = fakeClock();
  try {
    const checkFn = async () => {
      throw new Error('crates.io returned 503 for ifc-lite-geometry@6.0.0');
    };
    const result = await waitUntilPublished('ifc-lite-geometry', '6.0.0', {
      checkFn,
      intervalMs: 5000,
      timeoutMs: 20000,
      sleepFn: clock.sleepFn,
    });
    assert.equal(result.ok, false, 'a permanently erroring registry must NOT read as published');
    assert.match(result.lastError.message, /503/);
  } finally {
    clock.restore();
  }
});
