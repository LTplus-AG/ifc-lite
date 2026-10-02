/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateInWorker, type ValidationWorker } from './validation-worker';
function worker() {
  let terminated = 0; let posted = 0;
  const client: ValidationWorker = { onerror: null, onmessage: null,
    terminate() { terminated++; }, postMessage() { posted++; } };
  return { client, terminated: () => terminated, posted: () => posted };
}
test('charter #6643 cancelled workers terminate once and detached responses cannot overwrite new state', async () => {
  const controller = new AbortController(); const old = worker();
  const pending = validateInWorker({ graph: '' }, controller.signal, () => old.client);
  const late = old.client.onmessage; controller.abort();
  await assert.rejects(pending, /Cancelled/); assert.equal(old.terminated(), 1); assert.equal(old.client.onmessage, null);
  late?.({ data: { ok: true, value: { graph: 'late', findings: [] } } } as MessageEvent<unknown>);
  assert.equal(old.terminated(), 1);
  const already = worker(); await assert.rejects(validateInWorker({}, controller.signal, () => already.client), /Cancelled/);
  assert.equal(already.posted(), 0); assert.equal(already.terminated(), 0);
});
test('charter #6643 worker errors and structured-clone failures release their owned worker', async () => {
  const failed = worker(); const pending = validateInWorker({}, new AbortController().signal, () => failed.client);
  failed.client.onmessage?.({ data: { ok: true } } as MessageEvent<unknown>);
  await assert.rejects(pending, /Malformed/); assert.equal(failed.terminated(), 1);
  const cloning = worker(); cloning.client.postMessage = () => { throw new Error('Cannot clone job'); };
  await assert.rejects(validateInWorker({}, new AbortController().signal, () => cloning.client), /Cannot clone/);
  assert.equal(cloning.terminated(), 1);
});
