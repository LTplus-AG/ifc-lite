/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The real drawing hook over GPU-instanced geometry (#10264):
 * - a model whose geometry is all instanced (no flat mesh) still draws;
 * - while its shards are still queued, no drawing is published without them,
 *   with a renderer (waits for the drain) or without one (refuses).
 * Legacy single-model wiring (no `models` entry), as the review case names.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Drawing2D } from '@ifc-lite/drawing-2d';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '../store/index.js';
import { discardInstancedShards, drainInstancedShards, enqueueInstancedShards, instancedShardGeneration } from '../store/instancedShardQueue.js';
import { setGlobalRendererRef } from './useBCF.js';
import { useDrawingGeneration } from './useDrawingGeneration.js';
import { instancedStall } from '../lib/drawing/drawing-instanced-presence.js';

const POST = 700;

/** A 1 × 3 × 1 m post as one occurrence piece (Y-up), as the scene materializes it. */
function post(): MeshData {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 3, 0, 0, 3, 0, 0, 0, 1, 1, 0, 1, 1, 3, 1, 0, 3, 1]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2]);
  return { expressId: POST, modelIndex: 0, positions, normals: new Float32Array(positions.length), indices, color: [0.4, 0.4, 0.4, 1],
    origin: [2, 0, 2], occurrenceKey: `${POST}:inst:0:0` };
}

function renderer(onPieces: () => void = () => {}): Renderer {
  const scene = {
    isGeometryDataReleased: () => false,
    getInstancedEntityCount: () => 1,
    getInstancedEntityIds: () => [POST][Symbol.iterator](),
    getInstancedMeshDataPieces: (id: number) => { onPieces(); return id === POST ? [post()] : undefined; },
  };
  // Only the scene surface the drawing reads; the hook never renders.
  return { getScene: () => scene } as unknown as Renderer;
}

const INSTANCED_ONLY: GeometryResult = {
  meshes: [], totalTriangles: 0, totalVertices: 0,
  coordinateInfo: {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 3, z: 4 } },
    shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 3, z: 4 } },
    hasLargeCoordinates: false,
  },
};

interface Outcome { drawing: Drawing2D | null; error: string | null; progress: string | null; log: string[] }

/** While the request runs: `during` sees the outcome so far (e.g. the wait), then the request must end. */
async function generate(during?: (out: Outcome) => Promise<void>): Promise<Outcome> {
  const out: Outcome = { drawing: null, error: null, progress: null, log: [] };
  let run: (() => Promise<void>) | null = null;
  function Harness(): null {
    const { generateDrawing } = useDrawingGeneration({
      activeTool: 'select', geometryResult: INSTANCED_ONLY, ifcDataStore: null,
      sectionPlane: { axis: 'down', position: 50, flipped: false },
      displayOptions: { showHiddenLines: false, useSymbolicRepresentations: false, show3DOverlay: false, scale: 50, showConstructionProjection: false },
      combinedHiddenIds: new Set<number>(), combinedIsolatedIds: null, computedIsolatedIds: null,
      models: new Map(), panelVisible: false,
      typeVisibility: { spaces: true, spatialZones: true, openings: true, virtualElements: true, site: true, ifcAnnotations: true },
      drawing: null,
      setDrawing: (d) => { out.drawing = d; out.log.push('drawing'); },
      setDrawingStatus: () => {},
      setDrawingProgress: (_p, phase) => { out.progress = phase; out.log.push(`progress:${phase}`); },
      setDrawingError: (e) => { out.error = e; },
    });
    run = generateDrawing;
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  try {
    await act(async () => { root = createRoot(container); root.render(<Harness />); });
    assert.ok(run, 'harness never rendered');
    await act(async () => {
      const request = run!().catch((error: unknown) => { out.error = String(error); });
      await during?.(out);
      await request;
    });
    return out;
  } finally {
    if (root) await act(async () => { root!.unmount(); });
    container.remove();
  }
}

describe('useDrawingGeneration over instanced-only geometry (#10264)', () => {
  afterEach(() => {
    setGlobalRendererRef({ current: null });
    discardInstancedShards();
  });

  it('draws a model whose geometry is all GPU-instanced', async () => {
    assert.equal(useViewerStore.getState().models.size, 0, 'legacy single-model wiring');
    setGlobalRendererRef({ current: renderer() });
    const { drawing, error } = await generate();
    assert.equal(error, null);
    const ids = new Set([...(drawing?.lines ?? []).map((l) => l.entityId), ...(drawing?.cutPolygons ?? []).map((p) => p.entityId)]);
    assert.ok(ids.has(POST), `the instanced post must be cut; drew ${[...ids]}`);
  });

  it('refuses, with no renderer, while instanced shards exist: no partial drawing', async () => {
    enqueueInstancedShards('legacy-model', [new ArrayBuffer(8)], instancedShardGeneration());
    const { drawing, error } = await generate();
    assert.equal(drawing, null, 'nothing is published without the instanced geometry');
    assert.match(error ?? '', /before the viewport renderer exists/);
  });

  const WAIT = 'progress:Waiting for instanced geometry...';
  const settle = (ms: number) => new Promise((done) => setTimeout(done, ms));
  const drainAll = () => drainInstancedShards((shards, done) => { for (const shard of shards) done(shard, 'uploaded'); });
  const drew = (out: Outcome) => new Set([...(out.drawing?.lines ?? []).map((l) => l.entityId), ...(out.drawing?.cutPolygons ?? []).map((p) => p.entityId)]);
  const withStall = (ms: number, body: () => Promise<void>) => async () => {
    const restore = instancedStall.ms;
    instancedStall.ms = ms;
    try { await body(); } finally { instancedStall.ms = restore; }
  };

  it('r4661532635 waits for queued shards, then cuts again on the drain itself, with the panel closed', withStall(1000, async () => {
    setGlobalRendererRef({ current: renderer() });
    enqueueInstancedShards('legacy-model', [new ArrayBuffer(8)], instancedShardGeneration());
    const out = await generate(async (sofar) => {
      await settle(30);
      assert.equal(sofar.drawing, null, 'no drawing while a shard is still queued');
      assert.equal(sofar.progress, 'Waiting for instanced geometry...');
      drainAll();
    });
    assert.equal(out.error, null, 'waiting is not an error');
    assert.ok(drew(out).has(POST), 'the request itself cut again after the drain');
  }));

  it('r4661532635 a wait whose queue stops moving (load died, drain gave up) ends in an error, not generating forever', withStall(20, async () => {
    setGlobalRendererRef({ current: renderer() });
    enqueueInstancedShards('legacy-model', [new ArrayBuffer(8)], instancedShardGeneration()); // nothing will ever drain it
    const out = await generate();
    assert.equal(out.drawing, null, 'nothing is published without the instanced geometry');
    assert.match(out.error ?? '', /did not reach the scene/);
  }));

  it('r4661532635 a wait whose shards are discarded (model removed, clear-all) cuts again and publishes', withStall(1000, async () => {
    setGlobalRendererRef({ current: renderer() });
    enqueueInstancedShards('legacy-model', [new ArrayBuffer(8)], instancedShardGeneration());
    const out = await generate(async () => { await settle(30); discardInstancedShards(); });
    assert.equal(out.error, null);
    assert.ok(drew(out).has(POST));
  }));

  it('does not publish a cut during which a shard was queued; it waits for the drain', withStall(1000, async () => {
    // The shard arrives while the cutter reads the instanced pieces (the first cut only).
    let first = true;
    setGlobalRendererRef({ current: renderer(() => { if (first) { first = false; enqueueInstancedShards('legacy-model', [new ArrayBuffer(8)], instancedShardGeneration()); } }) });
    const out = await generate(async (sofar) => {
      await settle(30);
      assert.equal(sofar.drawing, null, 'the cut that missed the queued shard is not published');
      drainAll();
    });
    assert.equal(out.error, null);
    assert.deepEqual(out.log.filter((e) => e === WAIT || e === 'drawing').slice(0, 2), [WAIT, 'drawing'], 'published only after the wait');
  }));

  it('does not publish a cut during which a shard was queued and already drained', withStall(1000, async () => {
    // Enqueued and gone again (drained/discarded) while the cutter reads the pieces: the queue is empty at publish time.
    let first = true;
    setGlobalRendererRef({ current: renderer(() => {
      if (!first) return;
      first = false;
      enqueueInstancedShards('legacy-model', [new ArrayBuffer(8)], instancedShardGeneration());
      discardInstancedShards();
    }) });
    const out = await generate();
    assert.equal(out.error, null);
    assert.deepEqual(out.log.filter((e) => e === WAIT || e === 'drawing'), [WAIT, 'drawing'], 'the cut that may have missed it is not published; the next one is');
  }));
});
