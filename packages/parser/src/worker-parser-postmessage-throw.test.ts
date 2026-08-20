/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `parseColumnar` spawns a worker, wires its handlers, then calls
 * `worker.postMessage(input)` as the last statement inside the Promise
 * executor. `postMessage` can itself throw synchronously (a structured-clone
 * `DataCloneError` is the realistic trigger), and a throw inside a Promise
 * executor auto-rejects the returned promise WITHOUT running the rest of the
 * executor — `settle()` is never reached, so `worker.terminate()` never runs
 * and the worker thread leaks.
 *
 * Same shape as the IDS validation worker client and the zone-split worker
 * client (both fixed separately): the worker is already live, its handlers
 * are already wired, and the only thing standing between "throws" and
 * "leaked worker" is whether `postMessage` itself is guarded.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerParser } from './worker-parser.js';

class FakeWorker {
  postMessage: (msg: unknown) => void;
  terminate = vi.fn();
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessageerror: (() => void) | null = null;

  constructor(postMessage: (msg: unknown) => void) {
    this.postMessage = vi.fn(postMessage);
  }
}

let originalWorker: unknown;
let lastWorker: FakeWorker | null = null;

beforeEach(() => {
  originalWorker = (globalThis as Record<string, unknown>).Worker;
  lastWorker = null;
});

afterEach(() => {
  (globalThis as Record<string, unknown>).Worker = originalWorker;
  vi.restoreAllMocks();
});

function installThrowingWorker(): void {
  (globalThis as Record<string, unknown>).Worker = vi.fn().mockImplementation(function (this: unknown) {
    const worker = new FakeWorker(() => {
      throw new DOMException('could not be cloned', 'DataCloneError');
    });
    lastWorker = worker;
    return worker;
  }) as unknown as typeof Worker;
}

describe('WorkerParser.parseColumnar when postMessage itself throws', () => {
  it('terminates the worker instead of leaking it', async () => {
    installThrowingWorker();
    const parser = new WorkerParser();
    const source = new SharedArrayBuffer(8);

    await expect(parser.parseColumnar(source)).rejects.toThrow('could not be cloned');

    expect(lastWorker).not.toBeNull();
    // This is the assertion the pre-fix code fails: the throw inside the
    // Promise executor auto-rejects the promise, but nothing ever calls
    // settle(), so terminate() is never invoked and the worker thread leaks.
    expect(lastWorker!.terminate).toHaveBeenCalledTimes(1);
  });
});
