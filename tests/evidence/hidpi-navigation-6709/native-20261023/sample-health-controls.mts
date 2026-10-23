/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #6709 / review r4365052821: late asynchronous errors cannot become success.
import assert from 'node:assert/strict';
import { verifyFinalHealth } from './sample-health.mts';

for (const phase of ['settle', 'host']) {
  const errors: string[] = [], order: string[] = [];
  const meta: { hostAfter?: unknown; errors?: unknown } = {};
  await assert.rejects(verifyFinalHealth(meta,
    async () => { order.push('settle'); await Promise.resolve(); if (phase === 'settle') errors.push('late page error'); },
    async () => { order.push('host'); await Promise.resolve(); if (phase === 'host') errors.push('GPU:late uncaptured error'); return { quiet: true }; },
    async () => { order.push('errors'); return [...errors]; },
  ), /Unhandled page\/GPU errors/);
  assert.deepEqual(order, ['settle', 'host', 'errors']);
  assert.deepEqual(meta.errors, errors, 'Late errors must also be retained as evidence');
}
for (const absent of [undefined, null, {}]) {
  await assert.rejects(verifyFinalHealth({}, async () => {}, async () => ({ quiet: true }), async () => absent), /observation missing/);
}
for (const host of [undefined, { quiet: false }, { quiet: 'true' }]) {
  await assert.rejects(verifyFinalHealth({}, async () => {}, async () => host, async () => []), /Host post-admission refused/);
}
const clean: { hostAfter?: unknown; errors?: unknown } = {};
await verifyFinalHealth(clean, async () => {}, async () => ({ quiet: true }), async () => []);
assert.deepEqual(clean.errors, []);
console.log(JSON.stringify({ ok: true, refusedCases: 8, cleanAccepted: true, scope: 'Final observation ordering diagnostic; no native timing or viewer correctness claim' }));
