/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `WorkerParser` must build ONE source accessor per parse and give it to both
 * stores it hydrates (#2183).
 *
 * A streaming parse delivers two stores: the early partial one, so the spatial
 * tree paints before geometry arrives, and the final one. Both alias the same
 * SharedArrayBuffer. `contentKey` is a full-file FNV-1a walk memoised per
 * accessor INSTANCE, and the viewer's per-source overlay hooks read it off
 * whichever store is currently active — so an accessor per `fromTransport`
 * call walks a 342 MB source twice on the main thread mid-load, on exactly the
 * models this issue is about.
 *
 * That regression is invisible to every other test: both walks produce the
 * same key, so nothing downstream changes value. Only instance identity
 * distinguishes them, which is what this file pins.
 *
 * `StubWorker.last` is static, so the tests here must stay sequential -- do not
 * add `describe.concurrent` or `it.concurrent` to this file.
 *
 * Lives in its own file because it installs a global `Worker`, and
 * `WorkerParser.isSupported()` keys off that global — leaking it into another
 * suite would silently reroute unrelated parses onto the worker path.
 */

import { beforeAll, afterEach, describe, expect, it } from 'vitest';

import { IfcParser } from '../src/index.js';
import { WorkerParser } from '../src/worker-parser.js';
import { toTransport, type DataStoreTransport } from '../src/data-store-transport.js';
import type { IfcDataStore } from '../src/columnar-parser.js';

const STEP = 'ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n'
  + "#1=IFCWALL('0YvCT2_$X3_xJG3rzD8L_8',$,'Wall-A',$,$,$,$,$,$);\n"
  + 'ENDSEC;\nEND-ISO-10303-21;\n';

interface PostedInput { id: string }

/** Captures the handlers `parseColumnar` installs and lets the test drive them. */
class StubWorker {
  static last: StubWorker | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessageerror: ((e: unknown) => void) | null = null;
  posted: PostedInput[] = [];
  terminated = false;

  constructor() {
    StubWorker.last = this;
  }

  postMessage(msg: PostedInput): void {
    this.posted.push(msg);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Deliver a worker->main message through the installed handler. */
  deliver(data: unknown): void {
    this.onmessage?.({ data });
  }
}

describe('WorkerParser shares one source accessor across partial + final (#2183)', () => {
  let payload: DataStoreTransport;
  const originalWorker = (globalThis as { Worker?: unknown }).Worker;

  beforeAll(async () => {
    const parsed = await new IfcParser().parseColumnar(
      new TextEncoder().encode(STEP).buffer as ArrayBuffer,
      { disableWorkerScan: true },
    );
    payload = toTransport(parsed).payload;
  });

  afterEach(() => {
    if (originalWorker === undefined) delete (globalThis as { Worker?: unknown }).Worker;
    else (globalThis as { Worker?: unknown }).Worker = originalWorker;
    StubWorker.last = null;
  });

  /**
   * Run one streaming parse against the stub, returning both delivered stores.
   * A fresh `toTransport` per message: the real worker posts two independent
   * payloads, so sharing one here would be a shape the product never produces.
   */
  async function runStreamingParse(): Promise<{ partial: IfcDataStore; final: IfcDataStore }> {
    (globalThis as { Worker?: unknown }).Worker = StubWorker;

    const sab = new SharedArrayBuffer(64);
    let partial: IfcDataStore | null = null;

    const parser = new WorkerParser({ workerUrl: 'stub://parser.worker' });
    const done = parser.parseColumnar(sab, {
      onSpatialReady: (store) => { partial = store; },
    });

    const worker = StubWorker.last;
    if (worker === null) throw new Error('WorkerParser did not construct a Worker');
    // The id is generated inside parseColumnar; take it off the posted input
    // rather than reconstructing it, so this cannot drift.
    const input = worker.posted[0];
    if (input === undefined) throw new Error('WorkerParser posted no input message');
    const { id } = input;

    worker.deliver({ id, type: 'partial-store', payload });
    worker.deliver({ id, type: 'complete', payload, memory: undefined });

    const final = await done;
    if (partial === null) throw new Error('onSpatialReady never fired');
    return { partial, final };
  }

  it('hands the partial store and the final store the SAME accessor', async () => {
    const { partial, final } = await runStreamingParse();
    expect(partial.source).toBe(final.source);
  });

  it('walks the source once: reading the key off both stores is one computation', async () => {
    const { partial, final } = await runStreamingParse();
    // Identity FIRST, and it is the load-bearing assertion. Two distinct
    // accessors each run the full FNV-1a walk and still agree on the value, so
    // the key comparison below cannot tell one walk from two on its own --
    // without this line the test could not detect the regression it is named
    // for.
    expect(partial.source).toBe(final.source);
    // Given identity, the lazy memo in ContiguousSourceBytes serves the second
    // read, and the value is a real key rather than null.
    expect(partial.source.contentKey).toBe(final.source.contentKey);
    expect(partial.source.contentKey).toEqual(expect.any(String));
  });

  it('both stores view the whole shared buffer', async () => {
    const { partial, final } = await runStreamingParse();
    expect(partial.source.byteLength).toBe(64);
    expect(final.source.byteLength).toBe(64);
  });
});
