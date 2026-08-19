/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `scanEntitiesInWorker` spawns a `Worker`, then calls `worker.postMessage`
 * to send it the buffer. Both were inside one try whose catch only had
 * `reject(err)` — since `worker` was declared with `const` INSIDE the try,
 * the catch block could not see it, so a worker that was successfully
 * constructed but failed on `postMessage` (e.g. a `DataCloneError` from an
 * already-detached ArrayBuffer, or a clone failure under memory pressure on
 * a large file) was never terminated: a leaked worker per failed scan.
 *
 * Same shape as the two confirmed leaks in `collab/session.ts` and
 * `collab-server/room-manager.ts`: a disposable resource is acquired, a
 * fallible step runs after it, and the failure path never receives (or, here,
 * never RETAINS) a handle to what it already holds.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { scanEntitiesInWorker } from '../src/scan-worker-inline.js';

describe('scanEntitiesInWorker terminates the worker when postMessage throws', () => {
  const originalWorker = (globalThis as Record<string, unknown>).Worker;
  const originalBlob = (globalThis as Record<string, unknown>).Blob;
  const originalURL = (globalThis as Record<string, unknown>).URL;

  afterEach(() => {
    (globalThis as Record<string, unknown>).Worker = originalWorker;
    (globalThis as Record<string, unknown>).Blob = originalBlob;
    // Restore, or DELETE if `URL` was absent before this test installed its
    // fake — `if (originalURL) ...` left the fake `URL` (with the fake
    // `createObjectURL`) permanently on `globalThis` for every later test in
    // this environment when `originalURL` was falsy/undefined (PR #2822
    // review).
    if (originalURL === undefined) {
      delete (globalThis as Record<string, unknown>).URL;
    } else {
      (globalThis as Record<string, unknown>).URL = originalURL;
    }
  });

  it('calls terminate() on the constructed worker before rejecting', async () => {
    let constructed = 0;
    let terminateCalls = 0;

    (globalThis as Record<string, unknown>).Blob = class {
      constructor(_parts: unknown[], _opts: unknown) {}
    };
    if (!(globalThis as Record<string, unknown>).URL) {
      (globalThis as Record<string, unknown>).URL = {} as unknown as typeof URL;
    }
    (globalThis as unknown as { URL: { createObjectURL: () => string } }).URL.createObjectURL = () =>
      'blob:fake-url';

    class FakeWorker {
      onmessage: unknown = null;
      onerror: unknown = null;
      constructor(_url: string) {
        constructed++;
      }
      postMessage(_msg: unknown) {
        // Simulates a structured-clone failure on `postMessage` — e.g. the
        // caller's ArrayBuffer was already detached by a concurrent transfer,
        // or the clone allocation failed under memory pressure on a large
        // IFC file.
        throw new Error('forced DataCloneError (simulated)');
      }
      terminate() {
        terminateCalls++;
      }
    }
    (globalThis as Record<string, unknown>).Worker = FakeWorker;

    const buffer = new ArrayBuffer(8);
    await expect(scanEntitiesInWorker(buffer)).rejects.toThrow('forced DataCloneError');

    expect(constructed).toBe(1);
    // GREEN: the fix stores `worker` outside the try so the catch block can
    // reach it and call `terminate()` before rejecting.
    expect(terminateCalls).toBe(1);
  });
});
