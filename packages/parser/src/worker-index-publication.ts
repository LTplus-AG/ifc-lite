/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from './columnar-parser.js';
import { CompactEntityIndex } from './compact-entity-index.js';
import { compactEntityIndexToColumns, type CompactEntityIndexColumns } from './compact-entity-index-transport.js';
import { fromTransport, toTransport, transportByteSize, type DataStoreTransport } from './data-store-transport.js';
import type { IfcSourceBytes } from './source-bytes.js';

interface PackedIndex {
  format: 'packed-index-v1';
  byId: CompactEntityIndexColumns;
  names: string[];
  offsets: Uint32Array;
  ids: Uint32Array | Float64Array;
}
interface IndexReference { format: 'published-index-v1' }
export type WorkerStorePayload = Omit<DataStoreTransport, 'entityIndex'> & {
  entityIndex: DataStoreTransport['entityIndex'] | PackedIndex | IndexReference;
};

function packIndex(store: IfcDataStore, byId: CompactEntityIndexColumns): PackedIndex {
  const entries = [...store.entityIndex.byType];
  let count = 0;
  let u32 = true;
  for (const [, values] of entries) {
    count += values.length;
    for (const id of values) {
      if (!Number.isInteger(id) || id < 0 || id > 0xffffffff || Object.is(id, -0)) u32 = false;
    }
  }
  if (count > 0xffffffff) throw new Error('Packed byType index exceeds u32 offset capacity');
  // Arbitrary number[] producers retain their numbers, including NaN/-0 and
  // IDs above u32. Canonical parser IDs use the compact representation.
  const ids = u32 ? new Uint32Array(count) : new Float64Array(count);
  const offsets = new Uint32Array(entries.length + 1);
  let offset = 0;
  for (let i = 0; i < entries.length; i++) {
    offsets[i] = offset;
    ids.set(entries[i][1], offset);
    offset += entries[i][1].length;
  }
  offsets[entries.length] = offset;
  return { format: 'packed-index-v1', byId, names: entries.map(([name]) => name), offsets, ids };
}

/** #3985: canonical parser primary columns/byType are immutable after the
 * spatial callback. Deferred atoms get a separate final index. This publisher
 * must not be used by a producer that edits published numeric columns in place.
 * Public receiver arrays and LRU entries are never the retained wire seed.
 */
export class WorkerIndexPublisher {
  private published?: {
    index: IfcDataStore['entityIndex'];
    columns: CompactEntityIndexColumns;
    entries: Array<[string, number[], number]>;
  };

  constructor(private readonly enabled: boolean) {}

  serialize(store: IfcDataStore, final: boolean): { payload: WorkerStorePayload; transfers: Transferable[]; transportBytes: number } {
    // TODO(remove-by: all supported parser-worker clients negotiate packed-index-v1, parser maintainers), #3985.
    if (!this.enabled) {
      const envelope = toTransport(store);
      return { ...envelope, transfers: final ? envelope.transfers : [], transportBytes: transportByteSize(envelope.payload) };
    }
    if (!(store.entityIndex.byId instanceof CompactEntityIndex)) {
      throw new Error('Worker publication requires CompactEntityIndex');
    }
    const byId = compactEntityIndexToColumns(store.entityIndex.byId);
    const previous = this.published;
    const entries = [...store.entityIndex.byType];
    const reference = final && previous && previous.index === store.entityIndex
      && previous.columns.expressIds === byId.expressIds
      && previous.columns.byteOffsets === byId.byteOffsets
      && previous.columns.byteLengths === byId.byteLengths
      && previous.columns.typeIndices === byId.typeIndices
      && previous.columns.typeStrings.length === byId.typeStrings.length
      && previous.columns.typeStrings.every((name, i) => name === byId.typeStrings[i])
      && previous.entries.length === store.entityIndex.byType.size
      && previous.entries.every(([name, values, length], i) => entries[i][0] === name && entries[i][1] === values && values.length === length);
    const envelope = toTransport(store, { byId, byType: [] });
    const entityIndex: PackedIndex | IndexReference = reference
      ? { format: 'published-index-v1' } : packIndex(store, byId);
    const primaryBuffers = new Set<ArrayBufferLike>([
      byId.expressIds.buffer, byId.byteOffsets.buffer, byId.byteLengths.buffer, byId.typeIndices.buffer,
    ]);
    // #3985: even a referenced index keeps its original ABs in this final
    // transfer list. Unreachable transfers detach/dispose worker ownership at
    // successful publication, without adding another main-thread index.
    // This does not promise when the browser reclaims physical backing.
    const transfers = final ? envelope.transfers : [];
    if (entityIndex.format === 'packed-index-v1') transfers.push(entityIndex.ids.buffer as ArrayBuffer, entityIndex.offsets.buffer as ArrayBuffer);
    // Count reachable payload bytes, excluding detached disposal-only backing.
    const transportBytes = transportByteSize(envelope.payload)
      - (reference ? [...primaryBuffers].reduce((sum, buffer) => sum + (buffer instanceof ArrayBuffer ? buffer.byteLength : 0), 0) : 0)
      + (entityIndex.format === 'packed-index-v1' ? entityIndex.ids.byteLength + entityIndex.offsets.byteLength : 0);
    return { payload: { ...envelope.payload, entityIndex }, transfers, transportBytes };
  }

  /** Call only after the partial postMessage succeeds. */
  publishedPartial(store: IfcDataStore): void {
    if (!this.enabled || !(store.entityIndex.byId instanceof CompactEntityIndex)) return;
    this.published = {
      index: store.entityIndex,
      columns: compactEntityIndexToColumns(store.entityIndex.byId),
      entries: [...store.entityIndex.byType].map(([name, values]) => [name, values, values.length]),
    };
  }
}

/** One instance per parse request, never a federation/global cache. */
export class WorkerIndexReceiver {
  private seed?: PackedIndex;

  capturePartial(payload: WorkerStorePayload): void {
    if ('format' in payload.entityIndex && payload.entityIndex.format === 'packed-index-v1') {
      this.seed = payload.entityIndex;
    }
  }

  hydrate(payload: WorkerStorePayload, source: IfcSourceBytes): IfcDataStore {
    const index = payload.entityIndex;
    if (!('format' in index)) return fromTransport({ ...payload, entityIndex: index }, source);
    const packed = index.format === 'published-index-v1' ? this.seed : index;
    if (!packed) throw new Error('Final parser index references a missing partial publication');
    if (packed.offsets.length !== packed.names.length + 1 || packed.offsets[0] !== 0
      || packed.offsets[packed.names.length] !== packed.ids.length) {
      throw new Error('Invalid packed parser index offsets');
    }
    const byType = new Map<string, number[]>();
    for (let i = 0; i < packed.names.length; i++) {
      const start = packed.offsets[i], end = packed.offsets[i + 1];
      if (end < start || end > packed.ids.length || byType.has(packed.names[i])) {
        throw new Error('Invalid packed parser index range or duplicate type');
      }
      const values = new Array<number>(end - start);
      for (let row = start; row < end; row++) values[row - start] = packed.ids[row];
      byType.set(packed.names[i], values);
    }
    return fromTransport({ ...payload, entityIndex: { byId: packed.byId, byType: [] } }, source, byType);
  }

  clear(): void { this.seed = undefined; }
}
