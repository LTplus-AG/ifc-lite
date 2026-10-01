/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AlignmentClient, type AlignmentWorker } from './alignment-client';

class WorkerHarness implements AlignmentWorker {
  onmessage: Worker['onmessage'] = null;
  onerror: Worker['onerror'] = null;
  onmessageerror: Worker['onmessageerror'] = null;
  sent: unknown[] = [];
  terminations = 0;
  postMessage(message: unknown) { this.sent.push(message); }
  terminate() { ++this.terminations; }
}

test('alignment teardown rejects queued work and releases its worker exactly once (#6603)', async () => {
  const worker = new WorkerHarness();
  const client = new AlignmentClient(() => worker);
  const first = client.request({ kind: 'evaluate', distance: 2 });
  const second = client.request({ kind: 'evaluate', distance: 3 });
  const firstRejected = assert.rejects(first, /cancelled/);
  const secondRejected = assert.rejects(second, /cancelled/);
  client.close(); client.close();
  await Promise.all([firstRejected, secondRejected]);
  assert.equal(worker.terminations, 1);
  assert.equal(worker.onmessage, null);
  await assert.rejects(client.request({ kind: 'evaluate', distance: 4 }), /closed/);
});

test('alignment deadline releases a worker stuck while parsing instead of pinning WASM (#6603)', async () => {
  const worker = new WorkerHarness();
  const client = new AlignmentClient(() => worker, 5);
  await assert.rejects(client.request({ kind: 'evaluate', distance: 2 }), /timed out/);
  assert.equal(worker.terminations, 1);
  assert.equal(worker.onerror, null);
});

test('alignment worker crash rejects every queued station request (#6603)', async () => {
  const worker = new WorkerHarness();
  const client = new AlignmentClient(() => worker);
  const first = assert.rejects(client.request({ kind: 'evaluate', distance: 1 }), /worker failed/);
  const second = assert.rejects(client.request({ kind: 'evaluate', distance: 2 }), /worker failed/);
  assert.ok(worker.onerror);
  Reflect.apply(worker.onerror, null, []);
  await Promise.all([first, second]);
  assert.equal(worker.terminations, 1);
});

test('alignment source clone failure closes the client and permits a fresh session (#6603)', async () => {
  const worker = new WorkerHarness();
  worker.postMessage = () => { throw new Error('source clone failed'); };
  const client = new AlignmentClient(() => worker);
  await assert.rejects(client.request({ kind: 'evaluate', distance: 1 }), /source clone failed/);
  assert.equal(worker.terminations, 1);
  const retryWorker = new WorkerHarness();
  const retry = new AlignmentClient(() => retryWorker);
  const pending = assert.rejects(retry.request({ kind: 'evaluate', distance: 1 }), /cancelled/);
  assert.equal(retryWorker.sent.length, 1);
  retry.close(); await pending;
});

test('idle alignment worker receives disposal before bounded termination (#6603)', async () => {
  const worker = new WorkerHarness();
  const client = new AlignmentClient(() => worker);
  client.close();
  assert.deepEqual(worker.sent, [{ kind: 'dispose', id: 1 }]);
  assert.equal(worker.terminations, 0, 'retained handle has a chance to free before realm termination');
  assert.ok(worker.onmessage);
  Reflect.apply(worker.onmessage, null, [{ data: { kind: 'disposed', id: 1 } }]);
  assert.equal(worker.terminations, 1);
  assert.equal(worker.onmessage, null);
  client.close(); assert.equal(worker.terminations, 1);
});
