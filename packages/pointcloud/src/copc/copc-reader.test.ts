/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * COPC reader against `test-fixtures/tiny.copc.laz` (#6869), decoded by the
 * REAL laz-perf wasm (its node build), not a stub: the fixture is written by
 * `test-fixtures/generate_tiny_copc.py` with lazrs and cross-checked there
 * with laspy's CopcReader, so these tests compare two independent LAZ
 * implementations through the expected numbers in `tiny-copc.json`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createLazPerf } from 'laz-perf';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setLazPerfLoaderForTesting, type LazPerfModule } from '../streaming/laz-perf-loader.js';
import { BlobByteSource } from '../streaming/blob-source.js';
import { HttpRangeSource } from '../streaming/http-range-source.js';
import type { RangeByteSource } from '../streaming/types.js';
import { copcNodeBounds, voxelKeyId } from './copc-info.js';
import { CopcHierarchy, loadPendingCopcPages, type CopcNodeEntry } from './copc-hierarchy.js';
import { CopcReader } from './copc-reader.js';

const fixtureUrl = new URL('../../test-fixtures/', import.meta.url);
const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL('tiny.copc.laz', fixtureUrl))));
const expected = JSON.parse(readFileSync(fileURLToPath(new URL('tiny-copc.json', fixtureUrl)), 'utf8')) as {
  pointCount: number;
  center: [number, number, number];
  halfsize: number;
  nodeCount: number;
  childPageCount: number;
  nodes: Record<string, number>;
  classCounts: Record<string, number>;
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
};
const SCALE = 0.001;

let restore: () => void;
beforeAll(() => {
  restore = setLazPerfLoaderForTesting(() => createLazPerf() as Promise<LazPerfModule>);
});
afterAll(() => restore());

async function openAll(source: RangeByteSource, originOffset?: readonly [number, number, number]) {
  const reader = await CopcReader.open(source, { originOffset });
  const hierarchy = new CopcHierarchy();
  hierarchy.addPage(reader.rootPageRef, await reader.readPage(reader.rootPageRef));
  await loadPendingCopcPages(hierarchy, (ref, signal) => reader.readPage(ref, signal));
  return { reader, hierarchy };
}

function nodesWithPoints(hierarchy: CopcHierarchy): CopcNodeEntry[] {
  return [...hierarchy.nodes.values()].filter((n) => n.pointCount > 0);
}

describe('CopcReader on tiny.copc.laz (#6869)', () => {
  const blob = new Blob([bytes]);

  it('walks every hierarchy page and finds every node the generator wrote', async () => {
    const { hierarchy } = await openAll(new BlobByteSource(blob));
    expect(hierarchy.loadedPageCount).toBe(1 + expected.childPageCount);
    expect(hierarchy.pendingPages.size).toBe(0);
    const counts = Object.fromEntries([...hierarchy.nodes.values()].map((n) => [voxelKeyId(n.key), n.pointCount]));
    expect(counts).toEqual(expected.nodes);
  });

  it('decodes every node; the union is the whole cloud with the right classes and bounds', async () => {
    const { reader, hierarchy } = await openAll(new BlobByteSource(blob));
    let total = 0;
    const classes: Record<string, number> = {};
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const node of nodesWithPoints(hierarchy)) {
      const chunk = await reader.readNode(node);
      expect(chunk.pointCount).toBe(node.pointCount);
      total += chunk.pointCount;
      for (const c of chunk.classifications ?? []) classes[c] = (classes[c] ?? 0) + 1;
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], chunk.bbox.min[a]);
        max[a] = Math.max(max[a], chunk.bbox.max[a]);
      }
      expect(chunk.colors?.length).toBe(chunk.pointCount * 3);
    }
    expect(total).toBe(expected.pointCount);
    expect(classes).toEqual(expected.classCounts);
    // No origin offset: f32 positions at 2.6e6 m quantise to 0.25 m.
    for (let a = 0; a < 3; a++) {
      expect(Math.abs(min[a] - expected.bboxMin[a])).toBeLessThanOrEqual(0.25);
      expect(Math.abs(max[a] - expected.bboxMax[a])).toBeLessThanOrEqual(0.25);
    }
  });

  it('every decoded point lies inside its node cube (key-derived bounds), to the f32 residual', async () => {
    const origin = expected.center;
    const { reader, hierarchy } = await openAll(new BlobByteSource(blob), origin);
    for (const node of nodesWithPoints(hierarchy)) {
      const cube = copcNodeBounds(reader.file.info, node.key);
      const chunk = await reader.readNode(node);
      for (let i = 0; i < chunk.pointCount; i++) {
        for (let a = 0; a < 3; a++) {
          const v = chunk.positions[i * 3 + a] + origin[a];
          expect(v).toBeGreaterThanOrEqual(cube.min[a] - 1e-4);
          expect(v).toBeLessThanOrEqual(cube.max[a] + 1e-4);
        }
      }
    }
  });

  it('origin offset keeps millimetre precision at map coordinates (#1804 contract)', async () => {
    const origin = expected.center;
    const { reader, hierarchy } = await openAll(new BlobByteSource(blob), origin);
    const root = hierarchy.nodes.get('0-0-0-0');
    if (!root) throw new Error('root node missing');
    const chunk = await reader.readNode(root);
    for (let i = 0; i < chunk.positions.length; i++) {
      const native = chunk.positions[i] + origin[i % 3];
      // Every native coordinate is an integer multiple of the 1 mm scale.
      const residual = Math.abs(native / SCALE - Math.round(native / SCALE));
      expect(residual).toBeLessThan(0.01);
    }
    expect(reader.bbox.min[0]).toBeCloseTo(expected.bboxMin[0] - origin[0], 6);
  });

  it('stride keeps exactly every n-th point of the node, in order', async () => {
    const { reader, hierarchy } = await openAll(new BlobByteSource(blob), expected.center);
    const node = nodesWithPoints(hierarchy).sort((a, b) => b.pointCount - a.pointCount)[0];
    const full = await reader.readNode(node);
    const thin = await reader.readNode(node, { stride: 3 });
    expect(thin.pointCount).toBe(Math.ceil(node.pointCount / 3));
    for (let i = 0; i < thin.pointCount; i++) {
      for (let a = 0; a < 3; a++) expect(thin.positions[i * 3 + a]).toBe(full.positions[i * 3 * 3 + a]);
    }
  });

  it('reads over HTTP Range without fetching the whole file', async () => {
    let served = 0;
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const m = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('Range') ?? '');
      if (!m) return new Response(null, { status: 400 });
      const start = Number(m[1]);
      const last = Math.min(Number(m[2]), bytes.length - 1);
      served += last - start + 1;
      return new Response(bytes.slice(start, last + 1), {
        status: 206,
        headers: { 'Content-Range': `bytes ${start}-${last}/${bytes.length}` },
      });
    };
    const source = await HttpRangeSource.open('https://example.test/tiny.copc.laz', { fetch: fetchImpl, prefetchBytes: 1024 });
    const reader = await CopcReader.open(source);
    const hierarchy = new CopcHierarchy();
    hierarchy.addPage(reader.rootPageRef, await reader.readPage(reader.rootPageRef));
    const root = hierarchy.nodes.get('0-0-0-0');
    if (!root) throw new Error('root node missing');
    const chunk = await reader.readNode(root);
    expect(chunk.pointCount).toBe(expected.nodes['0-0-0-0']);
    // Header prefix + root page + root chunk: a small share of the file.
    expect(served).toBeLessThan(1024 + reader.file.info.rootHierSize + root.byteSize + 1);
    expect(served).toBeLessThan(bytes.length / 4);
  });

  it('refuses a page larger than the caller\'s byte limit without reading it (#6874 review)', async () => {
    let reads = 0;
    const counting = {
      size: bytes.length,
      read: async (start: number, end: number) => {
        reads++;
        return bytes.slice(start, end);
      },
    };
    const reader = await CopcReader.open(counting);
    const before = reads;
    const ref = reader.rootPageRef;
    await expect(reader.readPage(ref, undefined, ref.byteSize - 32)).rejects.toThrow(/exceeds/);
    expect(reads).toBe(before);
    await expect(reader.readPage(ref, undefined, ref.byteSize)).resolves.toBeTruthy();
  });

  it('refuses a node entry whose span leaves the point block', async () => {
    const reader = await CopcReader.open(new BlobByteSource(blob));
    const key = { d: 0, x: 0, y: 0, z: 0 };
    await expect(reader.readNode({ key, offset: 10, byteSize: 100, pointCount: 5 })).rejects.toThrow(/outside/);
    await expect(reader.readNode({ key, offset: bytes.length - 10, byteSize: 100, pointCount: 5 })).rejects.toThrow(/outside/);
    await expect(reader.readNode({ key, offset: 1000, byteSize: 100, pointCount: -3 })).rejects.toThrow(/point count/);
  });
});
