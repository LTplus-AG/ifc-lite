/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4896: `terminate()` detached the worker's handlers and killed it, but
 * never settled the promise `parseColumnar` returned. That promise only
 * ever settled on `complete`/`error`/`onerror`/`onmessageerror` — none of
 * which fire once the worker is dead — so the documented "call terminate()
 * to cancel an in-flight parse" path hung the caller's `await` forever.
 *
 * `BoundaryWorker` below never emits any message on its own: `postMessage`
 * just records the request id. That means the promise returned by
 * `parseColumnar` is provably still pending at the moment `terminate()` (or
 * `signal.abort()`) is called — nothing else in the test could have settled
 * it first — and, pre-fix, nothing ever would settle it: awaiting it hangs
 * until vitest's test timeout fires, not a synchronous assertion failure.
 * No real timers are used anywhere in this file; every step is synchronous
 * message-pump control, so there is no window for a spurious pass.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerParser } from './worker-parser.js';

class BoundaryWorker {
  static latest: BoundaryWorker | null = null;
  static instanceCount = 0;
  id = '';
  terminated = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  constructor() {
    BoundaryWorker.latest = this;
    BoundaryWorker.instanceCount += 1;
  }
  postMessage(message: { type: string; id?: string }) {
    if (message.type === 'parse') this.id = message.id!;
  }
  terminate() {
    this.terminated = true;
  }
}

beforeEach(() => {
  vi.stubGlobal('Worker', BoundaryWorker);
  BoundaryWorker.latest = null;
  BoundaryWorker.instanceCount = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('WorkerParser.terminate() settling the in-flight promise (#4896)', () => {
  it('rejects with an AbortError instead of leaving the promise pending forever', async () => {
    const parser = new WorkerParser();
    const source = new SharedArrayBuffer(8);
    const pending = parser.parseColumnar(source);

    // Nothing has emitted 'complete'/'error' and no timer exists anywhere in
    // this test — the only thing that can settle `pending` at this point is
    // the fix under test. This is the genuinely-in-flight guarantee.
    const worker = BoundaryWorker.latest!;
    expect(worker.terminated).toBe(false);

    parser.terminate();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminated).toBe(true);
  });

  it('is a no-op-safe to call terminate() again after settlement', async () => {
    const parser = new WorkerParser();
    const pending = parser.parseColumnar(new SharedArrayBuffer(8));
    parser.terminate();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    // Second call must not throw and must not re-invoke a stale reject.
    expect(() => parser.terminate()).not.toThrow();
  });

  it('lets a fresh parseColumnar spawn a new worker after a terminated one', async () => {
    const parser = new WorkerParser();
    const first = parser.parseColumnar(new SharedArrayBuffer(8));
    parser.terminate();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });

    parser.parseColumnar(new SharedArrayBuffer(8));
    expect(BoundaryWorker.instanceCount).toBe(2);
  });
});

describe('WorkerParser.parseColumnar signal support (#4896)', () => {
  it('rejects immediately without spawning a worker when the signal is already aborted', async () => {
    const parser = new WorkerParser();
    const controller = new AbortController();
    controller.abort(new Error('cancelled before start'));

    await expect(
      parser.parseColumnar(new SharedArrayBuffer(8), { signal: controller.signal }),
    ).rejects.toThrow('cancelled before start');

    expect(BoundaryWorker.instanceCount).toBe(0);
  });

  it('rejects an in-flight parse with the abort reason and terminates the worker', async () => {
    const parser = new WorkerParser();
    const controller = new AbortController();
    const pending = parser.parseColumnar(new SharedArrayBuffer(8), { signal: controller.signal });
    const worker = BoundaryWorker.latest!;
    expect(worker.terminated).toBe(false);

    const reason = new Error('load superseded');
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(worker.terminated).toBe(true);
  });

  it('does not react to abort after the parse already settled', async () => {
    const parser = new WorkerParser();
    const controller = new AbortController();
    const pending = parser.parseColumnar(new SharedArrayBuffer(8), { signal: controller.signal });
    const worker = BoundaryWorker.latest!;
    worker.onmessage?.({
      data: {
        type: 'error',
        id: worker.id,
        message: 'boom',
      },
    });
    await expect(pending).rejects.toThrow('boom');

    // Aborting now must not throw and must not affect a later request.
    expect(() => controller.abort(new Error('too late'))).not.toThrow();
  });
});
