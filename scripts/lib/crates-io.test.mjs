#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Covers `waitUntilInIndex` — the poll that replaces the false "cargo
 * publish blocks until visible" assumption (#3180). A `sleepFn` stub advances
 * a virtual clock instead of really waiting, so these run in milliseconds
 * while still exercising the real timeout arithmetic.
 *
 * Run: node --test scripts/lib/crates-io.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  waitUntilInIndex,
  isPublished,
  isArtifactFetchable,
  isFullyPublished,
  isInSparseIndex,
  sparseIndexPath,
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

const isIndexUrl = (url) => url.startsWith('https://index.crates.io/');

/** A sparse-index file: one JSON line per version, newest last. */
function indexBody(entries = [{ vers: '6.0.0', yanked: false }]) {
  return {
    status: 200,
    ok: true,
    text: async () => entries.map((e) => JSON.stringify({ name: 'ifc-lite-core', ...e })).join('\n') + '\n',
  };
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

test('waitUntilInIndex resolves ok:true as soon as the index shows the version', async () => {
  const clock = fakeClock();
  try {
    let calls = 0;
    const checkFn = async () => {
      calls++;
      return calls >= 3; // false, false, true
    };
    const result = await waitUntilInIndex('ifc-lite-core', '6.0.0', {
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

test('waitUntilInIndex gives up and reports ok:false once the timeout elapses', async () => {
  const clock = fakeClock();
  try {
    const checkFn = async () => false; // never appears in the index
    const result = await waitUntilInIndex('ifc-lite-geometry', '6.0.0', {
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

test('waitUntilInIndex never sleeps at all if the first check already succeeds', async () => {
  const clock = fakeClock();
  try {
    let sleptFor = null;
    const sleepFn = async (ms) => {
      sleptFor = ms;
    };
    const result = await waitUntilInIndex('ifc-lite-clash', '6.0.0', {
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
  // throws — aborting every release and reddening every verify. All three
  // fetches are asserted: the metadata one, the sparse-index one, and the
  // artifact download.
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, ua: init?.headers?.['User-Agent'] });
    if (isIndexUrl(url)) return indexBody();
    return url.endsWith('/download') ? artifactBody() : versionBody();
  };

  assert.equal(await isFullyPublished('ifc-lite-core', '6.0.0', fetchImpl, NO_SLEEP), true);

  assert.equal(seen.length, 3, 'expected a metadata call, an index read, and an artifact download');
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
    isIndexUrl(url) ? indexBody() : url.endsWith('/download') ? { status: 404, ok: false } : versionBody();
  const emptyArtifact = async (url) =>
    isIndexUrl(url) ? indexBody() : url.endsWith('/download') ? artifactBody(0) : versionBody();

  assert.equal(await isFullyPublished('ifc-lite-core', '6.0.0', missingArtifact, NO_SLEEP), false);
  assert.equal(await isFullyPublished('ifc-lite-core', '6.0.0', emptyArtifact, NO_SLEEP), false);
  // …and the good direction: record present, not yanked, artifact has bytes.
  const good = async (url) =>
    isIndexUrl(url) ? indexBody() : url.endsWith('/download') ? artifactBody() : versionBody();
  assert.equal(await isFullyPublished('ifc-lite-core', '6.0.0', good, NO_SLEEP), true);
});

test('isFullyPublished follows the registry-supplied dl_path rather than reconstructing one', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (isIndexUrl(url)) return indexBody();
    if (url.includes('/download')) return artifactBody();
    return {
      status: 200,
      ok: true,
      json: async () => ({ version: { yanked: false, dl_path: '/api/v1/crates/renamed/9.9.9/download' } }),
    };
  };

  assert.equal(await isFullyPublished('ifc-lite-core', '6.0.0', fetchImpl, NO_SLEEP), true);
  assert.equal(urls.at(-1), 'https://crates.io/api/v1/crates/renamed/9.9.9/download');
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

test('waitUntilInIndex keeps polling through a throwing checkFn instead of aborting the release', async () => {
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
    const result = await waitUntilInIndex('ifc-lite-clash', '6.0.0', {
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

test('waitUntilInIndex still fails closed, and names the registry error, when the outage outlasts the timeout', async () => {
  const clock = fakeClock();
  try {
    const checkFn = async () => {
      throw new Error('crates.io returned 503 for ifc-lite-geometry@6.0.0');
    };
    const result = await waitUntilInIndex('ifc-lite-geometry', '6.0.0', {
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


test('waitUntilInIndex does not report a RECOVERED error on a timeout the registry answered', async () => {
  // The distinction the failure message draws — "the index never caught up"
  // vs "crates.io was erroring the whole time" — only holds if a recovered
  // error is cleared. Here the registry errors once, then answers cleanly for
  // the rest of the budget with "not there": the crate genuinely never
  // appeared, and reporting the stale 503 alongside would send the operator
  // hunting an outage that ended on the first attempt.
  //
  // Deleting the `lastError = null;` in the poll's success path leaves every
  // other case in this file green and breaks only this one.
  const clock = fakeClock();
  try {
    let calls = 0;
    const checkFn = async () => {
      calls++;
      if (calls === 1) throw new Error('crates.io returned 503 for ifc-lite-core@6.0.0');
      return false;
    };
    const result = await waitUntilInIndex('ifc-lite-core', '6.0.0', {
      checkFn,
      intervalMs: 5000,
      timeoutMs: 20000,
      sleepFn: clock.sleepFn,
    });
    assert.equal(result.ok, false);
    assert.ok(calls > 2, 'the poll must keep looking after the error');
    assert.equal(result.lastError, null, 'an error the poll recovered from is not why this timed out');
  } finally {
    clock.restore();
  }
});

test('sparseIndexPath follows the registry index layout for every name-length bucket', () => {
  // https://doc.rust-lang.org/cargo/reference/registry-index.html — getting
  // any bucket wrong 404s the poll forever, which after the fail-closed
  // change means every release times out rather than racing.
  assert.equal(sparseIndexPath('a'), '1/a');
  assert.equal(sparseIndexPath('ab'), '2/ab');
  assert.equal(sparseIndexPath('abc'), '3/a/abc');
  assert.equal(sparseIndexPath('ifc-lite-core'), 'if/c-/ifc-lite-core');
  assert.equal(sparseIndexPath('ifc-lite-wasm'), 'if/c-/ifc-lite-wasm');
  // Index paths are lowercase even though crates.io accepts mixed-case names.
  assert.equal(sparseIndexPath('Serde'), 'se/rd/serde');
});

test('isInSparseIndex reads index.crates.io — the URL cargo resolves from — not the API', async () => {
  // The v6.0.1 incident is the API and the index disagreeing, so WHICH host
  // this reads is the whole point: wiring it back to crates.io/api would make
  // the poll green inside exactly the window it exists to observe.
  const urls = [];
  const fetchImpl = async (url, init) => {
    urls.push({ url, ua: init?.headers?.['User-Agent'] });
    return indexBody([{ vers: '6.0.1', yanked: false }]);
  };

  assert.equal(await isInSparseIndex('ifc-lite-core', '6.0.1', fetchImpl), true);
  assert.equal(urls.length, 1);
  assert.equal(urls[0].url, 'https://index.crates.io/if/c-/ifc-lite-core');
  assert.equal(urls[0].ua, USER_AGENT, 'the index request must carry the User-Agent too');
});

test('isInSparseIndex answers false for a version the index file does not carry yet', async () => {
  // The exact v6.0.1 state: the file exists (6.0.0 is in it), the fresh
  // version is not there yet.
  const fetchImpl = async () => indexBody([{ vers: '6.0.0', yanked: false }]);
  assert.equal(await isInSparseIndex('ifc-lite-core', '6.0.1', fetchImpl), false);
});

test('isInSparseIndex answers false for a missing index file and for a yanked entry', async () => {
  // 404 = the crate has never been published at all (first publish of a new
  // crate): "not visible yet", not an error.
  assert.equal(await isInSparseIndex('ifc-lite-core', '6.0.1', async () => ({ status: 404, ok: false })), false);
  // A yanked entry is present in the file but cargo will not resolve it.
  const yanked = async () => indexBody([{ vers: '6.0.1', yanked: true }]);
  assert.equal(await isInSparseIndex('ifc-lite-core', '6.0.1', yanked), false);
});

test('isInSparseIndex fails loudly on a persistent error status and on a corrupt index file', async () => {
  // 403 on purpose, NOT 503. A transient status is retried and rethrown by
  // `cratesIoGet` before this function's own `!res.ok` branch is ever reached,
  // so asserting on 503 left that branch dead: replacing its `throw` with
  // `return false` kept all tests green. Any non-404 non-transient status works;
  // 403 is the shape of an auth/permission refusal, and reading one as "not in
  // the index" would time the release out while blaming propagation.
  //
  // Note the index host does NOT require a User-Agent: measured, a suppressed
  // UA gets 200 from index.crates.io and 403 from crates.io/api. The UA rule is
  // the API host's.
  await assert.rejects(
    () => isInSparseIndex('ifc-lite-core', '6.0.1', async () => ({ status: 403, ok: false }), NO_SLEEP),
    /crates\.io index returned 403 for ifc-lite-core/
  );
  const corrupt = async () => ({ status: 200, ok: true, text: async () => '{"vers": not json\n' });
  await assert.rejects(
    () => isInSparseIndex('ifc-lite-core', '6.0.1', corrupt),
    /unparseable index line for ifc-lite-core/
  );
});

test('isFullyPublished is false while the version is API-visible but absent from the index', async () => {
  // The v6.0.1 window as the VERIFIER would have seen it: record present and
  // not yanked, artifact downloadable — and the index cargo resolves from
  // still without the version. A verifier that goes green here certifies a
  // release no `cargo add` can reach; deleting the index clause from
  // isFullyPublished fails exactly this test.
  const fetchImpl = async (url) => {
    if (isIndexUrl(url)) return indexBody([{ vers: '6.0.0', yanked: false }]); // stale
    return url.endsWith('/download') ? artifactBody() : versionBody({ ver: '6.0.1' });
  };
  assert.equal(await isFullyPublished('ifc-lite-core', '6.0.1', fetchImpl, NO_SLEEP), false);
});
