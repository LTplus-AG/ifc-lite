/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cold-storage geometry provider (issue #1682, phase 3b).
 *
 * Bridges the renderer's cold residency tier to the v13 cache entry: given a
 * world AABB, decode every cache chunk that intersects it and return the
 * meshes. Reads are PARTIAL — `Blob.slice` on the (disk-backed) IndexedDB
 * blob fetches only the chunk records needed, so restoring one corner of an
 * 800 MB model does not re-read the whole entry. A small LRU keeps the most
 * recently decoded chunks hot, since adjacent buckets restore together
 * during a camera gesture.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { ColdGeometryProvider } from '@ifc-lite/renderer';
import { decodeGeometryChunk, type GeometryChunkInfo } from '@ifc-lite/cache';

/** Byte source: disk-backed Blob preferred; ArrayBuffer fallback (legacy). */
type ByteSource = Blob | ArrayBuffer;

const DECODED_LRU_MAX = 4;

async function readRange(source: ByteSource, start: number, end: number): Promise<Uint8Array> {
  if (source instanceof Blob) {
    return new Uint8Array(await source.slice(start, end).arrayBuffer());
  }
  return new Uint8Array(source, start, end - start).slice();
}

function intersects(
  info: GeometryChunkInfo,
  min: [number, number, number],
  max: [number, number, number],
): boolean {
  return (
    info.aabbMin[0] <= max[0] && info.aabbMax[0] >= min[0] &&
    info.aabbMin[1] <= max[1] && info.aabbMax[1] >= min[1] &&
    info.aabbMin[2] <= max[2] && info.aabbMax[2] >= min[2]
  );
}

export function makeColdGeometryProvider(input: {
  source: ByteSource;
  /** Absolute offset of the Geometry section (from the cache section table). */
  geometrySectionOffset: number;
  /** Chunk directory parsed at load time (small; retained instead of re-read). */
  chunks: GeometryChunkInfo[];
  version: number;
}): ColdGeometryProvider {
  const { source, geometrySectionOffset, chunks, version } = input;
  // Tiny decoded-chunk LRU keyed by chunk index.
  const lru = new Map<number, MeshData[]>();

  async function loadChunk(index: number): Promise<MeshData[]> {
    const hit = lru.get(index);
    if (hit) {
      // Refresh recency
      lru.delete(index);
      lru.set(index, hit);
      return hit;
    }
    const info = chunks[index];
    const start = geometrySectionOffset + info.byteOffset;
    const stored = await readRange(source, start, start + info.byteLength);
    const meshes = await decodeGeometryChunk(stored, info, version);
    lru.set(index, meshes);
    while (lru.size > DECODED_LRU_MAX) {
      const oldest = lru.keys().next().value as number;
      lru.delete(oldest);
    }
    return meshes;
  }

  return {
    async loadMeshesInBounds(min, max) {
      const out: MeshData[] = [];
      for (let i = 0; i < chunks.length; i++) {
        if (!intersects(chunks[i], min, max)) continue;
        out.push(...await loadChunk(i));
      }
      return out;
    },
  };
}
