/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { IfcParser } from '../src/index.js';
import type { IfcDataStore } from '../src/columnar-parser.js';
import { compactEntityIndexToColumns } from '../src/compact-entity-index-transport.js';
import { CompactEntityIndex } from '../src/compact-entity-index.js';
import { WorkerIndexPublisher, WorkerIndexReceiver } from '../src/worker-index-publication.js';
import { toTransport } from '../src/data-store-transport.js';
import { contiguousSourceBytes } from '../src/source-bytes.js';

function source(name = 'Wall-A'): ArrayBuffer {
  return new TextEncoder().encode('ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n'
    + `#1=IFCWALL('0YvCT2_$X3_xJG3rzD8L_8',$,'${name}',$,$,$,$,$,$);\n`
    + "#2=IFCPROPERTYSINGLEVALUE('Example',$,IFCLABEL('present'),$);\n"
    + "#3=IFCPROPERTYSET('0YvCT2_$X3_xJG3rzD8L_9',$,'Pset_Example',$,(#2));\n"
    + "#4=IFCRELDEFINESBYPROPERTIES('0YvCT2_$X3_xJG3rzD8L_A',$,$,$,(#1),#3);\n"
    + 'ENDSEC;\nEND-ISO-10303-21;\n').buffer as ArrayBuffer;
}

describe('immutable worker index publication (#3985)', () => {
  let store: IfcDataStore;
  beforeAll(async () => { store = await new IfcParser().parseColumnar(source(), { disableWorkerScan: true }); });

  it('preserves every generic number and byType insertion/list order', () => {
    const numbers = [0, -0, 0xffffffff, 0x100000000, -1, 1.5, NaN, Infinity, -Infinity];
    const generic = { ...store, entityIndex: { ...store.entityIndex, byType: new Map([
      ['ARBITRARY', numbers], ['SECOND', [3, 1, 3]],
    ]) } };
    const envelope = new WorkerIndexPublisher(true).serialize(generic, true);
    const hydrated = new WorkerIndexReceiver().hydrate(structuredClone(envelope.payload), store.source);
    const actual = hydrated.entityIndex.byType.get('ARBITRARY')!;
    expect(actual.length).toBe(numbers.length);
    numbers.forEach((value, i) => expect(Object.is(actual[i], value)).toBe(true));
    expect([...hydrated.entityIndex.byType.keys()]).toEqual(['ARBITRARY', 'SECOND']);
    expect(hydrated.entityIndex.byType.get('SECOND')).toEqual([3, 1, 3]);
    expect(toTransport(generic).payload.entityIndex.byType[0][1]).toEqual(numbers);
  });

  it('keeps legacy requests/envelopes complete and never references an unpublished index', () => {
    for (const enabled of [false, true]) {
      const envelope = new WorkerIndexPublisher(enabled).serialize(store, true);
      const receiver = new WorkerIndexReceiver();
      const rebuilt = receiver.hydrate(structuredClone(envelope.payload), store.source);
      expect(rebuilt.getEntity(1)).toEqual(store.getEntity(1));
      expect(rebuilt.getProperties(1)).toEqual(store.getProperties(1));
    }
  });

  it('publishes a full index when the canonical primary index is replaced', () => {
    const publisher = new WorkerIndexPublisher(true);
    publisher.publishedPartial(store);
    const columns = compactEntityIndexToColumns(store.entityIndex.byId as CompactEntityIndex);
    const replaced = { ...store, entityIndex: { ...store.entityIndex, byId: new CompactEntityIndex(
      columns.expressIds.slice(), columns.byteOffsets.slice(), columns.byteLengths.slice(),
      columns.typeIndices.slice(), [...columns.typeStrings],
    ) } };
    const final = publisher.serialize(replaced, true);
    const rebuilt = new WorkerIndexReceiver().hydrate(structuredClone(final.payload), store.source);
    expect(rebuilt.getEntity(1)).toEqual(store.getEntity(1));
  });

  it('keeps overlapping model IDs and source accessors isolated across receiver sessions', async () => {
    const other = await new IfcParser().parseColumnar(source('Wall-B'), { disableWorkerScan: true });
    const results = [store, other].map(model => {
      const publisher = new WorkerIndexPublisher(true);
      const receiver = new WorkerIndexReceiver();
      receiver.capturePartial(structuredClone(publisher.serialize(model, false).payload));
      publisher.publishedPartial(model);
      return receiver.hydrate(structuredClone(publisher.serialize(model, true).payload), model.source);
    });
    expect(results[0].getEntity(1)).toEqual(store.getEntity(1));
    expect(results[1].getEntity(1)).toEqual(other.getEntity(1));
    expect(results[0].getEntity(1)).not.toEqual(results[1].getEntity(1));
    expect(results[0].source).not.toBe(results[1].source);
  });

  it('retains complete deferred property/reference access through real transfers', async () => {
    const input = source();
    const publisher = new WorkerIndexPublisher(true);
    const receiver = new WorkerIndexReceiver();
    const sourceBytes = contiguousSourceBytes(new Uint8Array(input));
    let partial: IfcDataStore | undefined;
    const parsed = await new IfcParser().parseColumnar(input, {
      disableWorkerScan: true, deferPropertyAtomIndex: true,
      onSpatialReady: early => {
        const envelope = publisher.serialize(early, false);
        const payload = structuredClone(envelope.payload, { transfer: envelope.transfers });
        receiver.capturePartial(payload);
        partial = receiver.hydrate(payload, sourceBytes);
        publisher.publishedPartial(early);
      },
    });
    const expectedProperties = parsed.getProperties(1);
    expect(expectedProperties.length).toBeGreaterThan(0);
    const workerColumns = compactEntityIndexToColumns(parsed.entityIndex.byId as CompactEntityIndex);
    expect(workerColumns.expressIds.byteLength).toBeGreaterThan(0);
    const envelope = publisher.serialize(parsed, true);
    const finalPayload = structuredClone(envelope.payload, { transfer: envelope.transfers });
    // The final message references main's earlier seed; the original worker
    // backing is disposed by the SAME transfer even though absent from payload.
    for (const column of [workerColumns.expressIds, workerColumns.byteOffsets,
      workerColumns.byteLengths, workerColumns.typeIndices]) expect(column.byteLength).toBe(0);
    const final = receiver.hydrate(finalPayload, sourceBytes);
    expect(final.deferredEntityIndex?.get(2)).toBeDefined();
    expect(final.entityIndex.byId.get(2)).toBeUndefined();
    expect(final.getProperties(1)).toEqual(expectedProperties);
    expect(final.getEntity(3)).toBeDefined();
    expect(partial!.entityIndex.byId.get(1)).toEqual(final.entityIndex.byId.get(1));
    expect(final.source).toBe(partial!.source);
    expect(final.entityIndex.byId).not.toBe(partial!.entityIndex.byId);
  });
});

// Archicad Haus contains real IfcRelDefinesByProperties and property atoms;
// IfcOpenHouse has no property associations and cannot exercise this contract.
const fixture = [
  resolve(__dirname, '../../../tests/models/ara3d/AC20-FZK-Haus.ifc'),
  '/Users/louistrue/Development/ifc-lite-fixtures-wt/tests/models/ara3d/AC20-FZK-Haus.ifc',
].find(existsSync);
if (!fixture) console.warn('skip: immutable transport real IFC fixture missing — run pnpm fixtures');
it.skipIf(!fixture)('retains real-model properties, all references and byType lists (#3985)', async () => {
  const input = Uint8Array.from(readFileSync(fixture!)).buffer;
  const publisher = new WorkerIndexPublisher(true);
  const receiver = new WorkerIndexReceiver();
  const parsed = await new IfcParser().parseColumnar(input, {
    disableWorkerScan: true, deferPropertyAtomIndex: true,
    onSpatialReady: early => {
      receiver.capturePartial(structuredClone(publisher.serialize(early, false).payload));
      publisher.publishedPartial(early);
    },
  });
  const rebuilt = receiver.hydrate(structuredClone(publisher.serialize(parsed, true).payload), parsed.source);
  expect([...rebuilt.entityIndex.byType]).toEqual([...parsed.entityIndex.byType]);
  for (const id of parsed.entityIndex.byId.keys()) expect(rebuilt.getEntity(id)).toEqual(parsed.getEntity(id));
  const propertyIds = [...parsed.onDemandPropertyMap!.keys()];
  expect(propertyIds.length).toBeGreaterThan(0);
  let propertySetCount = 0;
  for (const id of propertyIds) {
    const expected = parsed.getProperties(id);
    propertySetCount += expected.length;
    expect(rebuilt.getProperties(id)).toEqual(expected);
  }
  expect(propertySetCount).toBeGreaterThan(0);
  expect(rebuilt.deferredEntityIndex?.size).toBeGreaterThan(0);
}, 120_000);
