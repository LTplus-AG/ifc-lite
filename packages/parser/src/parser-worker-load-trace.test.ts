/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6979: the parser worker records its own phases once the host enables
 * tracing, and posts them BEFORE `complete` (the host terminates the worker on
 * receipt, so anything posted after it is lost). Drives the real
 * `parser.worker.ts` with the same `self` polyfill and cache-busted import as
 * `parser-worker-malformed-handoff.test.ts`; `WorkerParser`'s half (enable,
 * merge under `parser.worker`, hydrate spans) runs against a synthetic Worker.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLoadTracer, enableWorkerTrace, isTraceSpansMessage } from '@ifc-lite/load-trace';
import { IfcParser } from './index.js';
import { WorkerParser } from './worker-parser.js';
import { WorkerIndexPublisher, type WorkerStorePayload } from './worker-index-publication.js';

const IFC = [
  'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');", "FILE_NAME('t','',(''),(''),'','','');",
  "FILE_SCHEMA(('IFC4'));", 'ENDSEC;', 'DATA;',
  "#1=IFCPROJECT('0000000000000000000001',$,'P',$,$,$,$,$,$);",
  "#2=IFCWALL('0000000000000000000002',$,'Wall2',$,$,$,$,$,$);",
  'ENDSEC;', 'END-ISO-10303-21;', '',
].join('\n');

/** The entity index a pre-pass hands over, so the worker never compiles wasm (which cannot load under vitest). */
function entityIndex() {
  const records = IFC.split('\n').filter((line) => line.startsWith('#'));
  return {
    type: 'set-entity-index',
    ids: Uint32Array.from(records.map((r) => Number(r.slice(1, r.indexOf('='))))),
    starts: Uint32Array.from(records.map((r) => IFC.indexOf(r))),
    lengths: Uint32Array.from(records.map((r) => r.length)),
    oversizedIdCount: 0,
    malformedRecordCount: 0,
  };
}

function sharedSource(): SharedArrayBuffer {
  const bytes = new TextEncoder().encode(IFC);
  const sab = new SharedArrayBuffer(bytes.byteLength);
  new Uint8Array(sab).set(bytes);
  return sab;
}

const posted: unknown[] = [];
const typeOf = (m: unknown) => (m as { type?: string }).type;
let importCounter = 0;
let originalSelf: unknown;
let originalPostMessage: unknown;

function post(data: unknown): void {
  (self as unknown as Worker).onmessage!({ data } as unknown as MessageEvent);
}

async function settle(): Promise<void> {
  await vi.waitFor(() => {
    const types = posted.map(typeOf);
    if (!types.includes('complete') && !types.includes('error')) throw new Error(`worker has not settled: saw [${types.join(', ')}]`);
  }, { timeout: 20_000, interval: 1 });
}

describe('parser.worker.ts load-trace spans (#6979)', () => {
  beforeEach(async () => {
    posted.length = 0;
    const g = globalThis as Record<string, unknown>;
    originalSelf = g.self;
    originalPostMessage = g.postMessage;
    g.self = globalThis;
    g.postMessage = (msg: unknown) => posted.push(msg);
    importCounter += 1;
    await import('./parser.worker.js?t=' + importCounter);
  }, 30_000);

  afterEach(() => {
    const g = globalThis as Record<string, unknown>;
    if (originalSelf === undefined) delete g.self; else g.self = originalSelf;
    if (originalPostMessage === undefined) delete g.postMessage; else g.postMessage = originalPostMessage;
  });

  it('#7036 an entity-index handoff completes while shared compilation never resolves', async () => {
    post({ type: 'parse', id: 'pending-module', source: sharedSource(), waitForEntityIndex: true, waitForWasmModule: true });
    post(entityIndex());
    await settle();
    expect(posted.map(typeOf)).not.toContain('error');
    const complete = posted.find(message => typeOf(message) === 'complete') as { id: string; payload: WorkerStorePayload };
    expect(complete.id).toBe('pending-module');
    expect(complete.payload.entityCount).toBe(2);
    // No module control message is delivered: successful metadata publication is the behavioral oracle.
  }, 30_000);

  it('posts its phase spans ahead of `complete` once enabled', async () => {
    const trace = createLoadTracer({ enabled: true, sink: null }).startLoad('m');
    enableWorkerTrace({ postMessage: post }, trace, 'parser');
    post(entityIndex());
    post({ type: 'parse', id: 'req-1', source: sharedSource(), waitForEntityIndex: true });
    await settle();

    const types = posted.map(typeOf);
    expect(types).not.toContain('error');
    const lastSpans = types.lastIndexOf('load-trace:spans');
    expect(lastSpans).toBeGreaterThanOrEqual(0);
    expect(lastSpans).toBeLessThan(types.indexOf('complete'));

    const spans = posted.filter(isTraceSpansMessage).flatMap((m) => m.payload.spans);
    expect(posted.filter(isTraceSpansMessage).every((m) => m.payload.thread === 'parser')).toBe(true);
    const names = spans.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining([
      'parser.parse', 'parser.entityIndexWait', 'parser.spatialReady.serialize', 'parser.transport.serialize',
      'columnar.building-entities', 'columnar.building-hierarchy',
    ]));
    expect(names).not.toContain('columnar.complete');
    const parse = spans.find((s) => s.name === 'parser.parse')!;
    expect(parse.attrs).toEqual({ entities: 2 });
    for (const s of spans) {
      expect(s.end).toBeGreaterThanOrEqual(s.start);
      expect(s.start).toBeGreaterThanOrEqual(parse.start);
      expect(s.end).toBeLessThanOrEqual(parse.end);
    }
  }, 30_000);

  it('posts no spans when the host never enabled tracing', async () => {
    post(entityIndex());
    post({ type: 'parse', id: 'req-2', source: sharedSource(), waitForEntityIndex: true });
    await settle();
    expect(posted.map(typeOf)).toContain('complete');
    expect(posted.some(isTraceSpansMessage)).toBe(false);
  }, 30_000);
});

class TraceWorker {
  static latest: TraceWorker;
  sent: unknown[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  constructor() { TraceWorker.latest = this; }
  postMessage(message: unknown) { this.sent.push(message); }
  terminate() {}
  get id() { return (this.sent.find((m) => typeOf(m) === 'parse') as { id: string }).id; }
  emit(data: unknown) { this.onmessage?.({ data }); }
}

describe('WorkerParser load-trace wiring (#6979)', () => {
  beforeEach(() => { vi.stubGlobal('Worker', TraceWorker); });
  afterEach(() => { vi.unstubAllGlobals(); });

  async function finalPayload(): Promise<WorkerStorePayload> {
    const bytes = new TextEncoder().encode(IFC);
    const store = await new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
    const envelope = new WorkerIndexPublisher(true).serialize(store, true);
    return structuredClone(envelope.payload, { transfer: envelope.transfers });
  }

  it('enables the worker before `parse` and nests its spans and the hydrate under `parser.worker`', async () => {
    const tracer = createLoadTracer({ enabled: true, sink: null });
    const trace = tracer.startLoad('m');
    const payload = await finalPayload();
    const done = new WorkerParser().parseColumnar(sharedSource(), { trace });
    const worker = TraceWorker.latest;
    expect(worker.sent.map(typeOf)).toEqual(['load-trace:enable', 'parse']);
    expect(worker.sent[0]).toEqual({ type: 'load-trace:enable', thread: 'parser' });

    worker.emit({ type: 'load-trace:spans', payload: { thread: 'parser', timeOrigin: performance.timeOrigin, spans: [
      { name: 'parser.parse', start: performance.now(), end: performance.now() },
    ] } });
    worker.emit({ type: 'complete', id: worker.id, payload, memory: { transportBytes: 0, sourceBytes: 0, parseTimeMs: 0 } });
    await done;

    const spans = tracer.latest()!.spans;
    const root = spans.find((s) => s.name === 'parser.worker')!;
    expect(root.end).not.toBeNull();
    expect(spans.find((s) => s.name === 'parser.parse')).toMatchObject({ thread: 'parser', parentId: root.id });
    expect(spans.find((s) => s.name === 'parser.hydrate')).toMatchObject({ thread: 'main' });
    expect(spans.find((s) => s.name === 'parser.hydrate')!.end).not.toBeNull();
  });

  it('sends no enable request for an untraced parse', () => {
    void new WorkerParser().parseColumnar(sharedSource(), {});
    expect(TraceWorker.latest.sent.map(typeOf)).toEqual(['parse']);
  });
});
