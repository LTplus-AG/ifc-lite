/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Reopen lane, step 2 (#9728 follow-up): a cache hit inflates its compressed
// geometry chunks on workers instead of the main thread.
import { describe, expect, it } from 'vitest';
import type { MeshData, CoordinateInfo } from '@ifc-lite/geometry';
import { buildGeometrySectionV13, openGeometryChunksV13 } from '../sections/geometry-chunks.js';
import { FORMAT_VERSION, GeometryChunkFlags } from '../types.js';
import { ChunkInflatePool, ChunkPoolClosedError, CorruptChunkError, NoChunkWorkerError } from './chunk-inflate-pool.js';
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
  [...new Uint8Array(m.normals.buffer, m.normals.byteOffset, m.normals.byteLength)].join(','), [...m.indices].join(','), m.color.join(',')].join('|'));

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

  describe('decode on the workers (inflate + record decode, one transfer per chunk)', () => {
    /** Meshes in several cells sharing one pooled appearance source, so chunks reference the section pool. */
    function pooledMeshes(): MeshData[] {
      const shared = new Uint32Array(270).map((_, k) => 99 - (k % 100));
      return meshes().map((m, i) => ({ ...m, geometryItemId: 7000 + i,
        appearanceSource: { kind: 'canonical-item' as const, indices: m.indices, sourceIndices: shared } }));
    }
    async function decodeAllWith(section: ArrayBuffer, decode?: ChunkInflatePool['decode']) {
      const open = openGeometryChunksV13(section, 0, FORMAT_VERSION, decode ? { decode } : {});
      const perChunk = await Promise.all(open.chunks.map((_, i) => open.readChunk(i)));
      return { open, perChunk, all: perChunk.flat() };
    }

    it('decodes every chunk on its workers, byte-identical to a main-thread decode, and re-links the shared pool', async () => {
      const section = await buildGeometrySectionV13(pooledMeshes(), coordInfo, { compress: true });
      const ports: CountingPort[] = [];
      let decodes = 0;
      class DecodeCountingPort extends CountingPort {
        override postMessage(message: CompressionRequest | InflateRequest, transfers: ArrayBuffer[]): void {
          if ('op' in message && (message as { op: string }).op === 'decode') decodes++;
          super.postMessage(message, transfers);
        }
      }
      const pool = new ChunkInflatePool(2, { createWorker: () => { const p = new DecodeCountingPort(); ports.push(p); return p; } }).start();
      try {
        const here = await decodeAllWith(section);
        const there = await decodeAllWith(section, pool.decode);
        expect(there.open.chunks.length).toBeGreaterThan(1);
        expect(decodes).toBe(there.open.chunks.length);
        expect(digest(there.all)).toEqual(digest(here.all));
        // Pool identity as on the main thread: every pooled source is the section pool's own array, in every chunk.
        const sectionPool = there.open.chunks[0].appearanceSources!;
        const sources = new Set(there.all.map((m) => m.appearanceSource!.sourceIndices));
        expect(sources.size).toBe(1);
        expect(sectionPool.includes([...sources][0])).toBe(true);
        for (const m of there.all) expect(m.appearanceSource!.indices).toBe(m.indices);
        expect(pool.inflatingHere).toBe(false);
      } finally {
        pool.close();
      }
    });

    it('transfers the mesh arrays: the worker keeps none of them', async () => {
      const section = await buildGeometrySectionV13(meshes(), coordInfo, { compress: true });
      const kept: ArrayBuffer[][] = [];
      class TransferWatchingPort extends CodecPort {
        override postMessage(message: CompressionRequest | InflateRequest, transfers: ArrayBuffer[]): void {
          const received = structuredClone(message, { transfer: transfers });
          void handleCompressionRequest(received, (response, outgoing) => {
            kept.push(outgoing);
            this.onmessage?.(new MessageEvent('message', { data: structuredClone(response, { transfer: outgoing }) }));
          });
        }
      }
      const pool = new ChunkInflatePool(1, { createWorker: () => new TransferWatchingPort() }).start();
      try {
        const { all } = await decodeAllWith(section, pool.decode);
        expect(all.length).toBe(60);
        expect(kept.length).toBeGreaterThan(0);
        for (const buffers of kept) for (const b of buffers) expect(b.byteLength).toBe(0); // detached on the worker side
      } finally {
        pool.close();
      }
    });

    it('a worker that fails mid-decode: that chunk and the rest decode on the calling thread, unchanged', async () => {
      const section = await buildGeometrySectionV13(pooledMeshes(), coordInfo, { compress: true });
      const ports: HoldingPort[] = [];
      const pool = new ChunkInflatePool(1, { createWorker: () => { const p = new HoldingPort(); ports.push(p); return p; } }).start();
      try {
        const pending = decodeAllWith(section, pool.decode);
        await new Promise((r) => setTimeout(r, 0));
        expect(ports[0].received).toBeGreaterThan(0);
        ports[0].crash();
        const there = await pending;
        const here = await decodeAllWith(section);
        expect(digest(there.all)).toEqual(digest(here.all));
        expect(pool.inflatingHere).toBe(true);
      } finally {
        pool.close();
      }
    });

    it('a corrupt chunk (it fails on the worker and here) rejects as CorruptChunkError, and so do the remaining chunks', async () => {
      const section = corruptOneChunk(await buildGeometrySectionV13(meshes(), coordInfo, { compress: true }));
      const pool = new ChunkInflatePool(2, { createWorker: () => new CountingPort() }).start();
      try {
        await expect(decodeAllWith(section, pool.decode)).rejects.toBeInstanceOf(CorruptChunkError);
        const good = await buildGeometrySectionV13(meshes(), coordInfo, { compress: true });
        const open = openGeometryChunksV13(good, 0, FORMAT_VERSION, { decode: pool.decode });
        await expect(open.readChunk(0)).rejects.toBeInstanceOf(CorruptChunkError);
      } finally {
        pool.close();
      }
    });

    it('without workers (they cannot start), chunks decode on the calling thread exactly as without the pool', async () => {
      const section = await buildGeometrySectionV13(pooledMeshes(), coordInfo, { compress: true });
      const pool = new ChunkInflatePool(2, { createWorker: () => { throw new Error('no workers here'); } }).start();
      try {
        const there = await decodeAllWith(section, pool.decode);
        const here = await decodeAllWith(section);
        expect(digest(there.all)).toEqual(digest(here.all));
        expect(pool.inflatingHere).toBe(true);
      } finally {
        pool.close();
      }
    });
  });

  describe('closing and worker-only decodes (review F1, F2)', () => {
    it('closed with decodes in flight: they reject as ChunkPoolClosedError and nothing decodes on the calling thread', async () => {
      const section = await buildGeometrySectionV13(meshes(), coordInfo, { compress: true });
      const ports: HoldingPort[] = [];
      const warn = console.warn; const warnings: unknown[] = []; console.warn = (...a: unknown[]) => { warnings.push(a); };
      const pool = new ChunkInflatePool(2, { createWorker: () => { const p = new HoldingPort(); ports.push(p); return p; } }).start();
      try {
        const open = openGeometryChunksV13(section, 0, FORMAT_VERSION, { decode: pool.decode });
        const pending = open.chunks.map((_, i) => open.readChunk(i).then(() => 'decoded', (e) => e));
        await new Promise((r) => setTimeout(r, 0));
        expect(ports.reduce((n, p) => n + p.received, 0)).toBeGreaterThan(0);
        pool.close(); // the load ended (superseded, model removed or replaced)
        const outcomes = await Promise.all(pending);
        for (const outcome of outcomes) expect(outcome).toBeInstanceOf(ChunkPoolClosedError);
        expect(pool.inflatingHere).toBe(false); // no fallback to this thread
        expect(warnings).toEqual([]); // no "worker failed" warning
        await expect(pool.decode(new Uint8Array(4), open.chunks[0], FORMAT_VERSION)).rejects.toBeInstanceOf(ChunkPoolClosedError);
      } finally {
        console.warn = warn;
      }
    });

    it('decodeOnWorkers: a failing worker rejects as NoChunkWorkerError (the pool falls back for on-demand decodes); it never decodes here', async () => {
      const section = await buildGeometrySectionV13(meshes(), coordInfo, { compress: true });
      const ports: HoldingPort[] = [];
      const warn = console.warn; console.warn = () => {};
      const pool = new ChunkInflatePool(1, { createWorker: () => { const p = new HoldingPort(); ports.push(p); return p; } }).start();
      try {
        const open = openGeometryChunksV13(section, 0, FORMAT_VERSION);
        const info = open.chunks[0];
        const bytes = new Uint8Array(section, info.byteOffset, info.byteLength);
        const pending = pool.decodeOnWorkers(bytes, info, FORMAT_VERSION);
        await new Promise((r) => setTimeout(r, 0));
        ports[0].crash();
        await expect(pending).rejects.toBeInstanceOf(NoChunkWorkerError);
        expect(pool.inflatingHere).toBe(true);
        await expect(pool.decodeOnWorkers(bytes, info, FORMAT_VERSION)).rejects.toBeInstanceOf(NoChunkWorkerError);
        // `decode` (the caller's on-demand path) still decodes, here.
        expect((await pool.decode(bytes, info, FORMAT_VERSION)).length).toBe(info.meshCount);
      } finally {
        console.warn = warn;
        pool.close();
      }
    });

    it('decodeOnWorkers: a worker codec error rejects as NoChunkWorkerError without giving up the workers', async () => {
      const section = corruptOneChunk(await buildGeometrySectionV13(meshes(), coordInfo, { compress: true }));
      const pool = new ChunkInflatePool(1, { createWorker: () => new CodecPort() }).start();
      try {
        const open = openGeometryChunksV13(section, 0, FORMAT_VERSION);
        const index = open.chunks.findIndex((c) => c.flags & GeometryChunkFlags.DeflateRaw);
        const info = open.chunks[index];
        const bytes = new Uint8Array(section, info.byteOffset, info.byteLength);
        await expect(pool.decodeOnWorkers(bytes, info, FORMAT_VERSION)).rejects.toBeInstanceOf(NoChunkWorkerError);
        expect(pool.inflatingHere).toBe(false);
        // The caller's on-demand `decode` then tells corrupt from a worker problem, as before.
        await expect(pool.decode(bytes, info, FORMAT_VERSION)).rejects.toBeInstanceOf(CorruptChunkError);
      } finally {
        pool.close();
      }
    });
  });

  it('without workers, a chunk still inflating when another is found corrupt rejects too (review: no result from a corrupt entry)', async () => {
    const good = await buildGeometrySectionV13(meshes(), coordInfo, { compress: true });
    const info = openGeometryChunksV13(good, 0, FORMAT_VERSION).chunks.find((c) => c.flags & GeometryChunkFlags.DeflateRaw)!;
    const pool = new ChunkInflatePool(2, { createWorker: () => { throw new Error('no workers here'); } }).start();
    try {
      const inflating = pool.inflate(new Uint8Array(good, info.byteOffset, info.byteLength), info.uncompressedLength);
      const bad = pool.inflate(new Uint8Array(64).fill(0xff), 1024);
      await expect(bad).rejects.toBeInstanceOf(CorruptChunkError);
      await expect(inflating).rejects.toBeInstanceOf(CorruptChunkError);
    } finally {
      pool.close();
    }
  });

  it('without workers, a chunk still decoding when another is found corrupt rejects too', async () => {
    const section = corruptOneChunk(await buildGeometrySectionV13(meshes(), coordInfo, { compress: true }));
    const open = openGeometryChunksV13(section, 0, FORMAT_VERSION);
    const compressed = open.chunks.filter((c) => c.flags & GeometryChunkFlags.DeflateRaw);
    const bytes = (c: (typeof compressed)[number]) => new Uint8Array(section, c.byteOffset, c.byteLength);
    const corrupt = compressed.find((c) => bytes(c).every((b) => b === 0xff))!;
    const good = compressed.find((c) => c !== corrupt)!;
    const pool = new ChunkInflatePool(2, { createWorker: () => { throw new Error('no workers here'); } }).start();
    try {
      const decoding = pool.decode(bytes(good), good, FORMAT_VERSION);
      const bad = pool.decode(bytes(corrupt), corrupt, FORMAT_VERSION);
      await expect(bad).rejects.toBeInstanceOf(CorruptChunkError);
      await expect(decoding).rejects.toBeInstanceOf(CorruptChunkError);
    } finally {
      pool.close();
    }
  });
});
