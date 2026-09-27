/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression test for issue #4832, plus the shared-frame cases of #4937 and
 * #5010.
 *
 * #4832 was first a colour-overlay bug (an equal-depth overlay batch that
 * decided its own quantization missed its base batch's depth). Overlays are
 * gone since #6076 — overrides shade from the entity colour table — but the
 * partial (visibility / X-Ray) sub-batches are still re-merges drawn INSTEAD
 * of their base batch, and must stay depth-coincident with it.
 *
 * The invariant pinned here: for every entity a partial batch carries, the
 * positions the GPU will see are bit-identical to those of the entity's base
 * batch, in BOTH directions of the fallback (derived f32 / base quantized,
 * and derived quantized / base f32).
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

/** Fake device that keeps every uploaded byte so batches can be read back. */
function fakeDevice(maxBufferSize = 1 << 30): { device: GPUDevice; bytes: WeakMap<GPUBuffer, ArrayBuffer> } {
  const bytes = new WeakMap<GPUBuffer, ArrayBuffer>();
  const device = {
    limits: { maxBufferSize, maxStorageBufferBindingSize: 1 << 30 },
    createBuffer: (desc: GPUBufferDescriptor) => {
      const buffer = { size: desc.size, destroy() {} } as unknown as GPUBuffer;
      bytes.set(buffer, new ArrayBuffer(desc.size));
      return buffer;
    },
    createBindGroup: () => ({}),
    queue: {
      writeBuffer: (buffer: GPUBuffer, offset: number, data: ArrayBufferView) => {
        const backing = bytes.get(buffer);
        if (!backing) throw new Error('writeBuffer into a buffer this device never created');
        new Uint8Array(backing, offset).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      },
    },
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

/** A valid triangle whose area is nonzero but below Number.EPSILON². */
function tinyTriangle(expressId: number, origin: [number, number, number]): MeshData {
  return {
    expressId,
    positions: new Float32Array([0, 0, 0, 1e-9, 0, 0, 0, 1e-9, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: GREY,
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

describe('derived batches stay depth-coincident with their base batches (#4832)', () => {
  it('keeps extracted merged geometry attached to its live source frame (#5010)', () => {
    const scene = quantizedChunkedScene();
    const { device } = fakeDevice();
    const nearby = triangle(1, [0, 0, 0]);
    const merged = { ...triangle(7, [800_000_000, 0, 0]), modelIndex: 4,
      entityIds: new Uint32Array([7, 7, 7]) } as MeshData;
    scene.appendToBatches([nearby, merged], device, fakePipeline);

    const extracted = scene.getMeshDataPieces(7, 4)![0];
    const sourceBatch = baseBatchFor(scene, 7);
    assert.strictEqual(extracted.modelIndex, 4, 'merged extraction retains federated model scope');
    assert.deepStrictEqual(scene.getSharedFrameOrigin(extracted.modelIndex, extracted), sourceBatch.origin,
      'derived highlight/pick geometry resolves its owning bucket, not the model-wide fallback');
    assert.strictEqual(scene.isMeshQuantized(extracted), sourceBatch.quantized !== undefined,
      'derived geometry inherits the source batch quantization decision');

    scene.setModelTranslation(4, [25, 0, 0]);
    assert.deepStrictEqual(scene.getSharedFrameOrigin(extracted.modelIndex, extracted), sourceBatch.origin,
      'provenance resolves through the placed source after a model translation');
  });

  it('rejects an exhausted frame before upload and preserves the prior scene (#5010)', () => {
    const scene = new Scene();
    const { device } = fakeDevice();
    const safe = triangle(1, [0, 0, 0]);
    scene.appendToBatches([safe], device, fakePipeline);
    const prior = scene.getBatchedMeshes()[0];
    let uploads = 0;
    const originalCreateBuffer = device.createBuffer.bind(device);
    (device as unknown as { createBuffer(desc: GPUBufferDescriptor): GPUBuffer }).createBuffer = (desc) => {
      uploads++;
      return originalCreateBuffer(desc);
    };

    const impossible = triangle(2, [Number.MAX_VALUE, 0, 0]);
    assert.throws(() => scene.appendToBatches([impossible], device, fakePipeline), /topology-safe GPU frame/);
    assert.strictEqual(uploads, 0, 'the rejected append reaches no GPU allocation');
    assert.deepStrictEqual(scene.getBatchedMeshes(), [prior], 'the prior drawable stays published');
    assert.strictEqual(scene.getMeshDataPieces(2), undefined, 'the rejected owner was never published');

    scene.appendToBatches([triangle(3, [5, 0, 0], RED)], device, fakePipeline);
    assert.strictEqual(scene.getBatchedMeshes().length, 2, 'a later safe append still succeeds');
  });

  it('keeps a legacy representative while precise paths retain every framed piece (#5010)', () => {
    const scene = new Scene();
    const { device } = fakeDevice();
    scene.appendToBatches([
      triangle(9, [0, 0, 0]),
      triangle(9, [800_000_000, 0, 0]),
    ], device, fakePipeline);

    const pieces = scene.getMeshDataPieces(9)!;
    assert.strictEqual(pieces.length, 2, 'precision routing made two source frames');
    const representative = scene.getMeshData(9)!;
    assert.equal(representative.indices.length, 6, 'legacy singular access retains both triangles');
    assert.equal(representative.origin, undefined, 'cross-bucket representative claims no invented precision frame');
    assert.equal(scene.raycast({ x: 0.2, y: 0.2, z: 2 }, { x: 0, y: 0, z: -1 })?.expressId, 9);
    assert.equal(scene.raycast({ x: 800_000_000.2, y: 0.2, z: 2 }, { x: 0, y: 0, z: -1 })?.expressId, 9,
      'the distant triangle remains available to the real CPU raycast');
  });

  it('rebases same-bucket pieces into their shared frame without losing triangles (#5010)', () => {
    const scene = new Scene();
    const { device } = fakeDevice();
    scene.appendToBatches([triangle(9, [0, 0, 0]), triangle(9, [5, 0, 0])], device, fakePipeline);

    const merged = scene.getMeshData(9)!;
    assert.equal(merged.indices.length, 6, 'both source triangles survive the singular merge');
    const worldX = Array.from(merged.positions, (value, index) => index % 3 === 0 ? value + merged.origin![0] : null)
      .filter((value): value is number => value !== null);
    assert.ok(worldX.some(value => Math.abs(value) < 0.001));
    assert.ok(worldX.some(value => Math.abs(value - 5) < 0.001));
  });

  it('precision-partitions distant same-colour components when chunks are disabled (#4937)', () => {
    const scene = new Scene();
    const { device, bytes } = fakeDevice();
    const west = triangle(1, [-398_700_000, 0, 0]);
    const east = triangle(2, [398_700_000, 0, 0]);
    const westRed = triangle(3, [-398_699_995, 0, 0], RED);
    scene.appendToBatches([west, westRed, east], device, fakePipeline);

    assert.strictEqual(scene.getBatchedMeshes().length, 3,
      'an unsafe automatic midpoint must split the grey components even without spatial chunks');
    assert.deepStrictEqual(baseBatchFor(scene, 1).origin, baseBatchFor(scene, 3).origin,
      'safe adjacent colour buckets retain the shared seam frame');
    for (const id of [1, 2, 3]) {
      const batch = baseBatchFor(scene, id);
      const positions = gpuPositionsByEntity(batch, bytes).get(id);
      assert.ok(positions);
      assert.strictEqual(new Set(positions).size, 3, `component ${id} retains its triangle`);
    }
  });

  it('keeps distant survey chunks in precision-local GPU frames (#4937)', () => {
    const scene = new Scene();
    scene.setSpatialChunking({ cellSize: 32 });
    const { device, bytes } = fakeDevice();
    const nearby = triangle(1, [2_600_005, 101, -5_000_005]);
    const distant = triangle(2, [800_000_000.5, 700_000_000, -900_000_000.5]);
    const distantBatchmate = triangle(3, [800_000_005.5, 700_000_000, -900_000_000.5]);
    scene.appendToBatches([nearby, distant, distantBatchmate], device, fakePipeline);

    const nearBatch = baseBatchFor(scene, 1);
    const distantBatch = baseBatchFor(scene, 2);
    assert.notDeepStrictEqual(distantBatch.origin, nearBatch.origin,
      'an unsafe model-wide origin must not collapse the distant chunk');
    assert.deepStrictEqual(scene.getSharedFrameOrigin(distant.modelIndex, distant), distantBatch.origin,
      'selection/picking uploads must inherit the base batch frame');
    const positions = gpuPositionsByEntity(distantBatch, bytes).get(2);
    assert.ok(positions);
    assert.strictEqual(new Set(positions).size, 3, 'the production GPU upload retains all triangle vertices');
  });

  it('protects every nonzero source triangle when choosing a shared frame (#4937)', () => {
    const scene = new Scene();
    scene.setSpatialChunking({ cellSize: 32 });
    const { device, bytes } = fakeDevice();
    const nearby = triangle(1, [0, 0, 0]);
    const distantTiny = tinyTriangle(2, [800_000_000, 0, 0]);
    scene.appendToBatches([nearby, distantTiny], device, fakePipeline);

    const tinyBatch = baseBatchFor(scene, 2);
    assert.notDeepStrictEqual(tinyBatch.origin, baseBatchFor(scene, 1).origin,
      'a shared origin that collapses a nonzero tiny triangle must be rejected');
    const positions = gpuPositionsByEntity(tinyBatch, bytes).get(2);
    assert.ok(positions);
    assert.strictEqual(new Set(positions).size, 3, 'all tiny triangle vertices survive GPU upload');
  });

  it('a partial (visibility) sub-batch inherits its source batch quantization', () => {
    const scene = quantizedChunkedScene();
    const { device, bytes } = fakeDevice();
    scene.appendToBatches([longWall(10, [0.33, 0.2, 0.1]), triangle(11, [5.33, 0.2, 0.1])], device, fakePipeline);
    const base = scene.getBatchedMeshes()[0];
    assert.strictEqual(base.quantized, undefined, 'sanity: base batch is f32');

    // Hide the wall: the render loop draws the visible subset through a
    // partial sub-batch INSTEAD of the base, so it must match the base.
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
