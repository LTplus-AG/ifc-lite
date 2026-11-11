/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reopen lane, step 2: a cache hit inflates its compressed geometry chunks on
 * workers, not on the main thread (the snapshot reopen spent ~0.15 s of main
 * thread in DecompressionStream plumbing on Holter). The output must not
 * change, and a hit without workers still loads.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StringTable, EntityTableBuilder, PropertyTableBuilder, QuantityTableBuilder, RelationshipGraphBuilder, RelationshipType } from '@ifc-lite/data';
import { BinaryCacheWriter, BinaryCacheReader, openGeometryChunksV13, SectionType, type CacheDataStore } from '@ifc-lite/cache';
import type { MeshData, CoordinateInfo } from '@ifc-lite/geometry';
import { handleCompressionRequest } from '../../../../packages/cache/src/workers/geometry-compression-handler.js';
import { useViewerStore } from '@/store';
import { useIfcCache, type CacheResult, type CacheLoadResult } from './useIfcCache.js';

const COORD_INFO: CoordinateInfo = {
  originShift: { x: 0, y: 0, z: 0 },
  originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 2000, y: 1, z: 1 } },
  shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 2000, y: 1, z: 1 } },
  hasLargeCoordinates: false,
};

/** Three spatial cells of compressible meshes: each cell's chunk is above the 64 KB compression floor. */
function meshes(): MeshData[] {
  return Array.from({ length: 30 }, (_, i) => ({
    expressId: 10 + i,
    positions: new Float32Array(3000).map((_, k) => k % 7),
    normals: new Float32Array(3000).fill(0.5),
    indices: new Uint32Array(300).map((_, k) => k % 1000),
    color: [0.5, 0.25, 0.125, 1],
    ifcType: 'IFCWALL',
    geometryClass: 0,
    origin: [(i % 3) * 1000, 0, 0],
  }) as MeshData);
}

function dataStore(): CacheDataStore {
  const strings = new StringTable();
  const entities = new EntityTableBuilder(40, strings);
  const relationships = new RelationshipGraphBuilder();
  entities.add(1, 'IfcProject', 'guid-project', 'Project', '', '', false, false);
  entities.add(3, 'IfcBuilding', 'guid-building', 'Building', '', '', false, false);
  for (let i = 0; i < 30; i++) {
    entities.add(10 + i, 'IfcWall', `guid-${i}`, `Wall ${i}`, '', '', true, false);
    relationships.addEdge(3, 10 + i, RelationshipType.ContainsElements, 100 + i);
  }
  return { schema: 1, entityCount: 32, strings, entities: entities.build(), properties: new PropertyTableBuilder(strings).build(),
    quantities: new QuantityTableBuilder(strings).build(), relationships: relationships.build() };
}

async function entry(): Promise<{ result: CacheResult; compressedChunks: number }> {
  const source = ['ISO-10303-21;', 'HEADER;', 'ENDSEC;', 'DATA;', "#1=IFCPROJECT('guid-project');", "#3=IFCBUILDING('guid-building');", 'ENDSEC;', 'END-ISO-10303-21;'].join('\n');
  const sourceBuffer = new TextEncoder().encode(source).buffer as ArrayBuffer;
  const buffer = await new BinaryCacheWriter().write(dataStore(), { meshes: meshes(), totalVertices: 30000, totalTriangles: 3000, coordinateInfo: COORD_INFO },
    sourceBuffer, { includeGeometry: true, omitSourceHash: true });
  const header = new BinaryCacheReader().readHeader(buffer);
  const section = header.sections.find((s) => s.type === SectionType.Geometry)!;
  const compressedChunks = openGeometryChunksV13(buffer, section.offset, header.version).chunks.filter((c) => c.flags & 1).length;
  return { result: { buffer, sourceBuffer }, compressedChunks };
}

/** A Worker that runs the cache's real handler in this thread, counting inflate requests. */
let inflates = 0;
let workersStarted = 0;
class HandlerWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  constructor() { workersStarted++; }
  postMessage(message: { op?: string }, transfers: ArrayBuffer[]): void {
    if (message.op === 'inflate') inflates++;
    const received = structuredClone(message, { transfer: transfers });
    void handleCompressionRequest(received, (response, outgoing) => {
      this.onmessage?.(new MessageEvent('message', { data: structuredClone(response, { transfer: outgoing }) }));
    });
  }
  terminate(): void {}
}

let loadFromCache: ReturnType<typeof useIfcCache>['loadFromCache'] | null = null;
let root: Root | null = null;
const realWorker = (globalThis as { Worker?: unknown }).Worker;

function Probe() {
  loadFromCache = useIfcCache().loadFromCache;
  return null;
}

beforeEach(async () => {
  inflates = 0;
  workersStarted = 0;
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<Probe />); });
});

afterEach(async () => {
  (globalThis as { Worker?: unknown }).Worker = realWorker;
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  useViewerStore.setState({ geometryResult: null, ifcDataStore: null, geometryStreamingActive: false, activeModelId: null, models: new Map() });
});

async function load(result: CacheResult): Promise<CacheLoadResult> {
  useViewerStore.setState({ activeModelId: 'm', models: new Map([['m', { id: 'm', geometryResult: null }]]) as never });
  let out!: CacheLoadResult;
  await act(async () => { out = await loadFromCache!(result, 'm.ifc', 'm', undefined, undefined, () => false); });
  return out;
}

const loadedIds = () => (useViewerStore.getState().geometryResult?.meshes ?? []).map((m) => m.expressId).sort((a, b) => a - b);

describe('a cache hit inflates its geometry chunks off the main thread', () => {
  it('sends every compressed chunk to the inflate workers and loads every mesh', async () => {
    (globalThis as { Worker?: unknown }).Worker = HandlerWorker;
    const { result, compressedChunks } = await entry();
    assert.ok(compressedChunks >= 2, `the fixture must have compressed chunks, has ${compressedChunks}`);
    const loaded = await load(result);
    assert.equal(loaded.success, true);
    assert.ok(workersStarted >= 1, 'the inflate workers were started');
    assert.equal(inflates, compressedChunks, 'every compressed chunk inflated on a worker');
    assert.deepEqual(loadedIds(), meshes().map((m) => m.expressId));
  });

  it('still loads every mesh when workers are unavailable', async () => {
    (globalThis as { Worker?: unknown }).Worker = undefined;
    const { result } = await entry();
    const loaded = await load(result);
    assert.equal(loaded.success, true);
    assert.deepEqual(loadedIds(), meshes().map((m) => m.expressId));
  });
});
