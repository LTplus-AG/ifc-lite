/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RetainedEngine } from '../../../../../packages/wasm/retained.js';
import { convertMeshCollectionToBatch } from '../../../../../packages/geometry/src/geometry-coordinate';
import { calculateMeshBounds } from '../../utils/localParsingUtils';
import { faceRows } from './retainedFaces';
import type { RetainedHostEvent, RetainedHostResponse, RetainedSessionEvent } from './retained-protocol';

type Published = Extract<RetainedHostEvent, { kind: 'published' }>;
type Encode = RetainedEngine['encodeInstancedShard'];
const FLUSH_PRODUCTS = 256;

/** Owns at most one 256-product window. Ineligible products stream immediately. */
export class RetainedInstancing {
  private pending: Published[] = [];
  private products = 0;
  private rtc: Float64Array = new Float64Array(3);

  constructor(private readonly encode: Encode, private readonly runId: number,
    private readonly send: (event: RetainedHostResponse, transfer: Transferable[]) => void) {}

  event(event: RetainedSessionEvent): void {
    if (event.kind === 'published') {
      if (!('meshes' in event)) throw new Error('Retained session published shape parts on a view run');
      // The converter frees all WASM handles even if extraction throws.
      this.accept({ ...event, meshes: convertMeshCollectionToBatch(event.meshes) });
    } else this.accept(event);
  }

  accept(event: Extract<RetainedHostEvent, { kind: 'start' | 'published' | 'refused' }>): void {
    if (event.kind === 'start') this.rtc = event.frame.rtcOffset;
    if (event.kind === 'published') {
      if (event.instanceKey && event.instanceWorldFromObject && event.meshes.length === 1) {
        this.pending.push(event);
        this.emit({ kind: 'progress' }); // Keep the product watchdog alive while candidates wait.
      }
      else this.emit(event);
    } else this.emit(event);
    if (event.kind !== 'start' && ++this.products === FLUSH_PRODUCTS) {
      this.flush();
      this.products = 0;
    }
  }

  flush(): void {
    if (!this.pending.length) return;
    const pending = this.pending;
    // Clear before encoding/emission so a throwing consumer cannot replay a shard.
    this.pending = [];
    const encoded = this.encode(pending.map(event => ({ ...event.meshes[0],
      ifcType: event.meshes[0].ifcType ?? event.ifcType,
      worldFromObject: event.instanceWorldFromObject! })), pending.map(event => event.instanceKey!), this.rtc);
    const flat = new Set(encoded.flatIndices);
    const grouped = pending.filter((_, index) => !flat.has(index));
    // A partial encoder result cannot publish product rows without geometry.
    if (encoded.instanceCount !== grouped.length) {
      for (const event of pending) this.emit(event);
      return;
    }
    for (const [index, event] of pending.entries()) if (flat.has(index)) this.emit(event);
    if (grouped.length) {
      // One message owns the entire shard and every product it renders. Cancel
      // cannot receive geometry while dropping the remaining publication rows.
      this.emit({ ...grouped[0], meshes: [], meshCount: grouped.length,
        bounds: calculateMeshBounds(grouped.flatMap(event => event.meshes)).bounds,
        instanceProducts: grouped.map(({ meshes, ...product }) => ({ ...product,
          ...(product.faces ? { faceRows: faceRows(product.faces, meshes) } : {}) })),
        instancedShards: [encoded.shard.buffer as ArrayBuffer] });
    }
  }

  private emit(event: RetainedHostEvent): void {
    const buffers = new Set<ArrayBuffer>();
    if (event.kind === 'published') {
      for (const mesh of event.meshes) {
        for (const array of [mesh.positions, mesh.normals, mesh.indices, mesh.uvs, mesh.texture?.rgba]) {
          if (array?.buffer instanceof ArrayBuffer) buffers.add(array.buffer);
        }
      }
      for (const shard of event.instancedShards ?? []) buffers.add(shard);
    }
    this.send({ ...event, runId: this.runId }, [...buffers]);
  }
}
