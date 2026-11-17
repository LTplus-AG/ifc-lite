/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The opt-in `boot-settled` arm (the `-settled` lanes): an open waits for the
// viewer's own idle boot work, and a missing or contradicting signal is an
// explicit failure, never a silent fallback to the default arm. The page is a
// scripted stand-in for Playwright's: `evaluate` returns the hook's answer at
// the page clock and `waitForTimeout` advances it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitBootSettled } from './viewer-load-boot.mjs';

/** A page whose `__ifc_lite_boot_settled__()` turns true at `settledAt` (null: the page has no hook). */
function scriptedPage(settledAt) {
  let now = 0;
  return {
    // What `readBootSignal` reports in page: no hook, or the hook's boolean answer.
    evaluate: async () => (settledAt === null ? { kind: 'absent' } : { kind: 'boolean', value: now >= settledAt }),
    waitForTimeout: async (ms) => { now += ms; },
  };
}

test('waits until the viewer reports its idle boot work settled', async () => {
  const r = await waitBootSettled(scriptedPage(700), { timeoutMs: 20_000 });
  assert.equal(r.bootSettled, true);
});

test('a page without the hook fails the sample unless its side declares it has none', async () => {
  await assert.rejects(waitBootSettled(scriptedPage(null)), /exposes no __ifc_lite_boot_settled__/);
  assert.deepEqual(await waitBootSettled(scriptedPage(null), { expectSignal: false }), { bootSettled: 'no signal (declared)', bootSettledWaitMs: 0 });
});

test('a side that declares no signal but exposes one fails, so a mislabelled build cannot pass', async () => {
  await assert.rejects(waitBootSettled(scriptedPage(0), { expectSignal: false }), /declares `bootSignal: false`/);
});

test('boot work that never settles is unverifiable, not armed anyway', async () => {
  await assert.rejects(waitBootSettled(scriptedPage(10 ** 9), { timeoutMs: 300 }), /did not settle within 300 ms \(unverifiable\)/);
});
