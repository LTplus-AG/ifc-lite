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
  respondError(error: string, invalidPattern = false) {
    this.onmessage?.({
      data: { id: this.message!.id, error, invalidPattern },
    } as MessageEvent);
  }
  respondBadId(id: number, matched: boolean) {
    this.onmessage?.({
      data: { id, matched },
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

test('propagates a worker-tagged invalid-pattern error as a SyntaxError (#4505 finding A)', async () => {
  const worker = new MockWorker();
  const client = createRegexWorkerClient({ workerFactory: () => worker });

  const pending = client.evaluate('(', 'text');
  worker.respondError('Invalid regular expression: /(/: Unterminated group', true);

  try {
    await pending;
    assert.fail('expected rejection');
  } catch (err) {
    // Load-bearing: `applyExpectations` (packages/extensions/src/testing/runner.ts)
    // branches on `instanceof SyntaxError` to decide whether to report
    // "invalid pattern" — a plain Error here would mislabel a genuine
    // syntax error, or (the actual #4505 bug) mislabel everything else
    // as one.
    assert.ok(err instanceof SyntaxError, `expected SyntaxError, got ${err}`);
  }
  assert.equal(worker.terminated, 1);
});

test('propagates a non-invalid-pattern worker error as a plain Error, not SyntaxError (#4505 finding A)', async () => {
  const worker = new MockWorker();
  const client = createRegexWorkerClient({ workerFactory: () => worker });

  const pending = client.evaluate('a', 'text');
  worker.respondError('some internal worker failure', false);

  try {
    await pending;
    assert.fail('expected rejection');
  } catch (err) {
    assert.ok(err instanceof Error, `expected Error, got ${err}`);
    assert.ok(!(err instanceof SyntaxError), `must not be a SyntaxError: ${err}`);
  }
});

test('ignores a response whose id does not match the in-flight request', async () => {
  const worker = new MockWorker();
  const client = createRegexWorkerClient({ workerFactory: () => worker, timeoutMs: 20 });

  const pending = client.evaluate('a', 'a');
  worker.respondBadId(999, true); // stale/mismatched id — must not settle the promise
  worker.respondMatched(false); // the real, correctly-addressed response

  assert.deepEqual(await pending, { matched: false });
});

test('assigns each call on a shared client a distinct id (#4505 finding D)', async () => {
  const worker = new MockWorker();
  const client = createRegexWorkerClient({ workerFactory: () => worker });

  const first = client.evaluate('a', 'a');
  assert.equal(worker.message?.id, 1);
  worker.respondMatched(true);
  await first;

  const second = client.evaluate('b', 'b');
  // A fresh id, not a repeat of the first call's — a worker that
  // (buggily) echoed request #1's id back for request #2's response
  // must be distinguishable, which a constant id could never be.
  assert.equal(worker.message?.id, 2);
  worker.respondMatched(false);
  await second;
});

test('dispose() aborts an in-flight evaluation', async () => {
  const worker = new MockWorker();
  const client = createRegexWorkerClient({ workerFactory: () => worker, timeoutMs: 1000 });

  const pending = client.evaluate('a', 'a');
  client.dispose();

  await assert.rejects(pending, /cancelled/i);
  assert.equal(worker.terminated, 1);
});

test('dispose() aborts every concurrent in-flight evaluation on a shared client, not just the latest (#4505 finding D)', async () => {
  const workers: MockWorker[] = [];
  const client = createRegexWorkerClient({
    workerFactory: () => {
      const w = new MockWorker();
      workers.push(w);
      return w;
    },
    timeoutMs: 1000,
  });

  // Two calls in flight at once on the SAME client — the shape of
  // `runTests` and `revalidateForSdk` sharing one ExtensionHostService's
  // regexWorkerClient. Before the fix, the single `abortCurrent` slot
  // meant only the second call's worker was ever terminated by
  // dispose(), and the first call's own successful finish() would null
  // out the slot out from under the second call even without a dispose.
  const first = client.evaluate('a', 'a');
  const second = client.evaluate('b', 'b');
  assert.equal(workers.length, 2);

  client.dispose();

  await assert.rejects(first, /cancelled/i);
  await assert.rejects(second, /cancelled/i);
  assert.equal(workers[0].terminated, 1);
  assert.equal(workers[1].terminated, 1);
});

test('reset() un-poisons a disposed client so it accepts new calls again (#4505 finding C)', async () => {
  const worker = new MockWorker();
  const client = createRegexWorkerClient({ workerFactory: () => worker });

  client.dispose();
  await assert.rejects(client.evaluate('a', 'a'), /disposed/i);

  client.reset();

  const pending = client.evaluate('a', 'a');
  worker.respondMatched(true);
  assert.deepEqual(await pending, { matched: true });
});

test('a factory that throws (e.g. no Worker support) rejects rather than throwing synchronously', async () => {
  const client = createRegexWorkerClient({
    workerFactory: () => {
      throw new Error('Worker is not defined');
    },
  });
  await assert.rejects(client.evaluate('a', 'a'), /Cannot start regex worker/);
});
