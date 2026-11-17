/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { splitZonesInWorker } from './split-worker-client.js';

/**
 * `splitZonesInWorker` spawns one worker per run and arms a 600s watchdog
 * timer, both released together by `settle()`. The load-bearing case here:
 * `postMessage` is the LAST statement in the executor, unguarded. If it
 * throws (structured clone can reject an unsupported value), the Promise
 * executor's synchronous throw auto-rejects the returned promise, but
 * nothing on that path calls `settle()` — the spawned worker thread AND the
 * pending timeout timer both leak. Same acquire-then-fallible-step
 * shape as `createCollabSession`.
 */

const instances: FakeWorker[] = [];

class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = 0;

  constructor(public url: unknown, public options: unknown) {
    instances.push(this);
  }

  postMessage(): void {
    /* no-op by default */
  }

  terminate(): void {
    this.terminated++;
  }
}

function baseRequest() {
  return { zones: [], zoneIndex: 0, jobs: [] };
}

beforeEach(() => {
  instances.length = 0;
  (globalThis as { Worker?: unknown }).Worker = FakeWorker;
});

afterEach(() => {
  delete (globalThis as { Worker?: unknown }).Worker;
});

describe('splitZonesInWorker', () => {
  it('rejects without spawning further work when the Worker constructor throws', async () => {
    (globalThis as { Worker?: unknown }).Worker = function () {
      throw new Error('blocked by CSP');
    };
    await assert.rejects(splitZonesInWorker(baseRequest()), /Failed to spawn the zone split worker/);
  });

  it('terminates the worker and clears its timeout timer when postMessage itself throws', async () => {
    class ThrowingPostWorker extends FakeWorker {
      override postMessage(): void {
        throw new Error('could not be cloned');
      }
    }
    (globalThis as { Worker?: unknown }).Worker = ThrowingPostWorker;
    const promise = splitZonesInWorker(baseRequest());
    const worker = instances[0];
    await assert.rejects(promise, /could not be cloned/);
    assert.equal(worker.terminated, 1, 'a postMessage throw must still terminate the worker');
  });

  it('terminates the worker and clears its timeout timer when a piece cannot be copied (a detached array)', async () => {
    const positions = new Float32Array(9);
    structuredClone(positions.buffer, { transfer: [positions.buffer] }); // detaches it
    let posted = 0;
    (globalThis as { Worker?: unknown }).Worker = class extends FakeWorker { override postMessage(): void { posted++; } };
    const promise = splitZonesInWorker({ zones: [], zoneIndex: 0, jobs: [{ globalId: 7, pieces: [{ positions, indices: new Uint32Array(3) }] }] });
    const worker = instances[0];
    await assert.rejects(promise);
    assert.equal(worker.terminated, 1, 'the worker is terminated (and its 600 s timer cleared with it)');
    assert.equal(posted, 0, 'nothing was posted');
  });

  it('sends each piece as its own bytes, not the whole buffer its arrays view', async () => {
    // Mesh arrays from a cache hit are views into shared ~1 MiB arena blocks.
    const block = new ArrayBuffer(1 << 20);
    const positions = new Float32Array(block, 4096, 9).fill(1.5);
    const indices = new Uint32Array(block, 8192, 3).fill(2);
    const got: { message: { jobs: { pieces: { positions: Float32Array; indices: Uint32Array }[] }[] } | null } = { message: null };
    (globalThis as { Worker?: unknown }).Worker = class extends FakeWorker {
      override postMessage(message?: unknown): void { got.message = structuredClone(message) as typeof got.message; }
    };
    const run = splitZonesInWorker({ zones: [], zoneIndex: 0, jobs: [{ globalId: 7, pieces: [{ positions, indices }] }] }).catch(() => {});
    try {
      assert.ok(got.message, 'the request was posted');
      const piece = got.message.jobs[0].pieces[0];
      assert.deepStrictEqual([...piece.positions], [...positions]);
      assert.deepStrictEqual([...piece.indices], [...indices]);
      assert.strictEqual(piece.positions.buffer.byteLength, positions.byteLength, 'positions cloned alone, not their 1 MiB block');
      assert.strictEqual(piece.indices.buffer.byteLength, indices.byteLength);
      assert.strictEqual(positions[0], 1.5, 'the scene\'s own arrays are untouched');
    } finally {
      for (const w of instances) w.onerror?.({ message: 'end of test' }); // settles the run and its watchdog
      await run;
    }
  });
});
