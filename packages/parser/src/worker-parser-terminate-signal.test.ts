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
  static instances: BoundaryWorker[] = [];
  id = '';
  terminated = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  constructor() {
    BoundaryWorker.latest = this;
    BoundaryWorker.instanceCount += 1;
    BoundaryWorker.instances.push(this);
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
  BoundaryWorker.instances = [];
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

/**
 * Observe whether a promise has settled without real timers: the tracker's
 * reactions are queued before the drain below, so a promise that is already
 * settled (or settles during it) flips the flag by the time `drain` returns.
 */
function track(promise: Promise<unknown>) {
  const state = { settled: false };
  promise.then(
    () => { state.settled = true; },
    () => { state.settled = true; },
  );
  return state;
}
async function drain() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe('WorkerParser overlapping parseColumnar requests (#4908 review)', () => {
  // Pre-fix, the canceller lived in one shared field that the LATER request
  // overwrote, and either request's settle() nulled it. Aborting the first
  // request's signal therefore killed the second request's worker (rejecting
  // it with the first request's reason) while the first kept running.
  it("aborting one request's signal rejects only that request", async () => {
    const parser = new WorkerParser();
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const a = parser.parseColumnar(new SharedArrayBuffer(8), { signal: controllerA.signal });
    const b = parser.parseColumnar(new SharedArrayBuffer(8), { signal: controllerB.signal });
    const [workerA, workerB] = BoundaryWorker.instances;
    const bState = track(b);

    const reasonA = new Error('A superseded');
    controllerA.abort(reasonA);

    await expect(a).rejects.toBe(reasonA);
    expect(workerA.terminated).toBe(true);
    await drain();
    expect(bState.settled).toBe(false);
    expect(workerB.terminated).toBe(false);

    // B's canceller survived A's settlement: its own signal still cancels it.
    const reasonB = new Error('B superseded');
    controllerB.abort(reasonB);
    await expect(b).rejects.toBe(reasonB);
    expect(workerB.terminated).toBe(true);
  });

  it("aborting the later request leaves the earlier one running and still cancellable", async () => {
    const parser = new WorkerParser();
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const a = parser.parseColumnar(new SharedArrayBuffer(8), { signal: controllerA.signal });
    const b = parser.parseColumnar(new SharedArrayBuffer(8), { signal: controllerB.signal });
    const [workerA, workerB] = BoundaryWorker.instances;
    const aState = track(a);

    controllerB.abort();
    await expect(b).rejects.toMatchObject({ name: 'AbortError' });
    expect(workerB.terminated).toBe(true);
    await drain();
    expect(aState.settled).toBe(false);
    expect(workerA.terminated).toBe(false);

    // A still reaches its own settlement path: a worker error rejects A.
    workerA.onmessage?.({ data: { type: 'error', id: workerA.id, message: 'A failed' } });
    await expect(a).rejects.toThrow('A failed');
  });

  it('terminate() rejects every in-flight request with an AbortError', async () => {
    const parser = new WorkerParser();
    const a = parser.parseColumnar(new SharedArrayBuffer(8));
    const b = parser.parseColumnar(new SharedArrayBuffer(8));
    const [workerA, workerB] = BoundaryWorker.instances;

    parser.terminate();

    await expect(a).rejects.toMatchObject({ name: 'AbortError' });
    await expect(b).rejects.toMatchObject({ name: 'AbortError' });
    expect(workerA.terminated).toBe(true);
    expect(workerB.terminated).toBe(true);
  });

  it('terminate() still cancels a request after an overlapping one settled', async () => {
    const parser = new WorkerParser();
    const a = parser.parseColumnar(new SharedArrayBuffer(8));
    const b = parser.parseColumnar(new SharedArrayBuffer(8));
    const [workerA, workerB] = BoundaryWorker.instances;

    workerA.onmessage?.({ data: { type: 'error', id: workerA.id, message: 'A failed' } });
    await expect(a).rejects.toThrow('A failed');

    parser.terminate();
    await expect(b).rejects.toMatchObject({ name: 'AbortError' });
    expect(workerB.terminated).toBe(true);
  });
});
