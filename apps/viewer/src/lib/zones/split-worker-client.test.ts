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
});
