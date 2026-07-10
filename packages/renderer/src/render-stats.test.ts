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
