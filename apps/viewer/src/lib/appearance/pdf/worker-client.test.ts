/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPdfWorkerClient, type PdfWorker } from './worker-client.js';
import {
  PdfAppearanceError,
  type PdfWorkerRequest,
  type PdfWorkerResponse,
} from './types.js';
class Worker implements PdfWorker {
  onmessage: PdfWorker['onmessage'] = null;
  onerror: PdfWorker['onerror'] = null;
  onmessageerror: PdfWorker['onmessageerror'] = null;
  message?: PdfWorkerRequest;
  terminated = 0;
  failPost = false;
  postMessage(message: PdfWorkerRequest) {
    if (this.failPost) throw new Error('clone failed');
    this.message = message;
  }
  terminate() {
    this.terminated++;
  }
  fail(code: 'password-required' | 'password-incorrect' = 'password-required') {
    this.onmessage?.({
      data: {
        id: this.message!.id,
        error: { code, message: 'Password needed' },
      },
    } as MessageEvent<PdfWorkerResponse>);
  }
}
test('PDF latest request cancels old worker; stale delivery cannot settle current request (#4260)', async () => {
  const workers: Worker[] = [];
  const client = createPdfWorkerClient({
    workerFactory: () => {
      const worker = new Worker();
      workers.push(worker);
      return worker;
    },
  });
  const source = new Uint8Array([1, 2, 3]);
  const first = client.run(source, { kind: 'inspect' }),
    rejected = assert.rejects(
      first,
      (error) =>
        error instanceof PdfAppearanceError && error.code === 'cancelled',
    );
  const oldCallback = workers[0].onmessage;
  const second = client.run(source, { kind: 'inspect', pageNumber: 2 });
  await rejected;
  assert.equal(workers[0].terminated, 1);
  oldCallback?.({
    data: { id: 1, error: { code: 'invalid-pdf', message: 'stale' } },
  } as MessageEvent<PdfWorkerResponse>);
  workers[1].fail('password-incorrect');
  await assert.rejects(
    second,
    (error) =>
      error instanceof PdfAppearanceError &&
      error.code === 'password-incorrect',
  );
  assert.equal(workers[1].terminated, 1);
  assert.equal(workers[1].onmessage, null);
  client.dispose();
  assert.equal(workers[1].terminated, 1);
});
test('PDF abort, timeout and clone failure terminate jobs and reject without hanging (#4260)', async () => {
  for (const mode of ['abort', 'timeout', 'post'] as const) {
    const worker = new Worker();
    worker.failPost = mode === 'post';
    const client = createPdfWorkerClient({
        workerFactory: () => worker,
        timeoutMs: 5,
      }),
      abort = new AbortController();
    const pending = client.run(
      new Uint8Array([1]),
      { kind: 'inspect' },
      { signal: abort.signal },
    );
    if (mode === 'abort') abort.abort();
    await assert.rejects(pending);
    assert.equal(worker.terminated, 1);
    assert.equal(worker.onerror, null);
    client.dispose();
  }
});
