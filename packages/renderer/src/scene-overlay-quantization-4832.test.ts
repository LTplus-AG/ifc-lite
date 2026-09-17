/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression test for issue #4832 (chart / lens / IDS colours missing on
 * large models).
 *
 * The colour-overlay pass draws with `depthCompare: 'equal'`, so an overlay
 * batch only paints where its depth is BIT-IDENTICAL to the depth its base
 * batch wrote. Base buckets are `cell~colour` (32 m cells) and quantize onto
 * the 2^-10 lattice; overlay batches used to group by override colour alone,
 * so one spanning more than `MAX_QUANT_EXTENT` (~64 m) fell back to f32 while
 * its base stayed lattice-snapped. Off-lattice vertices then differed by up
 * to one lattice step and the overlay was discarded.
 *
 * The invariant pinned here: for every entity an overlay (or partial)
 * batch carries, the positions the GPU will see are bit-identical to those
 * of the entity's base batch, in BOTH directions of the fallback (overlay
 * f32 / base quantized, and overlay quantized / base f32).
 *
 * Coordinates are deliberately OFF the 2^-10 lattice: lattice-aligned inputs
 * quantize losslessly and cannot expose the divergence.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { MeshData } from '@ifc-lite/geometry';
import { Scene } from './scene.js';
import { createSceneBatch } from './scene-batch-upload.js';
import type { BatchedMesh } from './types.js';
import { MAX_QUANT_EXTENT } from './quantize.js';

(globalThis as Record<string, unknown>).GPUBufferUsage = {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};

/** Fake device that keeps the mapped-at-creation bytes so batches can be read back. */
function fakeDevice(maxBufferSize = 1 << 30): { device: GPUDevice; bytes: WeakMap<GPUBuffer, ArrayBuffer> } {
  const bytes = new WeakMap<GPUBuffer, ArrayBuffer>();
  const device = {
    limits: { maxBufferSize, maxStorageBufferBindingSize: 1 << 30 },
    createBuffer: (desc: GPUBufferDescriptor) => {
      const backing = new ArrayBuffer(desc.size);
      const buffer = { size: desc.size, getMappedRange: () => backing, unmap() {}, destroy() {} } as unknown as GPUBuffer;
      bytes.set(buffer, backing);
      return buffer;
    },
    createBindGroup: () => ({}),
    queue: { writeBuffer: () => {} },
  };
  return { device: device as unknown as GPUDevice, bytes };
}

const fakePipeline = {
  getUniformBufferSize: () => 256,
  getBindGroupLayout: () => ({}),
} as unknown as Parameters<Scene['appendToBatches']>[2];

const GREY: [number, number, number, number] = [0.5, 0.5, 0.5, 1];
const RED: [number, number, number, number] = [1, 0, 0, 1];

/** Off-lattice unit triangle whose element origin puts it at `origin`. */
function triangle(expressId: number, origin: [number, number, number], color = GREY): MeshData {
  return {
    expressId,
    positions: new Float32Array([0.0003, 0.0007, 0.0001, 1.0004, 0.0007, 0.0001, 0.0003, 1.0009, 0.0001]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color,
    origin,
  };
}

/** A single off-lattice element longer than the u16 lattice range along X. */
function longWall(expressId: number, origin: [number, number, number]): MeshData {
  const len = MAX_QUANT_EXTENT + 6.0003;
  return {
    expressId,
    positions: new Float32Array([0.0003, 0.0007, 0.0001, len, 0.0007, 0.0001, 0.0003, 1.0009, 0.0001]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: GREY,
    origin,
  };
}

/**
 * Positions the shader will see for each entity in a batch, as the f32
 * values the GPU dequantizes/reads: `quantMin + q * step` for quantized
 * batches (every term is an exact f32, so the sum is too), raw f32 otherwise.
 * Keyed by picking id (low 24 bits of the entity lane), positions sorted.
 */
function gpuPositionsByEntity(batch: BatchedMesh, bytes: WeakMap<GPUBuffer, ArrayBuffer>): Map<number, string[]> {
  const buf = bytes.get(batch.vertexBuffer);
  assert.ok(buf, 'vertex buffer bytes captured');
  const out = new Map<number, string[]>();
  const push = (id: number, x: number, y: number, z: number) => {
    let list = out.get(id);
    if (!list) { list = []; out.set(id, list); }
    list.push(`${x},${y},${z}`);
  };
  if (batch.quantized) {
    const u16 = new Uint16Array(buf);
    const u32 = new Uint32Array(buf);
    const { min, step } = batch.quantized;
    for (let v = 0; v * 12 < buf.byteLength; v++) {
      const w = v * 6;
      push(
        u32[v * 3 + 2] & 0x00FFFFFF,
        Math.fround(min[0] + u16[w] * step),
        Math.fround(min[1] + u16[w + 1] * step),
        Math.fround(min[2] + u16[w + 2] * step),
      );
    }
  } else {
    const f32 = new Float32Array(buf);
    const u32 = new Uint32Array(buf);
    for (let b = 0; b + 7 <= f32.length; b += 7) {
      push(u32[b + 6] & 0x00FFFFFF, f32[b], f32[b + 1], f32[b + 2]);
    }
  }
  for (const list of out.values()) list.sort();
  return out;
}

/** Base batch (bucket-owned) that carries `expressId`. */
function baseBatchFor(scene: Scene, expressId: number): BatchedMesh {
  const batch = scene.getBatchedMeshes().find((b) => b.expressIds.includes(expressId));
  assert.ok(batch, `base batch for ${expressId}`);
  return batch;
}

/**
 * The depthCompare:'equal' contract: every entity in `derived` renders at
 * exactly the positions its base batch does, from the same local origin.
 */
function assertCoincidentWithBase(scene: Scene, derived: BatchedMesh, bytes: WeakMap<GPUBuffer, ArrayBuffer>): void {
  const derivedPositions = gpuPositionsByEntity(derived, bytes);
  assert.ok(derivedPositions.size > 0, 'derived batch has vertices');
  for (const [expressId, positions] of derivedPositions) {
    const base = baseBatchFor(scene, expressId);
    assert.deepStrictEqual(derived.origin, base.origin, `entity ${expressId}: shared local origin`);
    const basePositions = gpuPositionsByEntity(base, bytes).get(expressId);
    assert.deepStrictEqual(positions, basePositions, `entity ${expressId}: GPU positions bit-identical to base batch`);
    assert.strictEqual(
      derived.quantized !== undefined, base.quantized !== undefined,
      `entity ${expressId}: derived batch must take the same f32/quantized path as its base batch`,
    );
  }
}

function quantizedChunkedScene(): Scene {
  const scene = new Scene();
  scene.setSpatialChunking({ cellSize: 32 });
  scene.setQuantizedBatches(true);
  return scene;
}

describe('overlay batches stay depth-coincident with their base batches (#4832)', () => {
  it('overrides on entities >64 m apart (base batches quantized) render bit-identical to base', () => {
    const scene = quantizedChunkedScene();
    const { device, bytes } = fakeDevice();
    // Same material colour, two cells 100 m apart: each base bucket is
    // cell-compact and quantizes; the overlay group spans both.
    scene.appendToBatches([triangle(1, [0.33, 0.2, 0.1]), triangle(2, [100.33, 0.2, 0.1])], device, fakePipeline);
    assert.strictEqual(scene.getBatchedMeshes().length, 2, 'sanity: one base batch per cell');
    for (const batch of scene.getBatchedMeshes()) assert.ok(batch.quantized, 'sanity: base batches quantize');

    scene.setColorOverrides(new Map([[1, RED], [2, RED]]), device, fakePipeline);

    const overlays = scene.getOverrideBatches();
    assert.ok(overlays.length > 0, 'overlay batches built');
    const covered = new Set(overlays.flatMap((b) => b.expressIds));
    assert.deepStrictEqual([...covered].sort(), [1, 2], 'every overridden entity is painted');
    for (const overlay of overlays) assertCoincidentWithBase(scene, overlay, bytes);
  });

  it('override on a small entity whose base batch fell back to f32 (a >64 m batchmate) renders f32 too', () => {
    const scene = quantizedChunkedScene();
    const { device, bytes } = fakeDevice();
    // Both anchor in cell (0,0,0); the wall's own extent forces the bucket to f32.
    scene.appendToBatches([longWall(10, [0.33, 0.2, 0.1]), triangle(11, [5.33, 0.2, 0.1])], device, fakePipeline);
    assert.strictEqual(scene.getBatchedMeshes().length, 1, 'sanity: one shared base batch');
    assert.strictEqual(scene.getBatchedMeshes()[0].quantized, undefined, 'sanity: base batch is f32');

    scene.setColorOverrides(new Map([[11, RED]]), device, fakePipeline);

    const overlays = scene.getOverrideBatches();
    assert.strictEqual(overlays.length, 1);
    assertCoincidentWithBase(scene, overlays[0], bytes);
  });

  it('a partial (visibility) sub-batch inherits its source batch quantization', () => {
    const scene = quantizedChunkedScene();
    const { device, bytes } = fakeDevice();
    scene.appendToBatches([longWall(10, [0.33, 0.2, 0.1]), triangle(11, [5.33, 0.2, 0.1])], device, fakePipeline);
    const base = scene.getBatchedMeshes()[0];
    assert.strictEqual(base.quantized, undefined, 'sanity: base batch is f32');

    // Hide the wall: the render loop draws the visible subset through a
    // partial sub-batch INSTEAD of the base, so overlays must match it too.
    const partial = scene.getOrCreatePartialBatch(`${base.id}:${base.colorKey}`, base.colorKey, new Set([11]), device, fakePipeline);
    assert.ok(partial, 'partial batch built');
    assertCoincidentWithBase(scene, partial, bytes);
  });

  it('a partial batch of an overflow "#N" bucket holds only that bucket\'s pieces and inherits ITS quantization', () => {
    const scene = quantizedChunkedScene();
    // One 28-byte-stride triangle is 84 vertex bytes; a limit of 150 × 0.9 = 135
    // fits one mesh, so the second same-cell, same-colour mesh overflows into
    // a "#N" sub-bucket. The wall makes the FIRST bucket f32; the triangle
    // alone in the overflow bucket quantizes.
    const { device, bytes } = fakeDevice(150);
    scene.appendToBatches([longWall(10, [0.33, 0.2, 0.1]), triangle(11, [5.33, 0.2, 0.1])], device, fakePipeline);
    const batches = scene.getBatchedMeshes();
    assert.strictEqual(batches.length, 2, 'sanity: overflow split into two buckets');
    const overflow = batches.find((b) => b.colorKey.includes('#'));
    assert.ok(overflow, 'sanity: an overflow "#N" bucket exists');
    assert.deepStrictEqual(overflow.expressIds, [11]);
    assert.ok(overflow.quantized, 'sanity: the overflow bucket quantizes on its own');

    // Both entities visible: the partial for the overflow batch must NOT pull
    // the wall in from the sibling bucket (it would be drawn twice and the
    // partial would inherit the sibling's f32 decision).
    const partial = scene.getOrCreatePartialBatch(`${overflow.id}:${overflow.colorKey}`, overflow.colorKey, new Set([10, 11]), device, fakePipeline);
    assert.ok(partial, 'partial batch built');
    assert.deepStrictEqual(partial.expressIds, [11], 'only the owning bucket\'s piece');
    assertCoincidentWithBase(scene, partial, bytes);
  });

  it('an unbucketed piece (picking-only addMeshData) never drags a bucketed piece into its overlay group', () => {
    const scene = quantizedChunkedScene();
    const { device, bytes } = fakeDevice();
    // Bucketed: the wall forces the shared cell (0,0,0) bucket to f32.
    scene.appendToBatches([longWall(10, [0.33, 0.2, 0.1]), triangle(11, [5.33, 0.2, 0.1])], device, fakePipeline);
    // Registered for picking only — no bucket — in the SAME cell and colour, so
    // its fallback key equals the real bucket's key.
    scene.addMeshData(triangle(12, [6.33, 0.2, 0.1]));

    // Unbucketed id first: grouped together, the whole group would take its
    // (absent) source and quantize on its own small extent against an f32 base.
    scene.setColorOverrides(new Map([[12, RED], [11, RED]]), device, fakePipeline);

    const overlays = scene.getOverrideBatches();
    const bucketedOverlay = overlays.find((b) => b.expressIds.includes(11));
    assert.ok(bucketedOverlay, 'overlay for the bucketed piece built');
    assert.deepStrictEqual(bucketedOverlay.expressIds, [11], 'not grouped with the unbucketed piece');
    assertCoincidentWithBase(scene, bucketedOverlay, bytes);
    const unbucketedOverlay = overlays.find((b) => b.expressIds.includes(12));
    assert.ok(unbucketedOverlay && unbucketedOverlay !== bucketedOverlay, 'the unbucketed piece is still painted, in its own batch');
  });

  for (const [label, finalize] of [
    ['finalizeStreaming', (s: Scene, d: GPUDevice) => { s.finalizeStreaming(d, fakePipeline); }],
    ['finalizeStreamingAsync', (s: Scene, d: GPUDevice) => s.finalizeStreamingAsync(d, fakePipeline)],
  ] as const) {
    it(`overrides applied mid-stream are rebuilt against the batches ${label} installs`, async () => {
      const scene = quantizedChunkedScene();
      const { device, bytes } = fakeDevice();
      scene.appendToBatches([longWall(10, [0.33, 0.2, 0.1]), triangle(11, [5.33, 0.2, 0.1])], device, fakePipeline, true);
      // Bucket exists but has no built batch yet: the overlay can only decide on
      // its own (small) extent, and quantizes.
      scene.setColorOverrides(new Map([[11, RED]]), device, fakePipeline);
      assert.ok(scene.getOverrideBatches()[0]?.quantized, 'sanity: mid-stream overlay quantized on its own extent');

      await finalize(scene, device);

      const base = scene.getBatchedMeshes();
      assert.strictEqual(base.length, 1, 'sanity: one finalized bucket batch');
      assert.strictEqual(base[0].quantized, undefined, 'sanity: the finalized base batch is f32 (the wall)');
      const overlays = scene.getOverrideBatches();
      assert.strictEqual(overlays.length, 1, 'overlay rebuilt, not duplicated');
      assertCoincidentWithBase(scene, overlays[0], bytes);
    });
  }

  it('a non-streaming bucket rebuild that flips the base to f32 rebuilds the installed overlay to match', () => {
    const scene = quantizedChunkedScene();
    const { device, bytes } = fakeDevice();
    scene.appendToBatches([triangle(11, [5.33, 0.2, 0.1]), triangle(12, [6.33, 0.2, 0.1])], device, fakePipeline);
    scene.setColorOverrides(new Map([[11, RED]]), device, fakePipeline);
    assert.ok(scene.getOverrideBatches()[0]?.quantized, 'sanity: overlay inherited a quantized base');

    // A >64 m wall lands in the same cell+colour bucket; rebuildPendingBatches
    // replaces the base batch with an f32 one. The overlay must follow.
    scene.appendToBatches([longWall(10, [0.33, 0.2, 0.1])], device, fakePipeline);
    const base = scene.getBatchedMeshes();
    assert.strictEqual(base.length, 1, 'sanity: still one bucket');
    assert.strictEqual(base[0].quantized, undefined, 'sanity: rebuilt base batch is f32');
    const overlays = scene.getOverrideBatches();
    assert.strictEqual(overlays.length, 1, 'overlay rebuilt, not duplicated');
    assertCoincidentWithBase(scene, overlays[0], bytes);
  });

  it('a non-streaming append that changes nothing under the overlay does NOT rebuild it', () => {
    const scene = quantizedChunkedScene();
    const { device } = fakeDevice();
    scene.appendToBatches([triangle(11, [5.33, 0.2, 0.1])], device, fakePipeline);
    scene.setColorOverrides(new Map([[11, RED]]), device, fakePipeline);
    const before = scene.getOverrideBatches()[0];
    assert.ok(before?.quantized, 'sanity: overlay inherited a quantized base');

    // Same cell + colour, small: the bucket is rebuilt but stays quantized and
    // the overridden piece stays in it — re-merging the overlay would only be
    // churn on every incremental add.
    scene.appendToBatches([triangle(12, [6.33, 0.2, 0.1])], device, fakePipeline);
    assert.strictEqual(scene.getOverrideBatches()[0], before, 'overlay batch identity preserved');
  });

  it('a recolour that moves the overridden piece to another bucket rebuilds the overlay against that bucket', () => {
    const scene = quantizedChunkedScene();
    const { device, bytes } = fakeDevice();
    scene.appendToBatches([longWall(10, [0.33, 0.2, 0.1]), triangle(11, [5.33, 0.2, 0.1])], device, fakePipeline);
    scene.setColorOverrides(new Map([[11, RED]]), device, fakePipeline);
    assert.strictEqual(scene.getOverrideBatches()[0]?.quantized, undefined, 'sanity: inherited the f32 wall bucket');

    // Material recolour moves the triangle into its own (small, quantized) bucket.
    scene.updateMeshColors(new Map([[11, [0.1, 0.2, 0.3, 1]]]), device, fakePipeline);
    const overlays = scene.getOverrideBatches();
    assert.strictEqual(overlays.length, 1);
    assertCoincidentWithBase(scene, overlays[0], bytes);
  });

  it('a derived batch that cannot honour an inherited quantization is reported, never silent', () => {
    const { device } = fakeDevice();
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      const batch = createSceneBatch([longWall(10, [0, 0, 0])], GREY, device, fakePipeline, {
        id: 0, colorKey: 'k', origin: [0, 0, 0], quantized: 'required', lod: false,
      });
      assert.strictEqual(batch.quantized, undefined, 'falls back to f32 rather than clamping');
    } finally {
      console.warn = original;
    }
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /4832/);
  });
});
