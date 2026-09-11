/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegexWorkerClient, type RegexWorker } from './regex-worker-client.js';

/** A hand-written stand-in for the real Worker, mirroring the PDF worker
 * client test's mock (`apps/viewer/src/lib/appearance/pdf/worker-client.test.ts`). */
class MockWorker implements RegexWorker {
  onmessage: RegexWorker['onmessage'] = null;
  onerror: RegexWorker['onerror'] = null;
  onmessageerror: RegexWorker['onmessageerror'] = null;
  message?: { id: number; pattern: string; text: string };
  terminated = 0;

  postMessage(message: { id: number; pattern: string; text: string }) {
    this.message = message;
  }
  terminate() {
    this.terminated++;
  }
  respondMatched(matched: boolean) {
    this.onmessage?.({
      data: { id: this.message!.id, matched },
    } as MessageEvent);
  }
  respondError(error: string) {
    this.onmessage?.({
      data: { id: this.message!.id, error },
    } as MessageEvent);
  }
  respondBadId(matched: boolean) {
    this.onmessage?.({
      data: { id: this.message!.id + 999, matched },
    } as MessageEvent);
  }
}

test('resolves { matched } from a normal worker response', async () => {
  const worker = new MockWorker();
  const client = createRegexWorkerClient({ workerFactory: () => worker });

  const pending = client.evaluate('hello.*42', 'hello world 42');
  assert.deepEqual(worker.message, { id: 1, pattern: 'hello.*42', text: 'hello world 42' });
  worker.respondMatched(true);

  assert.deepEqual(await pending, { matched: true });
  assert.equal(worker.terminated, 1);
});

test('terminates the worker and rejects with a timeout error when the deadline passes (#4482)', async () => {
  const worker = new MockWorker(); // never calls onmessage — simulates a hung/catastrophic regex
  const client = createRegexWorkerClient({ workerFactory: () => worker, timeoutMs: 5 });

  const pending = client.evaluate('(a+)+$', 'a'.repeat(40) + '!');

  await assert.rejects(pending, /timed out after 5ms/);
  // Load-bearing assertion for #4482: the hang is bounded AND the
  // worker actually gets torn down rather than left running forever.
  assert.equal(worker.terminated, 1);
});

test('propagates a worker-reported error (invalid pattern) as a rejection', async () => {
  const worker = new MockWorker();
  const client = createRegexWorkerClient({ workerFactory: () => worker });

  const pending = client.evaluate('(', 'text');
  worker.respondError('Invalid regular expression: /(/: Unterminated group');

  await assert.rejects(pending, /Unterminated group/);
  assert.equal(worker.terminated, 1);
});

test('ignores a response whose id does not match the in-flight request', async () => {
  const worker = new MockWorker();
  const client = createRegexWorkerClient({ workerFactory: () => worker, timeoutMs: 20 });

  const pending = client.evaluate('a', 'a');
  worker.respondBadId(true); // stale/mismatched id — must not settle the promise
  worker.respondMatched(false); // the real, correctly-addressed response

  assert.deepEqual(await pending, { matched: false });
});

test('dispose() aborts an in-flight evaluation', async () => {
  const worker = new MockWorker();
  const client = createRegexWorkerClient({ workerFactory: () => worker, timeoutMs: 1000 });

  const pending = client.evaluate('a', 'a');
  client.dispose();

  await assert.rejects(pending, /cancelled/i);
  assert.equal(worker.terminated, 1);
});

test('a factory that throws (e.g. no Worker support) rejects rather than throwing synchronously', async () => {
  const client = createRegexWorkerClient({
    workerFactory: () => {
      throw new Error('Worker is not defined');
    },
  });
  await assert.rejects(client.evaluate('a', 'a'), /Cannot start regex worker/);
});
