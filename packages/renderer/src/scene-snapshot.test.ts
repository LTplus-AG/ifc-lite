/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { BATCH_CONSTANTS } from './constants.js';
import { LOD_MIN_TRIANGLES } from './lod-simplify.js';
import { decodeSceneSnapshot, encodeSceneSnapshot, encodeSceneSnapshotInSlices, SCENE_SNAPSHOT_REVISION, sceneSnapshotPolicy, type SceneSnapshot } from './scene-snapshot.js';

function snapshot(): SceneSnapshot {
  return {
    policy: 'p', pieceCount: 2, nextSplitId: 3,
    sharedFrameOrigins: [[0, [1, 2, 3]]],
    activeBuckets: [['base', 'base#2']],
    batches: [{
      key: 'base#2', color: [1, 0, 0, 1], finish: { metallic: 0.5 }, origin: [1, 2, 3],
      bounds: { min: [0, 0, 0], max: [1, 1, 1] }, quantized: { min: [0, 0, 0], step: 0.5 }, modelIndex: 0, vertexBytes: 84,
      expressIds: new Uint32Array([7, 8]), ordinals: new Uint32Array([1, 0]),
      vertexData: new Uint8Array([1, 2, 3, 4, 5]), indices: new Uint32Array([0, 1, 2]), lod1Indices: new Uint32Array([0, 1, 2]),
    }],
    hostData: { any: 'json' },
  };
}

const encoded = async (s = snapshot()) => encodeSceneSnapshot(s).arrayBuffer();

describe('scene snapshot format', () => {
  it('round-trips every field', async () => {
    assert.deepStrictEqual(decodeSceneSnapshot(await encoded()), snapshot());
  });

  it('returns payloads aligned for typed-array views after a table of any length', async () => {
    for (const pad of ['', 'x', 'xx', 'xxx', 'xxxxxxx']) {
      const bytes = await encoded({ ...snapshot(), policy: pad });
      const decoded = decodeSceneSnapshot(bytes);
      assert.strictEqual(decoded?.policy, pad);
      assert.deepStrictEqual([...decoded!.batches[0].indices], [0, 1, 2]);
    }
  });

  it('refuses another revision, a damaged table and truncated payloads', async () => {
    const revised = await encoded();
    new DataView(revised).setUint32(4, SCENE_SNAPSHOT_REVISION + 1, true);
    assert.strictEqual(decodeSceneSnapshot(revised), null);

    const damaged = await encoded();
    new Uint8Array(damaged)[20] ^= 0xff;
    assert.strictEqual(decodeSceneSnapshot(damaged), null);

    const whole = await encoded();
    assert.strictEqual(decodeSceneSnapshot(whole.slice(0, whole.byteLength - 16)), null);
    assert.strictEqual(decodeSceneSnapshot(new ArrayBuffer(4)), null);
  });

  it('writes the same bytes a slice at a time, yielding between slices', async () => {
    const big = snapshot();
    big.batches = Array.from({ length: 5 }, (_, i) => ({ ...snapshot().batches[0], key: `b${i}`, vertexData: new Uint8Array(1000 + i).fill(i) }));
    let yields = 0;
    const sliced = await encodeSceneSnapshotInSlices(big, async () => { yields++; }, 1024);
    assert.deepStrictEqual(new Uint8Array(await sliced.arrayBuffer()), new Uint8Array(await encoded(big)));
    assert.ok(yields >= 4, `one yield per filled slice, got ${yields}`);
    assert.deepStrictEqual(decodeSceneSnapshot(await sliced.arrayBuffer())?.batches.map((b) => b.vertexData.byteLength), [1000, 1001, 1002, 1003, 1004]);
  });

  // If this fails you changed what a batch's bytes mean: bump
  // SCENE_SNAPSHOT_REVISION as well as these values, or stale snapshots draw garbage.
  it('pins the layout constants behind the revision', () => {
    assert.deepStrictEqual([SCENE_SNAPSHOT_REVISION, BATCH_CONSTANTS.BYTES_PER_VERTEX, LOD_MIN_TRIANGLES], [3, 28, 500]);
    assert.strictEqual(sceneSnapshotPolicy(true, false, null), '3|28|q|nolod|nochunk');
    assert.strictEqual(sceneSnapshotPolicy(false, true, { cellSize: 40 }), `3|28|f|lod${LOD_MIN_TRIANGLES}|40`);
  });
});
