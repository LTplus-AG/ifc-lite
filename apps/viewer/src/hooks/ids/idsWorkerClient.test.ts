/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { contiguousSourceBytes, type IfcSourceTransfer } from '@ifc-lite/parser';
import { runValidationInWorker } from './idsWorkerClient.js';
import type { IDSDocument } from '@ifc-lite/ids';

/**
 * Contract tests for the IDS validation worker client.
 *
 * The worker is single-shot: one `Worker` per call, terminated the moment
 * the run settles (`settle()` in idsWorkerClient.ts). The load-bearing
 * assertions here are:
 *   - exactly one settle ever happens, no matter how many messages arrive
 *     after the terminal one;
 *   - a message carrying a different `id` than the one this call sent is
 *     ignored rather than resolving/rejecting/progressing the wrong call;
 *   - the worker is terminated and its handlers detached on every terminal
 *     path (complete, error, onerror, onmessageerror), not just the happy one.
 */

interface PostedMessage {
  type: string;
  id: number;
  source: IfcSourceTransfer;
  [key: string]: unknown;
}

const instances: FakeWorker[] = [];

class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly posted: PostedMessage[] = [];
  readonly transfers: unknown[][] = [];
  terminated = 0;

  constructor(public url: unknown, public options: unknown) {
    instances.push(this);
  }

  postMessage(message: PostedMessage, transfer?: unknown[]): void {
    this.posted.push(message);
    this.transfers.push(transfer ?? []);
  }

  terminate(): void {
    this.terminated++;
  }

  reply(data: unknown): void {
    this.onmessage?.({ data });
  }
}

const doc = {} as IDSDocument;

function baseArgs(overrides: Partial<Parameters<typeof runValidationInWorker>[0]> = {}) {
  return {
    source: contiguousSourceBytes(new Uint8Array([1, 2, 3, 4])).toTransferable(),
    document: doc,
    schemaVersion: 'IFC4',
    modelId: 'model-1',
    locale: 'en' as const,
    includePassingEntities: true,
    ...overrides,
  };
}

beforeEach(() => {
  instances.length = 0;
  (globalThis as { Worker?: unknown }).Worker = FakeWorker;
});

afterEach(() => {
  delete (globalThis as { Worker?: unknown }).Worker;
});

describe('runValidationInWorker', () => {
  it('resolves with the report on a matching complete message', async () => {
    const promise = runValidationInWorker(baseArgs());
    const worker = instances[0];
    const id = worker.posted[0].id;
    const report = { valid: true } as never;
    worker.reply({ type: 'complete', id, report });
    assert.deepEqual(await promise, report);
    assert.equal(worker.terminated, 1);
  });

  it('streams matching progress events to onProgress', async () => {
    const progresses: unknown[] = [];
    const promise = runValidationInWorker(baseArgs({ onProgress: (p) => progresses.push(p) }));
    const worker = instances[0];
    const id = worker.posted[0].id;
    worker.reply({ type: 'progress', id, progress: { phase: 'filtering' } });
    worker.reply({ type: 'progress', id, progress: { phase: 'complete' } });
    worker.reply({ type: 'complete', id, report: {} });
    await promise;
    assert.equal(progresses.length, 2, 'both progress events must reach the caller');
  });

  it('rejects with the worker-reported message on an error reply', async () => {
    const promise = runValidationInWorker(baseArgs());
    const worker = instances[0];
    const id = worker.posted[0].id;
    worker.reply({ type: 'error', id, message: 'schema mismatch' });
    await assert.rejects(promise, /schema mismatch/);
    assert.equal(worker.terminated, 1);
  });

  it('ignores a message whose id does not match this call\'s request', async () => {
    const progresses: unknown[] = [];
    const promise = runValidationInWorker(baseArgs({ onProgress: (p) => progresses.push(p) }));
    const worker = instances[0];
    const id = worker.posted[0].id;
    // A stale/foreign id must not be treated as this call's progress...
    worker.reply({ type: 'progress', id: id + 1, progress: { phase: 'filtering' } });
    assert.equal(progresses.length, 0, 'a mismatched id must not be delivered as progress');
    // ...nor as this call's terminal event.
    worker.reply({ type: 'complete', id: id + 1, report: { wrong: true } });
    // The call must still be pending: settle it for real and check we get
    // the RIGHT report, not the mismatched one.
    worker.reply({ type: 'complete', id, report: { right: true } });
    assert.deepEqual(await promise, { right: true });
  });

  it('rejects and terminates when the worker crashes (onerror)', async () => {
    const promise = runValidationInWorker(baseArgs());
    const worker = instances[0];
    worker.onerror?.({ message: 'worker crashed' });
    await assert.rejects(promise, /worker crashed/);
    assert.equal(worker.terminated, 1);
  });

  it('rejects and terminates on an undeserializable reply (messageerror)', async () => {
    const promise = runValidationInWorker(baseArgs());
    const worker = instances[0];
    worker.onmessageerror?.();
    await assert.rejects(promise, /deserialization failed/);
    assert.equal(worker.terminated, 1);
  });

  it('settles only once: a late reply after complete cannot resolve or reject again', async () => {
    const promise = runValidationInWorker(baseArgs());
    const worker = instances[0];
    const id = worker.posted[0].id;
    worker.reply({ type: 'complete', id, report: { first: true } });
    assert.deepEqual(await promise, { first: true });
    assert.equal(worker.terminated, 1);
    // Handlers must be detached post-settle, so this must not throw or
    // change the already-resolved promise's value.
    assert.doesNotThrow(() => worker.reply({ type: 'error', id, message: 'too late' }));
    assert.equal(worker.terminated, 1, 'settle must not run twice');
  });

  it('never TRANSFERS the source, so the caller\'s buffer cannot be detached', async () => {
    // This replaces a test that pinned the old copy-then-transfer dance. The
    // client now posts a transfer ENVELOPE (#2183) and lets structured clone
    // do the work: a SharedArrayBuffer crosses by reference, a plain buffer is
    // copied by the serializer without the main thread allocating a copy first.
    //
    // What still matters, and is what this asserts: nothing goes in a transfer
    // list. Transferring the source would detach the viewer's own bytes, and
    // every subsequent read would see a zero-length buffer.
    const bytes = new Uint8Array([9, 8, 7]);
    const source = contiguousSourceBytes(bytes).toTransferable();
    void runValidationInWorker(baseArgs({ source }));
    const worker = instances[0];

    assert.deepEqual(worker.transfers[0] ?? [], [], 'the source must never be transferred');
    assert.equal(worker.posted[0].source.kind, 'contiguous');
    // The caller's bytes are still readable, which is the property a transfer
    // would have destroyed.
    assert.equal(bytes.byteLength, 3);
  });

  it('rejects without spawning further work when the Worker constructor throws', async () => {
    (globalThis as { Worker?: unknown }).Worker = function () {
      throw new Error('blocked by CSP');
    };
    await assert.rejects(runValidationInWorker(baseArgs()), /Failed to spawn IDS worker/);
  });
});
