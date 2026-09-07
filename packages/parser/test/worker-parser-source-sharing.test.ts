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
import { WorkerIndexPublisher } from '../src/worker-index-publication.js';
import { toTransport } from '../src/data-store-transport.js';
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
  /**
   * Parsed once; `toTransport` re-run per message below. Parsing per test put
   * enough load on a two-core CI runner to push a neighbouring suite in this
   * package past its timeout.
   */
  let parsed: Awaited<ReturnType<IfcParser['parseColumnar']>>;
  const originalWorker = (globalThis as { Worker?: unknown }).Worker;

  beforeAll(async () => {
    parsed = await new IfcParser().parseColumnar(
      new TextEncoder().encode(STEP).buffer as ArrayBuffer,
      { disableWorkerScan: true },
    );
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
  async function runStreamingParse(prepared = false): Promise<{ partial: IfcDataStore; final: IfcDataStore }> {
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

    // A fresh payload per message, honouring the docblock above: the real
    // worker posts two independent DataStoreTransports, and reusing one object
    // would be a shape the product never produces.
    const earlyPayload = toTransport(parsed).payload;
    if (prepared) earlyPayload.sourceContentKey = 'worker-precomputed-source-key';
    worker.deliver({ id, type: 'partial-store', payload: earlyPayload });
    worker.deliver({ id, type: 'complete', payload: toTransport(parsed).payload, memory: undefined });

    const final = await done;
    if (partial === null) throw new Error('onSpatialReady never fired');
    return { partial, final };
  }

  // #3985: exercise the real publisher, structured clone, and client hydration;
  // the stub supplies only worker scheduling, never fabricated store results.
  for (const callback of ['absent', 'throws', 'mutates'] as const) {
    it(`retains the private packed seed when the partial callback ${callback} (#3985)`, async () => {
      (globalThis as { Worker?: unknown }).Worker = StubWorker;
      const encoded = new TextEncoder().encode(STEP);
      const source = new SharedArrayBuffer(encoded.length);
      new Uint8Array(source).set(encoded);
      let partial: IfcDataStore | undefined;
      const done = new WorkerParser().parseColumnar(source, {
        onSpatialReady: callback === 'absent' ? undefined : store => {
          partial = store;
          if (callback === 'throws') throw new Error('consumer callback failure');
          store.entityIndex.byType.get('IFCWALL')!.push(999);
          store.entityIndex.byId.get(1)!.byteOffset = 0;
        },
      });
      const worker = StubWorker.last!;
      const { id } = worker.posted[0];
      const publisher = new WorkerIndexPublisher(true);
      const early = publisher.serialize(parsed, false);
      worker.deliver({ id, type: 'partial-store', payload: structuredClone(early.payload, { transfer: early.transfers }) });
      publisher.publishedPartial(parsed);
      const final = publisher.serialize(parsed, true);
      worker.deliver({ id, type: 'complete', payload: structuredClone(final.payload), memory: undefined });
      const store = await done;
      expect(store.entityIndex.byType.get('IFCWALL')).toEqual([1]);
      expect(store.getEntity(1)?.attributes).toEqual(parsed.getEntity(1)?.attributes);
      expect(store.entityIndex.byId.get(1)?.byteOffset).toBeGreaterThan(0);
      if (partial) {
        expect(store.source).toBe(partial.source);
        expect(store.entityIndex.byId).not.toBe(partial.entityIndex.byId);
        expect(store.entityIndex.byType.get('IFCWALL')).not.toBe(partial.entityIndex.byType.get('IFCWALL'));
      }
      expect(worker.terminated).toBe(true);
    });
  }

  it('contains malformed partial envelopes and rejects a final missing seed cleanly (#3985)', async () => {
    (globalThis as { Worker?: unknown }).Worker = StubWorker;
    const done = new WorkerParser().parseColumnar(new SharedArrayBuffer(64));
    const worker = StubWorker.last!;
    const { id } = worker.posted[0];
    // No callback: capturing the optional early publication must still stay
    // inside error handling, never leak an uncaught message-handler exception.
    expect(() => worker.deliver({ id, type: 'partial-store', payload: {} })).not.toThrow();
    const publisher = new WorkerIndexPublisher(true);
    publisher.publishedPartial(parsed);
    worker.deliver({ id, type: 'complete', payload: publisher.serialize(parsed, true).payload });
    await expect(done).rejects.toThrow('missing partial publication');
    expect(worker.terminated).toBe(true);
    expect(worker.onmessage).toBeNull();
  });

  it('drops an aborted request seed before another model starts (#3985)', async () => {
    (globalThis as { Worker?: unknown }).Worker = StubWorker;
    const parser = new WorkerParser();
    void parser.parseColumnar(new SharedArrayBuffer(64));
    const abandoned = StubWorker.last!;
    const publisher = new WorkerIndexPublisher(true);
    const early = publisher.serialize(parsed, false);
    abandoned.deliver({ id: abandoned.posted[0].id, type: 'partial-store', payload: structuredClone(early.payload) });
    publisher.publishedPartial(parsed);
    parser.terminate();
    expect(abandoned.terminated).toBe(true);
    expect(abandoned.onmessage).toBeNull();
    const done = parser.parseColumnar(new SharedArrayBuffer(64));
    const current = StubWorker.last!;
    // A new request cannot resolve an index reference using the old model seed.
    current.deliver({ id: current.posted[0].id, type: 'complete', payload: publisher.serialize(parsed, true).payload });
    await expect(done).rejects.toThrow('missing partial publication');
    expect(current.terminated).toBe(true);
  });

  it('rejects a missing publication reference and terminates its worker (#3985)', async () => {
    (globalThis as { Worker?: unknown }).Worker = StubWorker;
    const done = new WorkerParser().parseColumnar(new SharedArrayBuffer(64));
    const worker = StubWorker.last!;
    const publisher = new WorkerIndexPublisher(true);
    publisher.publishedPartial(parsed);
    const final = publisher.serialize(parsed, true);
    worker.deliver({ id: worker.posted[0].id, type: 'complete', payload: final.payload, memory: undefined });
    await expect(done).rejects.toThrow('missing partial publication');
    expect(worker.terminated).toBe(true);
  });

  it('retains the worker fingerprint without hashing on first UI read (#3983)', async () => {
    const { partial, final } = await runStreamingParse(true);
    const expected = 'worker-precomputed-source-key';
    expect(partial.source.toTransferable().contentKey).toBe(expected);
    expect(final.source).toBe(partial.source);
    expect(final.source.toTransferable().contentKey).toBe(expected);
  });

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
