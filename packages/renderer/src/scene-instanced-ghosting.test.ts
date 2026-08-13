/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * X-Ray on GPU-instanced occurrences (#2606).
 *
 * The instanced pass used to receive only the hide and isolate sets, so
 * ghosting stopped at the flat geometry: on a model whose facade is instanced —
 * the #2558 tower is exactly that — the user asked to fade the building and got
 * a solid facade standing in front of a ghosted interior. The Cesium world view
 * had already started fading them (#2591), which is how the gap surfaced.
 *
 * These assert on the bytes written to the instance colour lane, since that is
 * where the fade actually lives. No GPU is needed: the scene only asks the
 * device for sized buffers and writes into them.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Scene } from './scene.js';
import { DEFAULT_GHOST_ALPHA } from './overlay-routing.js';
import type { DecodedInstancedShard } from '@ifc-lite/geometry';

(globalThis as Record<string, unknown>).GPUBufferUsage = {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};

/** Records every colour write so the fade can be read back. */
function fakeDevice() {
  const writes: Array<{ offset: number; data: number[] }> = [];
  const device = {
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
    createBuffer: (desc: { size: number }) => {
      const backing = new ArrayBuffer(desc.size);
      return {
        size: desc.size,
        getMappedRange: () => backing,
        unmap() {},
        destroy() {},
      };
    },
    queue: {
      writeBuffer: (_buf: unknown, offset: number, data: ArrayBufferView) => {
        writes.push({ offset, data: Array.from(new Float32Array((data as Float32Array).buffer)) });
      },
    },
  };
  return { device: device as unknown as GPUDevice, writes };
}

function rowMajorTranslation(x: number): Float32Array {
  return new Float32Array([1, 0, 0, x, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

/** One opaque unit-triangle occurrence per entity id. */
function shard(entityIds: number[]): DecodedInstancedShard {
  const templates = [];
  const instances = [];
  for (let t = 0; t < entityIds.length; t++) {
    templates.push({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
      origin: [0, 0, 0] as [number, number, number],
    });
    instances.push({
      templateIndex: t,
      entityId: entityIds[t],
      color: [0.4, 0.5, 0.6, 1] as [number, number, number, number],
      transform: rowMajorTranslation(t),
    });
  }
  return { templates, instances };
}

/** The instance colour lane is f32, so 0.12 reads back as 0.11999999…. Compare
 *  at the precision the GPU actually stores. */
const F32 = (n: number) => Math.fround(n);
const GHOST = F32(DEFAULT_GHOST_ALPHA);

/** The alphas written since the marker, in write order. */
function alphasSince(writes: Array<{ data: number[] }>, from: number): number[] {
  return writes.slice(from).filter((w) => w.data.length === 4).map((w) => w.data[3]);
}

function sceneWith(ids: number[]) {
  const { device, writes } = fakeDevice();
  const scene = new Scene();
  scene.addInstancedShard(device, shard(ids), 0);
  return { scene, device, writes };
}

describe('setInstancedGhosting (#2606)', () => {
  it('fades occurrences outside the except-set to the ghost alpha', () => {
    const { scene, writes } = sceneWith([1, 2]);
    const mark = writes.length;

    scene.setInstancedGhosting(new Set([1]), null, DEFAULT_GHOST_ALPHA);

    // Only entity 2 is outside the set, so exactly one fade is written.
    assert.deepEqual(alphasSince(writes, mark), [GHOST]);
  });

  it('leaves the excepted set solid', () => {
    const { scene, writes } = sceneWith([1, 2]);
    const mark = writes.length;

    scene.setInstancedGhosting(new Set([1, 2]), null, DEFAULT_GHOST_ALPHA);

    assert.deepEqual(alphasSince(writes, mark), [], 'nothing to fade, nothing written');
  });

  it('exempts the selection, as the flat path does', () => {
    const { scene, writes } = sceneWith([1, 2]);
    const mark = writes.length;

    scene.setInstancedGhosting(new Set([1]), new Set([2]), DEFAULT_GHOST_ALPHA);

    assert.deepEqual(alphasSince(writes, mark), [], 'the selected occurrence stays solid');
  });

  it('restores the original alpha when X-Ray is cleared', () => {
    const { scene, writes } = sceneWith([1, 2]);
    scene.setInstancedGhosting(new Set([1]), null, DEFAULT_GHOST_ALPHA);
    const mark = writes.length;

    scene.setInstancedGhosting(null, null, DEFAULT_GHOST_ALPHA);

    assert.deepEqual(alphasSince(writes, mark), [1], 'back to the occurrence colour');
  });

  it('reports translucent instances, so the transparent sub-pass runs', () => {
    const { scene } = sceneWith([1, 2]);
    assert.equal(scene.hasTransparentInstances(), false);

    scene.setInstancedGhosting(new Set([1]), null, DEFAULT_GHOST_ALPHA);
    assert.equal(scene.hasTransparentInstances(), true, 'a fade nobody draws is not a fade');

    scene.setInstancedGhosting(null, null, DEFAULT_GHOST_ALPHA);
    assert.equal(scene.hasTransparentInstances(), false);
  });

  it('writes nothing when the ghost set has not changed', () => {
    const { scene, writes } = sceneWith([1, 2]);
    scene.setInstancedGhosting(new Set([1]), null, DEFAULT_GHOST_ALPHA);
    const mark = writes.length;

    scene.setInstancedGhosting(new Set([1]), null, DEFAULT_GHOST_ALPHA);

    assert.deepEqual(alphasSince(writes, mark), [], 'a per-frame call must be a no-op');
  });

  it('ghosts everything for an empty except-set, which is not the same as null', () => {
    const { scene, writes } = sceneWith([1, 2]);
    const mark = writes.length;

    scene.setInstancedGhosting(new Set(), null, DEFAULT_GHOST_ALPHA);

    assert.deepEqual(alphasSince(writes, mark), [GHOST, GHOST]);
  });

  it('keeps a colour override\'s RGB while ghosting it', () => {
    const { scene, writes } = sceneWith([1, 2]);
    scene.setInstancedColorOverrides(new Map([[2, [1, 0, 0, 1] as const]]));
    const mark = writes.length;

    scene.setInstancedGhosting(new Set([1]), null, DEFAULT_GHOST_ALPHA);

    const faded = writes.slice(mark).filter((w) => w.data.length === 4).at(-1);
    assert.deepEqual(faded?.data.slice(0, 3), [1, 0, 0], 'the lens tint survives the fade');
    assert.equal(faded?.data[3], GHOST);
  });

  it('restores to the override, not the original colour, when X-Ray clears', () => {
    const { scene, writes } = sceneWith([1, 2]);
    scene.setInstancedColorOverrides(new Map([[2, [1, 0, 0, 1] as const]]));
    scene.setInstancedGhosting(new Set([1]), null, DEFAULT_GHOST_ALPHA);
    const mark = writes.length;

    scene.setInstancedGhosting(null, null, DEFAULT_GHOST_ALPHA);

    const restored = writes.slice(mark).filter((w) => w.data.length === 4).at(-1);
    assert.deepEqual(restored?.data, [1, 0, 0, 1], 'the lens tint must not be lost');
  });
});
