/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A colour override applied BEFORE an instanced shard arrives must reach the
 * occurrences in that shard (#3890).
 *
 * `addInstancedShard` already re-seeds a late shard's SELECTION: it checks each
 * arriving occurrence against `instancedSelected` and writes the flag, because
 * `setInstancedSelection` diffs by id and would early-return on an unchanged
 * set. Colour has exactly the same hole and had no such seeding.
 * `setInstancedColorOverrides` records the id in `instancedOverridden` even
 * when no occurrence exists yet to paint, so the intent survives; nothing
 * consulted it when the occurrence finally showed up.
 *
 * The viewer's catch-up (`useColorOverlaySync`) cannot cover this one. It is
 * driven by the geometry counter, and a streaming event carrying only
 * instanced shards appends through `appendInstancedShards`, which touches
 * `pendingInstancedShards` alone: `geometryResult` does not change, so the
 * counter never bumps and the catch-up is never scheduled.
 *
 * These assert on the bytes written to the instance colour lane, the same way
 * `scene-instanced-ghosting.test.ts` does. No GPU needed.
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

function fakeDevice() {
  const writes: Array<{ offset: number; data: number[] }> = [];
  const device = {
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
    createBuffer: (desc: { size: number }) => {
      const backing = new ArrayBuffer(desc.size);
      return { size: desc.size, getMappedRange: () => backing, unmap() {}, destroy() {} };
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

const ORIGINAL: [number, number, number, number] = [0.4, 0.5, 0.6, 1];

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
      color: ORIGINAL,
      transform: rowMajorTranslation(t),
    });
  }
  return { templates, instances, carriesItemIds: false };
}

const F32 = (n: number) => Math.fround(n);
const RED: [number, number, number, number] = [1, 0, 0, 1];
const BLUE: [number, number, number, number] = [0, 0, 1, 1];

/** The 4-float colour writes since the marker, in write order. */
function colorsSince(writes: Array<{ data: number[] }>, from: number): number[][] {
  return writes.slice(from).filter((w) => w.data.length === 4).map((w) => w.data);
}

describe('addInstancedShard applies a colour override recorded before the shard arrived (#3890)', () => {
  it('paints an occurrence whose shard streams in after the override', () => {
    const { device, writes } = fakeDevice();
    const scene = new Scene();
    // Entity 1's shard is here; entity 2's is still streaming.
    scene.addInstancedShard(device, shard([1]), 0);
    scene.setInstancedColorOverrides(new Map([[1, RED], [2, RED]]));
    const mark = writes.length;

    scene.addInstancedShard(device, shard([2]), 0);

    assert.deepEqual(
      colorsSince(writes, mark),
      [[F32(1), 0, 0, F32(1)]],
      'the late occurrence must be painted with the override that was already recorded',
    );
  });

  it('leaves an occurrence with no override at its uploaded colour', () => {
    const { device, writes } = fakeDevice();
    const scene = new Scene();
    scene.addInstancedShard(device, shard([1]), 0);
    scene.setInstancedColorOverrides(new Map([[1, RED]]));
    const mark = writes.length;

    // Entity 2 was never coloured.
    scene.addInstancedShard(device, shard([2]), 0);

    assert.deepEqual(colorsSince(writes, mark), [], 'nothing to paint, nothing written');
  });

  it('applies the newest override, not the one in force when the id was first named', () => {
    const { device, writes } = fakeDevice();
    const scene = new Scene();
    scene.addInstancedShard(device, shard([1]), 0);
    scene.setInstancedColorOverrides(new Map([[2, RED]]));
    scene.setInstancedColorOverrides(new Map([[2, BLUE]]));
    const mark = writes.length;

    scene.addInstancedShard(device, shard([2]), 0);

    assert.deepEqual(colorsSince(writes, mark), [[0, 0, F32(1), F32(1)]]);
  });

  it('does not repaint an id the user reset while its shard was still streaming', () => {
    const { device, writes } = fakeDevice();
    const scene = new Scene();
    scene.addInstancedShard(device, shard([1]), 0);
    scene.setInstancedColorOverrides(new Map([[1, RED], [2, RED]]));
    // The user un-colours the occurrence that has not arrived yet.
    scene.setInstancedColorOverrides(new Map([[1, RED]]));
    const mark = writes.length;

    scene.addInstancedShard(device, shard([2]), 0);

    assert.deepEqual(colorsSince(writes, mark), [], 'a reset id must arrive at its own colour');
  });

  it('keeps the ghost alpha for a further occurrence of an already-ghosted id', () => {
    const { device, writes } = fakeDevice();
    const scene = new Scene();
    scene.addInstancedShard(device, shard([1, 2]), 0);
    scene.setInstancedColorOverrides(new Map([[2, RED]]));
    // Ghost everything except entity 1, so entity 2 is faded and IS in the
    // ghost set by the time its next shard arrives.
    scene.setInstancedGhosting(new Set([1]), null, DEFAULT_GHOST_ALPHA);
    const mark = writes.length;

    scene.addInstancedShard(device, shard([2]), 0);

    // `writeInstanceColor` addresses every occurrence of the id, so entity 2's
    // pre-existing one is rewritten too. That is idempotent, and the same thing
    // the late-SELECTION seeding one line above it does.
    const painted = colorsSince(writes, mark);
    assert.equal(painted.length, 2, 'both of entity 2 occurrences are written');
    for (const write of painted) {
      assert.deepEqual(
        write,
        [F32(1), 0, 0, F32(DEFAULT_GHOST_ALPHA)],
        'the override RGB wins and X-Ray keeps the alpha, as on the flat path',
      );
    }
  });

  /**
   * An id the ghost set has never seen is a different case: `setInstancedGhosting`
   * enumerates `instancedEntityMap`, so an id with no occurrence yet is not in
   * `instancedGhosted`. `addInstancedShard` writes the plain override, then sets
   * `instancedGhostDirty` so the next ghosting pass folds in the fade. This pins
   * that hand-off, since the shard-time write alone looks like a missing fade.
   */
  it('hands a brand-new id to the next ghosting pass, which composes the fade', () => {
    const { device, writes } = fakeDevice();
    const scene = new Scene();
    scene.addInstancedShard(device, shard([1]), 0);
    scene.setInstancedColorOverrides(new Map([[2, RED]]));
    scene.setInstancedGhosting(new Set([1]), null, DEFAULT_GHOST_ALPHA);

    let mark = writes.length;
    scene.addInstancedShard(device, shard([2]), 0);
    assert.deepEqual(
      colorsSince(writes, mark),
      [[F32(1), 0, 0, F32(1)]],
      'at shard time the override lands solid: entity 2 is not in the ghost set yet',
    );

    mark = writes.length;
    scene.setInstancedGhosting(new Set([1]), null, DEFAULT_GHOST_ALPHA);
    assert.deepEqual(
      colorsSince(writes, mark),
      [[F32(1), 0, 0, F32(DEFAULT_GHOST_ALPHA)]],
      'the dirty flag makes the next pass fade it, keeping the override RGB',
    );
  });
});
