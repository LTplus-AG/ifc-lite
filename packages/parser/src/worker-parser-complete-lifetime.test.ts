/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IfcParser } from './index.js';
import { WorkerParser } from './worker-parser.js';
import { WorkerIndexPublisher, WorkerIndexReceiver, type WorkerStorePayload } from './worker-index-publication.js';
import type { IfcDataStore } from './columnar-parser.js';

class BoundaryWorker {
  static latest: BoundaryWorker;
  id = '';
  terminated = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  constructor() { BoundaryWorker.latest = this; }
  postMessage(message: { type: string; id?: string }) {
    if (message.type === 'parse') this.id = message.id!;
  }
  terminate() { this.terminated = true; }
  emit(type: string, payload?: WorkerStorePayload, id = this.id) {
    this.onmessage?.({ data: { type, id, payload,
      memory: { transportBytes: 0, sourceBytes: 0, parseTimeMs: 0 } } });
  }
}

beforeEach(() => { vi.stubGlobal('Worker', BoundaryWorker); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function publication() {
  const bytes = new TextEncoder().encode('ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n'
    + "#1=IFCWALL('0YvCT2_$X3_xJG3rzD8L_8',$,'Wall-A',$,$,$,$,$,$);\n"
    + "#2=IFCPROPERTYSINGLEVALUE('Example',$,IFCLABEL('present'),$);\n"
    + "#3=IFCPROPERTYSET('0YvCT2_$X3_xJG3rzD8L_9',$,'Pset_Example',$,(#2));\n"
    + "#4=IFCRELDEFINESBYPROPERTIES('0YvCT2_$X3_xJG3rzD8L_A',$,$,$,(#1),#3);\n"
    + 'ENDSEC;\nEND-ISO-10303-21;\n');
  const publisher = new WorkerIndexPublisher(true);
  let partial: WorkerStorePayload | undefined;
  const store = await new IfcParser().parseColumnar(bytes.buffer, {
    disableWorkerScan: true, deferPropertyAtomIndex: true,
    onSpatialReady: value => {
      const envelope = publisher.serialize(value, false);
      partial = structuredClone(envelope.payload, { transfer: envelope.transfers });
      publisher.publishedPartial(value);
    },
  });
  const properties = store.getProperties(1);
  expect(properties.length).toBeGreaterThan(0);
  const envelope = publisher.serialize(store, true);
  const final = structuredClone(envelope.payload, { transfer: envelope.transfers });
  expect(final.entityIndex).toEqual({ format: 'published-index-v1' });
  const source = new SharedArrayBuffer(bytes.length);
  new Uint8Array(source).set(bytes);
  return { source, partial: partial!, final, properties };
}

describe('completed parser ownership (#3985)', () => {
  it.each([false, true])('terminates before real hydration and preserves the seed, callback=%s', async callback => {
    const fixture = await publication();
    let partial: IfcDataStore | undefined;
    const parser = new WorkerParser();
    const pending = parser.parseColumnar(fixture.source, {
      onSpatialReady: callback ? value => { partial = value; } : undefined,
      onMemorySnapshot: () => expect(BoundaryWorker.latest.terminated).toBe(true),
    });
    const worker = BoundaryWorker.latest;
    worker.emit('complete', fixture.final, 'stale-request');
    expect(worker.terminated).toBe(false);
    worker.emit('partial-store', fixture.partial);
    const original = WorkerIndexReceiver.prototype.hydrate;
    vi.spyOn(WorkerIndexReceiver.prototype, 'hydrate').mockImplementation(function (this: WorkerIndexReceiver, payload, source) {
      expect(worker.terminated).toBe(true);
      return original.call(this, payload, source);
    });
    worker.emit('complete', fixture.final);
    const result = await pending;
    expect(result.getProperties(1)).toEqual(fixture.properties);
    expect(result.deferredEntityIndex?.get(2)).toBeDefined();
    expect(result.entityIndex.byId.get(3)?.type).toBe('IFCPROPERTYSET');
    if (partial) expect(result.source).toBe(partial.source);
    expect(result.source.slice(0, fixture.source.byteLength)).toEqual(new Uint8Array(fixture.source));
    expect(worker.onmessage).toBeNull();
    parser.terminate();
  });

  it('rejects a final missing its index seed after releasing the sender', async () => {
    const fixture = await publication();
    const pending = new WorkerParser().parseColumnar(fixture.source);
    const worker = BoundaryWorker.latest;
    worker.emit('complete', fixture.final);
    await expect(pending).rejects.toThrow('missing partial publication');
    expect(worker.terminated).toBe(true);
    expect(worker.onmessage).toBeNull();
  });

  it('continues after partial callback failure and rejects a final callback failure', async () => {
    const fixture = await publication();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pending = new WorkerParser().parseColumnar(fixture.source, {
      onSpatialReady: () => { throw new Error('partial consumer failed'); },
      onMemorySnapshot: () => { throw new Error('memory consumer failed'); },
    });
    const worker = BoundaryWorker.latest;
    worker.emit('partial-store', fixture.partial);
    expect(warning).toHaveBeenCalledOnce();
    worker.emit('complete', fixture.final);
    await expect(pending).rejects.toThrow('memory consumer failed');
    expect(worker.terminated).toBe(true);
    expect(worker.onmessage).toBeNull();
  });
});
