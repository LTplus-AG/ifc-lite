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
import { publishAllCrates, parseTokenMintedAtMs } from './release-crates.mjs';

function fakeClock(start = 0) {
  let now = start;
  const realNow = Date.now;
  Date.now = () => now;
  return {
    advance: (ms) => {
      now += ms;
    },
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

test('the budget charges cargo publish too, not only the index waits', async () => {
  // The constant is PUBLISH_PHASE_BUDGET_MS and the comment says it covers the
  // seven `cargo publish` invocations, which run full verification builds. No
  // test charged anything but index waits, so that claim was unverified: an
  // implementation accumulating only `waitedMs` passed the whole file.
  //
  // Here `publishFn` advances the clock. With a 500s budget and a 400s publish,
  // only 100s of waiting may remain; charging index waits alone would allow the
  // full 660s cap.
  const clock = fakeClock();
  try {
    await assert.rejects(
      () =>
        publishAllCrates({
          crates: ['ifc-lite-core'],
          version: '6.0.0',
          publishFn: () => clock.advance(400_000),
          preCheckFn: async () => false,
          indexCheckFn: async () => false,
          intervalMs: 5000,
          timeoutMs: 660_000,
          totalBudgetMs: 500_000,
          sleepFn: clock.sleepFn,
        }),
      /within 100s[\s\S]*remainder of the 500s release-wide budget/
    );
  } finally {
    clock.restore();
  }
});

test('the index wait is bounded by ONE release-wide budget, not by the per-crate cap x crates', async () => {
  // The defect this pins: 7 crates x a 660s per-crate cap is 77 minutes, inside
  // a CARGO_REGISTRY_TOKEN that expires in 30. If the budget restarts per crate
  // it enforces nothing across the run, and a later `cargo publish` fails on
  // AUTH with earlier crates already published.
  //
  // The discriminating shape matters, and my first attempt at this test did not
  // have it: with a budget barely above one cap, the run dies on the FIRST
  // crate either way and the reset is never observed. So the first crate must
  // SUCCEED and consume budget, and the second must show a shortened wait.
  const clock = fakeClock();
  try {
    const published = [];
    // core becomes visible only after 400s of waiting; clash never does.
    const indexCheckFn = async (crate) => crate === 'ifc-lite-core' && Date.now() >= 400_000;

    await assert.rejects(
      () =>
        publishAllCrates({
          crates: ['ifc-lite-core', 'ifc-lite-clash'],
          version: '6.0.0',
          publishFn: (c) => published.push(c),
          preCheckFn: async () => false,
          indexCheckFn,
          intervalMs: 5000,
          timeoutMs: 660_000, // per-crate cap
          totalBudgetMs: 700_000, // one cap plus a little
          sleepFn: clock.sleepFn,
        }),
      // With ONE shared budget, core's 400s leaves clash ~300s, so clash's wait
      // is bounded by the budget and the message says so. With a per-crate
      // reset, clash would get its full 660s cap and this phrase is absent.
      /remainder of the 700s release-wide budget rather than the 660s per-crate cap/
    );
    assert.deepEqual(published, ['ifc-lite-core', 'ifc-lite-clash']);
  } finally {
    clock.restore();
  }
});

test('a budget stop happens BEFORE the publish, so the crate it names is really unpublished', async () => {
  // The guard used to sit below `publishFn`, so it ran `cargo publish` for the
  // crate it then reported as not published: one irreversible upload past the
  // point it had decided further uploads were unsafe. The message was false and
  // the guard defeated its own purpose.
  const clock = fakeClock();
  try {
    const published = [];
    await assert.rejects(
      () =>
        publishAllCrates({
          crates: ['ifc-lite-core', 'ifc-lite-clash', 'ifc-lite-geometry'],
          version: '6.0.0',
          publishFn: (c) => published.push(c),
          preCheckFn: async () => false,
          // core becomes visible exactly as the budget runs out.
          indexCheckFn: async (c) => c === 'ifc-lite-core' && Date.now() >= 300_000,
          intervalMs: 5000,
          timeoutMs: 660_000,
          totalBudgetMs: 300_000,
          sleepFn: clock.sleepFn,
        }),
      /before ifc-lite-clash@6\.0\.0, which has NOT been published/
    );
    // The assertion that actually catches the defect: clash must not appear.
    assert.deepEqual(published, ['ifc-lite-core']);
  } finally {
    clock.restore();
  }
});

test('a crate whose wait is cut short by the budget says so, and gives the token remedy not the CDN one', async () => {
  // Two different failures must not read the same. "Cap exceeded" means the
  // index is genuinely stuck; "budget exceeded" means stop before the token
  // dies. An operator who cannot tell them apart re-runs into the wrong one.
  const clock = fakeClock();
  try {
    await assert.rejects(
      () =>
        publishAllCrates({
          crates: ['ifc-lite-core'],
          version: '6.0.0',
          publishFn: () => {},
          preCheckFn: async () => false,
          indexCheckFn: async () => false,
          intervalMs: 5000,
          timeoutMs: 660_000,
          totalBudgetMs: 30_000, // budget binds well before the cap
          sleepFn: clock.sleepFn,
        }),
      // Asserts across the JOIN, not just the prefix. A stray `+ +` here coerced
      // the tail to NaN and swallowed a whole sentence while a prefix-only
      // assertion stayed green.
      // Spans the join (a stray `+ +` once coerced the tail to NaN and swallowed
      // a sentence while prefix-only assertions stayed green), and pins the
      // budget-specific remedy: a budget stop must NOT send the operator to
      // inspect a CDN edge that was never the problem.
      /remainder of the 30s release-wide budget rather than the 660s per-crate cap\. The upload succeeded[\s\S]*cut short by the budget, not by a stuck index[\s\S]*mint\s+a fresh one/
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

// #3258: the budget started counting only inside `publishAllCrates`, so
// unmeasured work between the token mint and this loop (a second build,
// test:esm, the whole npm publish) was never charged against it. Passing
// `tokenMintedAtMs` closes that: the deadline becomes whichever is EARLIER,
// this budget or the token's own claimed lifetime measured from the mint.

test('a token minted well before the loop starts is already past its lifetime, and a large budget alone would have missed that (#3258)', async () => {
  const clock = fakeClock(); // "now" = 0
  try {
    // Simulates the real defect: by the time this loop runs, the token was
    // already minted 2,000,000ms (~33min) ago — standing in for the
    // unmeasured second build + test:esm + full npm publish that happens
    // between the mint and here. The 30-minute token (minus the 60s margin)
    // is therefore already expired, even though the release-wide budget
    // below is generous and has never been touched.
    const mintedAtMs = -2_000_000;
    await assert.rejects(
      () =>
        publishAllCrates({
          crates: ['ifc-lite-core'],
          version: '6.0.0',
          publishFn: () => {
            throw new Error('must not publish: the crates.io token is already past its lifetime');
          },
          preCheckFn: async () => false,
          indexCheckFn: async () => false,
          intervalMs: 5000,
          timeoutMs: 660_000,
          totalBudgetMs: 900_000, // plenty of budget-only headroom
          tokenMintedAtMs: mintedAtMs,
          sleepFn: clock.sleepFn,
        }),
      /Ran out of publish-phase budget before ifc-lite-core@6\.0\.0[\s\S]*crates\.io token's own remaining lifetime/
    );
  } finally {
    clock.restore();
  }
});

test('the token bound charges the SAME publish-phase work as the release-wide budget, so a stall it alone would have allowed is now caught', async () => {
  // With no token, the budget is 3,000,000ms and would not bind here at all.
  // With the token, the 30-minute (minus 60s margin) lifetime from the mint
  // is the tighter deadline, so the same publish + index-wait sequence must
  // now fail against it instead of sailing through on the oversized budget.
  const clock = fakeClock();
  try {
    await assert.rejects(
      () =>
        publishAllCrates({
          crates: ['ifc-lite-core'],
          version: '6.0.0',
          // Mint happens at the same instant this loop starts (the best
          // case for the old, unfixed code — even here it must now bind).
          tokenMintedAtMs: 0,
          publishFn: () => clock.advance(1_700_000), // 28m20s of build+verify
          preCheckFn: async () => false,
          indexCheckFn: async () => false,
          intervalMs: 5000,
          timeoutMs: 660_000,
          totalBudgetMs: 3_000_000, // deliberately far looser than the token
          sleepFn: clock.sleepFn,
        }),
      /did not appear in the crates\.io index within 40s[\s\S]*remainder of the 1740s release-wide budget[\s\S]*capped by the crates\.io token/
    );
  } finally {
    clock.restore();
  }
});

test('without a minted-token timestamp, the deadline falls back to the release-wide budget only (manual/local run)', async () => {
  // Pins the pre-#3258 fallback: `tokenMintedAtMs` omitted must reproduce the
  // exact old message, unchanged, so a local `node scripts/release-crates.mjs`
  // run (no minted token to bound against) is not newly and needlessly
  // stricter.
  const clock = fakeClock();
  try {
    await assert.rejects(
      () =>
        publishAllCrates({
          crates: ['ifc-lite-core'],
          version: '6.0.0',
          publishFn: () => clock.advance(400_000),
          preCheckFn: async () => false,
          indexCheckFn: async () => false,
          intervalMs: 5000,
          timeoutMs: 660_000,
          totalBudgetMs: 500_000,
          sleepFn: clock.sleepFn,
        }),
      /within 100s[\s\S]*remainder of the 500s release-wide budget rather than the 660s per-crate cap\. /
    );
  } finally {
    clock.restore();
  }
});

test('parseTokenMintedAtMs returns undefined when CRATES_TOKEN_MINTED_AT_MS is unset', () => {
  assert.equal(parseTokenMintedAtMs({}), undefined);
});

test('parseTokenMintedAtMs returns undefined when CRATES_TOKEN_MINTED_AT_MS is the empty string', () => {
  assert.equal(parseTokenMintedAtMs({ CRATES_TOKEN_MINTED_AT_MS: '' }), undefined);
});

test('parseTokenMintedAtMs parses a valid numeric string', () => {
  assert.equal(parseTokenMintedAtMs({ CRATES_TOKEN_MINTED_AT_MS: '1735689600000' }), 1735689600000);
});

test('parseTokenMintedAtMs REFUSES a non-numeric value instead of letting NaN silently defeat the bound', () => {
  // A NaN deadline would propagate through Math.min and every `<=`/`<`
  // comparison in `publishAllCrates` without ever tripping — the exact "hangs
  // the release forever" shape flagged on #3258 for an unvalidated budget
  // read from the environment.
  assert.throws(
    () => parseTokenMintedAtMs({ CRATES_TOKEN_MINTED_AT_MS: 'not-a-number' }),
    /CRATES_TOKEN_MINTED_AT_MS.*not-a-number/
  );
});

test('parseTokenMintedAtMs treats a whitespace-only value as unset, not as epoch 0', () => {
  // `' '` is not `=== ''`, so it used to fall through to `Number(' ')`,
  // which is 0 — finite, so the old check let it pass. An epoch-ms deadline
  // of 0 is 1970: already expired, so the run aborted the crates phase
  // before the first publish, AFTER npm had already published — the exact
  // half-release this script exists to prevent. Trimming first makes a
  // whitespace value behave like an unset one (budget-only fallback)
  // instead of manufacturing that already-expired deadline.
  assert.equal(parseTokenMintedAtMs({ CRATES_TOKEN_MINTED_AT_MS: '   ' }), undefined);
});

test('parseTokenMintedAtMs REFUSES a non-positive timestamp', () => {
  // Not a NaN-shaped malformation, but not a real mint time either: 0 or a
  // negative value produces the same already-expired-deadline half-release
  // as the whitespace case above, just via a value that IS finite.
  assert.throws(
    () => parseTokenMintedAtMs({ CRATES_TOKEN_MINTED_AT_MS: '0' }),
    /CRATES_TOKEN_MINTED_AT_MS/
  );
  assert.throws(
    () => parseTokenMintedAtMs({ CRATES_TOKEN_MINTED_AT_MS: '-5' }),
    /CRATES_TOKEN_MINTED_AT_MS/
  );
});

test('publishAllCrates REFUSES a non-finite tokenMintedAtMs passed directly, instead of disarming both bounds', async () => {
  // parseTokenMintedAtMs validates the env-var path, but publishAllCrates is
  // also callable directly with tokenMintedAtMs bypassing it entirely. A NaN
  // there poisons budgetDeadline via Math.min(x, NaN) === NaN, and every
  // `<=`/`<` comparison against NaN is false — so with totalBudgetMs: 0 (an
  // already-exhausted release-wide budget) the run would otherwise publish
  // anyway, because NEITHER bound can trip on a NaN deadline.
  const clock = fakeClock();
  try {
    const published = [];
    await assert.rejects(
      () =>
        publishAllCrates({
          crates: ['ifc-lite-core'],
          version: '6.0.0',
          publishFn: (c) => published.push(c),
          preCheckFn: async () => false,
          indexCheckFn: async () => true,
          totalBudgetMs: 0,
          tokenMintedAtMs: NaN,
          sleepFn: clock.sleepFn,
        }),
      /tokenMintedAtMs is NaN, which is not a finite number/
    );
    // The assertion that actually catches the defect: nothing published.
    assert.deepEqual(published, []);
  } finally {
    clock.restore();
  }
});
