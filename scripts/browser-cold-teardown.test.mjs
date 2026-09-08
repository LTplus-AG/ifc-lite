/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tsImport } from 'tsx/esm/api';
const { closeContextWithTimeout, closeBrowserWithTimeout, raceWithTimeout } =
  await tsImport('./perf/browser-cold-teardown.ts', import.meta.url);

// #4116: `await x.close().catch(...)` only handles a *rejection* — a close()
// that never settles is neither resolved nor rejected, so the harness hung
// forever with nothing recorded. closeContextWithTimeout/closeBrowserWithTimeout
// must bound that wait and return a named string instead. A never-settling
// close() is simulated directly (not the real Playwright object) to avoid
// launching a browser, matching how #4134 verified the mechanism.
const neverSettles = { close: () => new Promise(() => {}) };
const healthy = { close: () => Promise.resolve() };
const rejecting = { close: () => Promise.reject(new Error('boom')) };

test('#4116 closeContextWithTimeout returns a named timeout string when close() never settles', async () => {
  const start = Date.now();
  const message = await closeContextWithTimeout(neverSettles, 50);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2000, `expected the timeout to bound the wait, took ${elapsed}ms`);
  assert.match(message, /context\.close\(\) did not resolve within 50ms/);
});

test('#4116 closeBrowserWithTimeout returns a named timeout string when close() never settles', async () => {
  const start = Date.now();
  const message = await closeBrowserWithTimeout(neverSettles, 50);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2000, `expected the timeout to bound the wait, took ${elapsed}ms`);
  assert.match(message, /browser\.close\(\) did not resolve within 50ms/);
});

test('#4116 a healthy close() returns null promptly for both helpers', async () => {
  assert.equal(await closeContextWithTimeout(healthy, 5000), null);
  assert.equal(await closeBrowserWithTimeout(healthy, 5000), null);
});

test('#4116 a rejecting close() still reports the rejection message (not just a timeout)', async () => {
  assert.equal(await closeContextWithTimeout(rejecting, 5000), 'boom');
  assert.equal(await closeBrowserWithTimeout(rejecting, 5000), 'boom');
});

test('#4116 undefined context/browser is a no-op that returns null', async () => {
  assert.equal(await closeContextWithTimeout(undefined, 5000), null);
  assert.equal(await closeBrowserWithTimeout(undefined, 5000), null);
});

// #4134 follow-up: browser.newContext()/context.newPage() share the same
// unbounded-CDP-await risk as close() and expose no `timeout` option of their
// own (unlike chromium.launch(), which defaults to 30s). browser-cold-ab.mts
// now bounds them with this same exported helper.
test('#4134 raceWithTimeout rejects with a named message when the underlying promise never settles', async () => {
  const start = Date.now();
  await assert.rejects(
    raceWithTimeout(new Promise(() => {}), 50, 'browser.newContext()'),
    /browser\.newContext\(\) did not resolve within 50ms/,
  );
  assert.ok(Date.now() - start < 2000, 'expected the race to bound the wait');
});

test('#4134 raceWithTimeout resolves promptly when the underlying promise settles', async () => {
  assert.equal(await raceWithTimeout(Promise.resolve('page'), 5000, 'context.newPage()'), 'page');
});
