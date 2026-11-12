/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Reopen lane, step 2 (#9728 follow-up): a cache hit inflates its compressed
// geometry chunks on workers instead of the main thread.
import { describe, expect, it } from 'vitest';
import type { MeshData, CoordinateInfo } from '@ifc-lite/geometry';
import { buildGeometrySectionV13, openGeometryChunksV13 } from '../sections/geometry-chunks.js';
import { FORMAT_VERSION, GeometryChunkFlags } from '../types.js';
import { ChunkInflatePool, CorruptChunkError } from './chunk-inflate-pool.js';
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

/** Holds every request unanswered, so a test decides when (and whether) the worker fails. */
class HoldingPort extends CodecPort {
  received = 0;
  terminated = false;
  override postMessage(): void { this.received++; }
  override terminate(): void { this.terminated = true; }
  crash(): void { this.onerror?.(Object.assign(new Event('error'), { message: 'worker crashed', preventDefault() {} }) as unknown as ErrorEvent); }
}

/** The section with one compressed chunk's stored bytes overwritten: its deflate stream no longer decodes. */
function corruptOneChunk(section: ArrayBuffer): ArrayBuffer {
  const copy = section.slice(0);
  const info = openGeometryChunksV13(copy, 0, FORMAT_VERSION).chunks.find((c) => c.flags & GeometryChunkFlags.DeflateRaw)!;
  new Uint8Array(copy, info.byteOffset, info.byteLength).fill(0xff);
  return copy;
}

describe('ChunkInflatePool', () => {
  it('inflates every compressed chunk on its workers, with output identical to inflating here', async () => {
    const section = await buildGeometrySectionV13(meshes(), coordInfo, { compress: true });
    const compressed = openGeometryChunksV13(section, 0, FORMAT_VERSION).chunks.filter((c) => c.flags & GeometryChunkFlags.DeflateRaw).length;
    expect(compressed).toBeGreaterThan(1);
    const ports: CountingPort[] = [];
    const pool = new ChunkInflatePool(2, { createWorker: () => { const p = new CountingPort(); ports.push(p); return p; } }).start();
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

  it('starts no worker until start() or the first compressed chunk', () => {
    let created = 0;
    const pool = new ChunkInflatePool(3, { createWorker: () => { created++; return new CodecPort(); } });
    expect(created).toBe(0);
    pool.close();
  });

  it('a worker that fails with requests in flight: those chunks and the rest inflate here, output unchanged', async () => {
    const section = await buildGeometrySectionV13(meshes(), coordInfo, { compress: true });
    const port = new HoldingPort();
    const pool = new ChunkInflatePool(1, { createWorker: () => port }).start();
    const decoding = decodeAll(section, pool.inflate);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(port.received).toBeGreaterThan(1); // several requests are in flight when it fails
    port.crash();
    expect(digest(await decoding)).toEqual(digest(await decodeAll(section)));
    expect(pool.inflatingHere).toBe(true);
    expect(port.terminated).toBe(true);
  });

  it('a worker that stops answering is given up after stallMs: its chunks inflate here', async () => {
    const section = await buildGeometrySectionV13(meshes(), coordInfo, { compress: true });
    const port = new HoldingPort();
    const pool = new ChunkInflatePool(1, { createWorker: () => port, stallMs: 30 }).start();
    expect(digest(await decodeAll(section, pool.inflate))).toEqual(digest(await decodeAll(section)));
    expect(pool.inflatingHere).toBe(true);
    expect(port.terminated).toBe(true);
  });

  it('a corrupt chunk (it fails on the worker and here) rejects as CorruptChunkError and aborts the remaining inflates', async () => {
    const section = corruptOneChunk(await buildGeometrySectionV13(meshes(), coordInfo, { compress: true }));
    const ports: CountingPort[] = [];
    const pool = new ChunkInflatePool(2, { createWorker: () => { const p = new CountingPort(); ports.push(p); return p; } }).start();
    try {
      await expect(decodeAll(section, pool.inflate)).rejects.toBeInstanceOf(CorruptChunkError);
      const posted = ports.reduce((n, p) => n + p.inflates, 0);
      await expect(pool.inflate(new Uint8Array(8), 8)).rejects.toBeInstanceOf(CorruptChunkError);
      expect(ports.reduce((n, p) => n + p.inflates, 0)).toBe(posted); // nothing more goes to a worker
      expect(pool.inflatingHere).toBe(false); // the pool never switched to inflating the rest here
    } finally {
      pool.close();
    }
  });

  it('without workers (they cannot start), a corrupt chunk still rejects as CorruptChunkError and so do the remaining ones', async () => {
    const section = corruptOneChunk(await buildGeometrySectionV13(meshes(), coordInfo, { compress: true }));
    const pool = new ChunkInflatePool(2, { createWorker: () => { throw new Error('no workers here'); } }).start();
    try {
      expect(pool.inflatingHere).toBe(true);
      await expect(decodeAll(section, pool.inflate)).rejects.toBeInstanceOf(CorruptChunkError);
      const good = await buildGeometrySectionV13(meshes(), coordInfo, { compress: true });
      const info = openGeometryChunksV13(good, 0, FORMAT_VERSION).chunks.find((c) => c.flags & GeometryChunkFlags.DeflateRaw)!;
      await expect(pool.inflate(new Uint8Array(good, info.byteOffset, info.byteLength), info.uncompressedLength))
        .rejects.toBeInstanceOf(CorruptChunkError); // nothing more inflates once the entry is known corrupt
    } finally {
      pool.close();
    }
  });

  it('a worker whose codec cannot inflate good data: the chunk inflates here, the rest too, and the entry is not called corrupt', async () => {
    const section = await buildGeometrySectionV13(meshes(), coordInfo, { compress: true });
    class NoCodecPort extends CodecPort {
      override postMessage(message: CompressionRequest | InflateRequest): void {
        queueMicrotask(() => this.onmessage?.(new MessageEvent('message', { data: { id: message.id, error: 'DecompressionStream is not defined' } })));
      }
    }
    const pool = new ChunkInflatePool(2, { createWorker: () => new NoCodecPort() }).start();
    expect(digest(await decodeAll(section, pool.inflate))).toEqual(digest(await decodeAll(section)));
    expect(pool.inflatingHere).toBe(true);
  });

  it('refuses a worker reply of the wrong length: that chunk and the rest decode here, output unchanged', async () => {
    const section = await buildGeometrySectionV13(meshes(), coordInfo, { compress: true });
    class ShortPort extends CodecPort {
      received = 0;
      override postMessage(message: CompressionRequest | InflateRequest, transfers: ArrayBuffer[]): void {
        this.received++;
        const received = structuredClone(message, { transfer: transfers });
        queueMicrotask(() => this.onmessage?.(new MessageEvent('message', { data: { id: received.id, buffer: new ArrayBuffer(3), compressed: false } })));
      }
    }
    const port = new ShortPort();
    const pool = new ChunkInflatePool(1, { createWorker: () => port }).start();
    // Accepting the 3-byte reply would corrupt (or fail) the first chunk's decode.
    expect(digest(await decodeAll(section, pool.inflate))).toEqual(digest(await decodeAll(section)));
    expect(pool.inflatingHere).toBe(true);
  });
});
