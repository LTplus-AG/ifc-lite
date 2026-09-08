/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #3395: `setEntityIndex` must put the pre-pass's refusal count ON the
 * `set-entity-index` message, on both delivery paths.
 *
 * The geometry pre-pass counts the records it refused for an express id above
 * the u32 bound, and `scanIfcEntities` reports them — but only if the number
 * survives the postMessage between them. It is an optional field on the
 * message, so dropping it is silent: the parse still succeeds, still returns
 * a store, and `oversizedIdCount` reads 0, which is exactly what a clean file
 * looks like. Typecheck cannot see the difference; this can.
 *
 * The queued path matters as much as the live one: `onEntityIndex` can fire
 * before `parseColumnar` has spawned the worker, and that branch rebuilds the
 * payload by hand rather than forwarding the original message.
 *
 * Installs a global `Worker`, so it lives in its own file — see the header of
 * `worker-parser-source-sharing.test.ts` for why that must not leak.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { WorkerParser } from '../src/worker-parser.js';

interface PostedMessage {
  type?: string;
  oversizedIdCount?: number;
  malformedRecordCount?: number;
}

class StubWorker {
  static last: StubWorker | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessageerror: ((e: unknown) => void) | null = null;
  posted: PostedMessage[] = [];

  constructor() {
    StubWorker.last = this;
  }

  postMessage(msg: PostedMessage): void {
    this.posted.push(msg);
  }

  terminate(): void {
    /* nothing to tear down */
  }
}

const originalWorker = (globalThis as { Worker?: unknown }).Worker;

afterEach(() => {
  if (originalWorker === undefined) delete (globalThis as { Worker?: unknown }).Worker;
  else (globalThis as { Worker?: unknown }).Worker = originalWorker;
  StubWorker.last = null;
});

const IDS = new Uint32Array([1, 7]);
const STARTS = new Uint32Array([0, 100]);
const LENGTHS = new Uint32Array([10, 10]);

function entityIndexMessage(worker: StubWorker): PostedMessage {
  const message = worker.posted.find((m) => m.type === 'set-entity-index');
  if (message === undefined) throw new Error('no set-entity-index message was posted');
  return message;
}

describe('WorkerParser.setEntityIndex and the #3395 refusal count', () => {
  it('posts the count with the columns when the worker is already running', () => {
    (globalThis as { Worker?: unknown }).Worker = StubWorker;

    const parser = new WorkerParser({ workerUrl: 'stub://parser.worker' });
    void parser.parseColumnar(new SharedArrayBuffer(64), {});
    const worker = StubWorker.last;
    if (worker === null) throw new Error('WorkerParser did not construct a Worker');

    parser.setEntityIndex(IDS, STARTS, LENGTHS, 4);

    expect(entityIndexMessage(worker).oversizedIdCount).toBe(4);
    parser.terminate();
  });

  it('keeps the count through the queue when it arrives before the worker exists', async () => {
    (globalThis as { Worker?: unknown }).Worker = StubWorker;

    const parser = new WorkerParser({ workerUrl: 'stub://parser.worker' });
    // No parse started yet, so this queues rather than posting.
    parser.setEntityIndex(IDS, STARTS, LENGTHS, 4);
    expect(StubWorker.last).toBeNull();

    void parser.parseColumnar(new SharedArrayBuffer(64), {});
    const worker = StubWorker.last;
    if (worker === null) throw new Error('WorkerParser did not construct a Worker');

    expect(entityIndexMessage(worker).oversizedIdCount).toBe(4);
    parser.terminate();
  });

  it('leaves the field undefined when the caller has no count to give', () => {
    // The other direction: a host on an older pre-pass sends three columns and
    // nothing else, and must not be made to look like it reported zero
    // refusals — `scanIfcEntities` treats the absent field as 0 for its own
    // arithmetic, but the message itself must not invent a claim.
    (globalThis as { Worker?: unknown }).Worker = StubWorker;

    const parser = new WorkerParser({ workerUrl: 'stub://parser.worker' });
    void parser.parseColumnar(new SharedArrayBuffer(64), {});
    const worker = StubWorker.last;
    if (worker === null) throw new Error('WorkerParser did not construct a Worker');

    parser.setEntityIndex(IDS, STARTS, LENGTHS);

    expect(entityIndexMessage(worker).oversizedIdCount).toBeUndefined();
    parser.terminate();
  });
});

/**
 * Issue #3790, the same postMessage and the same two paths, for the other
 * number that cannot be recovered from the columns.
 *
 * Worse than a refusal if it is lost: `oversizedIdCount` going missing costs
 * the caller N records, this costs it every record after the byte the scan
 * stopped at. And it is just as silent -- an optional field on the same
 * message, so a `setEntityIndex` that forwards four arguments instead of five
 * still parses, still returns a store, and still reports a clean load.
 *
 * Both paths are covered for the reason the sibling above gives: the queued
 * branch rebuilds the payload by hand rather than forwarding the original.
 */
describe('WorkerParser.setEntityIndex and the #3790 malformed-record stop', () => {
  it('posts the stop with the columns when the worker is already running', () => {
    (globalThis as { Worker?: unknown }).Worker = StubWorker;

    const parser = new WorkerParser({ workerUrl: 'stub://parser.worker' });
    void parser.parseColumnar(new SharedArrayBuffer(64), {});
    const worker = StubWorker.last;
    if (worker === null) throw new Error('WorkerParser did not construct a Worker');

    parser.setEntityIndex(IDS, STARTS, LENGTHS, 4, 1);

    expect(entityIndexMessage(worker).malformedRecordCount).toBe(1);
    // Both numbers ride the same message and are independently droppable, so
    // a forward that keeps one and loses the other must not pass.
    expect(entityIndexMessage(worker).oversizedIdCount).toBe(4);
    parser.terminate();
  });

  it('keeps the stop through the queue when it arrives before the worker exists', () => {
    (globalThis as { Worker?: unknown }).Worker = StubWorker;

    const parser = new WorkerParser({ workerUrl: 'stub://parser.worker' });
    // No parse started yet, so this queues rather than posting.
    parser.setEntityIndex(IDS, STARTS, LENGTHS, 4, 1);
    expect(StubWorker.last).toBeNull();

    void parser.parseColumnar(new SharedArrayBuffer(64), {});
    const worker = StubWorker.last;
    if (worker === null) throw new Error('WorkerParser did not construct a Worker');

    expect(entityIndexMessage(worker).malformedRecordCount).toBe(1);
    expect(entityIndexMessage(worker).oversizedIdCount).toBe(4);
    parser.terminate();
  });

  it('leaves the field undefined when the pre-pass reported no stop', () => {
    // A producer that said nothing must not be made to say "clean". Today that
    // is EVERY producer: no wasm build sets the offset until #3699 lands, so if
    // this hop invented a 0 the whole chain's absent-is-not-clean contract
    // would end here.
    (globalThis as { Worker?: unknown }).Worker = StubWorker;

    const parser = new WorkerParser({ workerUrl: 'stub://parser.worker' });
    void parser.parseColumnar(new SharedArrayBuffer(64), {});
    const worker = StubWorker.last;
    if (worker === null) throw new Error('WorkerParser did not construct a Worker');

    parser.setEntityIndex(IDS, STARTS, LENGTHS, 0);

    expect(entityIndexMessage(worker).malformedRecordCount).toBeUndefined();
    parser.terminate();
  });
});
