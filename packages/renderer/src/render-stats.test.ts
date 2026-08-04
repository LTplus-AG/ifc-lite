/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { sumResidentGpuBytes } from './render-stats.ts';

const buf = (size: number) => ({ size });

describe('sumResidentGpuBytes', () => {
  it('returns zeros for an empty scene', () => {
    const r = sumResidentGpuBytes({
      batches: [],
      partialBatches: [],
      meshes: [],
      textured: [],
      instanced: [],
    });
    assert.deepStrictEqual(r, { batches: 0, meshes: 0, textured: 0, instanced: 0, total: 0 });
  });

  it('sums vertex + index + optional uniform per batch, incl. partial sub-batches', () => {
    const r = sumResidentGpuBytes({
      batches: [
        { vertexBuffer: buf(1000), indexBuffer: buf(400), uniformBuffer: buf(224) },
        { vertexBuffer: buf(2000), indexBuffer: buf(800) }, // no uniform yet
      ],
      partialBatches: [{ vertexBuffer: buf(100), indexBuffer: buf(40), uniformBuffer: buf(224) }],
      meshes: [],
      textured: [],
      instanced: [],
    });
    assert.strictEqual(r.batches, 1000 + 400 + 224 + 2000 + 800 + 100 + 40 + 224);
    assert.strictEqual(r.total, r.batches);
  });

  // The LOD1 index buffer (#1682 phase 5) is a SECOND index buffer allocated
  // alongside the batch. It is real GPU memory and the residency budget is
  // what decides when to evict — under-counting it makes the renderer believe
  // it is inside a budget it has actually blown, so eviction never fires and
  // large models drift toward GPU OOM / driver-level allocation failures.
  // No existing fixture sets `lod1IndexBuffer`, so its contribution was free.
  it('counts the LOD1 index buffer when a batch has one built', () => {
    const withoutLod = sumResidentGpuBytes({
      batches: [{ vertexBuffer: buf(1000), indexBuffer: buf(400), uniformBuffer: buf(224) }],
      partialBatches: [],
      meshes: [],
      textured: [],
      instanced: [],
    });
    assert.strictEqual(withoutLod.batches, 1000 + 400 + 224);

    const withLod = sumResidentGpuBytes({
      batches: [
        {
          vertexBuffer: buf(1000),
          indexBuffer: buf(400),
          uniformBuffer: buf(224),
          lod1IndexBuffer: buf(128),
        },
      ],
      partialBatches: [],
      meshes: [],
      textured: [],
      instanced: [],
    });
    assert.strictEqual(withLod.batches, 1000 + 400 + 224 + 128);
    assert.strictEqual(withLod.total, withoutLod.total + 128);

    // Same accounting on every collection that flows through `sumBatch`.
    const viaMeshesAndPartials = sumResidentGpuBytes({
      batches: [],
      partialBatches: [
        { vertexBuffer: buf(10), indexBuffer: buf(4), lod1IndexBuffer: buf(2) },
      ],
      meshes: [{ vertexBuffer: buf(10), indexBuffer: buf(4), lod1IndexBuffer: buf(6) }],
      textured: [],
      instanced: [],
    });
    assert.strictEqual(viaMeshesAndPartials.batches, 10 + 4 + 2);
    assert.strictEqual(viaMeshesAndPartials.meshes, 10 + 4 + 6);
  });

  it('estimates textures at 4 bytes per texel across array layers', () => {
    const r = sumResidentGpuBytes({
      batches: [],
      partialBatches: [],
      meshes: [],
      textured: [{
        vertexBuffer: buf(360),
        indexBuffer: buf(120),
        uniformBuffer: buf(224),
        texture: { width: 16, height: 8, depthOrArrayLayers: 2 },
      }],
      instanced: [],
    });
    assert.strictEqual(r.textured, 360 + 120 + 224 + 16 * 8 * 2 * 4);
  });

  it('counts instanced templates including the per-occurrence instance buffer', () => {
    const r = sumResidentGpuBytes({
      batches: [],
      partialBatches: [],
      meshes: [{ vertexBuffer: buf(280), indexBuffer: buf(120), uniformBuffer: buf(224) }],
      textured: [],
      instanced: [{ vertexBuffer: buf(2800), indexBuffer: buf(1200), instanceBuffer: buf(88 * 32) }],
    });
    assert.strictEqual(r.meshes, 280 + 120 + 224);
    assert.strictEqual(r.instanced, 2800 + 1200 + 88 * 32);
    assert.strictEqual(r.total, r.meshes + r.instanced);
  });
});
