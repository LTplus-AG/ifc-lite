/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Reopen lane, step 2 (#9728 follow-up): a cache hit inflates its compressed
// geometry chunks on workers instead of the main thread.
import { describe, expect, it } from 'vitest';
import type { MeshData, CoordinateInfo } from '@ifc-lite/geometry';
import { buildGeometrySectionV13, openGeometryChunksV13 } from '../sections/geometry-chunks.js';
import { FORMAT_VERSION, GeometryChunkFlags } from '../types.js';
import { ChunkInflatePool } from './chunk-inflate-pool.js';
import { handleCompressionRequest } from './geometry-compression-handler.js';
import type { CompressionWorkerPort } from './geometry-compression-client.js';
import type { CompressionRequest, InflateRequest } from './geometry-compression-protocol.js';

/** The real handler behind real structured-clone transfers, in this thread. */
class CodecPort implements CompressionWorkerPort {
  onmessage: CompressionWorkerPort['onmessage'] = null;
  onerror: CompressionWorkerPort['onerror'] = null;
  onmessageerror: CompressionWorkerPort['onmessageerror'] = null;
  postMessage(message: CompressionRequest | InflateRequest, transfers: ArrayBuffer[]): void {
    const received = structuredClone(message, { transfer: transfers });
    void handleCompressionRequest(received, (response, outgoing) => {
      this.onmessage?.(new MessageEvent('message', { data: structuredClone(response, { transfer: outgoing }) }));
    });
  }
  terminate(): void {}
}

const coordInfo: CoordinateInfo = {
  originShift: { x: 0, y: 0, z: 0 },
  originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
  shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
  hasLargeCoordinates: false,
};

/** Compressible meshes spread over several spatial cells, so the section has several compressed chunks. */
function meshes(): MeshData[] {
  return Array.from({ length: 60 }, (_, i) => {
    const positions = new Float32Array(3000).map((_, k) => (i % 6) * 400 + (k % 9)); // ~250 KB per cell's chunk: above the 64 KB compression floor
    return { expressId: i + 1, positions, normals: new Float32Array(3000).fill(0.5), indices: new Uint32Array(270).map((_, k) => k % 100),
      color: [0.2, 0.4, 0.6, 1], ifcType: 'IfcWall' } as MeshData;
  });
}

async function decodeAll(section: ArrayBuffer, inflate?: ChunkInflatePool['inflate']): Promise<MeshData[]> {
  const open = openGeometryChunksV13(section, 0, FORMAT_VERSION, inflate ? { inflate } : {});
  return (await Promise.all(open.chunks.map((_, i) => open.readChunk(i)))).flat();
}

/** Bounded comparison: per mesh id, positions/normals/indices bytes and colour. */
const digest = (list: MeshData[]) => list.map((m) => [m.expressId, [...new Uint8Array(m.positions.buffer, m.positions.byteOffset, m.positions.byteLength)].join(','),
  m.normals.length, [...m.indices].join(','), m.color.join(',')].join('|'));

class CountingPort extends CodecPort {
  inflates = 0;
  override postMessage(message: CompressionRequest | InflateRequest, transfers: ArrayBuffer[]): void {
    if ('op' in message && message.op === 'inflate') this.inflates++;
    super.postMessage(message, transfers);
  }
}

describe('ChunkInflatePool', () => {
  it('inflates every compressed chunk on its workers, with output identical to inflating here', async () => {
    const section = await buildGeometrySectionV13(meshes(), coordInfo, { compress: true });
    const compressed = openGeometryChunksV13(section, 0, FORMAT_VERSION).chunks.filter((c) => c.flags & GeometryChunkFlags.DeflateRaw).length;
    expect(compressed).toBeGreaterThan(1);
    const ports: CountingPort[] = [];
    const pool = new ChunkInflatePool(2, () => { const p = new CountingPort(); ports.push(p); return p; }).start();
    try {
      expect(ports).toHaveLength(2);
      expect(digest(await decodeAll(section, pool.inflate))).toEqual(digest(await decodeAll(section)));
      expect(ports.reduce((n, p) => n + p.inflates, 0)).toBe(compressed);
      expect(ports.every((p) => p.inflates > 0)).toBe(true);
      expect(pool.inflatingHere).toBe(false);
    } finally {
      pool.close();
    }
  });

  it('falls back to inflating here when a worker fails, without changing the output', async () => {
    const section = await buildGeometrySectionV13(meshes(), coordInfo, { compress: true });
    const pool = new ChunkInflatePool(1, () => { throw new Error('no workers in this context'); }).start();
    expect(pool.inflatingHere).toBe(true);
    expect(digest(await decodeAll(section, pool.inflate))).toEqual(digest(await decodeAll(section)));
  });

  it('refuses a worker reply of the wrong length and decodes correctly here instead', async () => {
    const section = await buildGeometrySectionV13(meshes(), coordInfo, { compress: true });
    class ShortPort extends CodecPort {
      override postMessage(message: CompressionRequest | InflateRequest, transfers: ArrayBuffer[]): void {
        const received = structuredClone(message, { transfer: transfers });
        queueMicrotask(() => this.onmessage?.(new MessageEvent('message', { data: { id: received.id, buffer: new ArrayBuffer(3), compressed: false } })));
      }
    }
    const pool = new ChunkInflatePool(1, () => new ShortPort()).start();
    expect(digest(await decodeAll(section, pool.inflate))).toEqual(digest(await decodeAll(section)));
    expect(pool.inflatingHere).toBe(true);
  });
});
