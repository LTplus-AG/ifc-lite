/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { Scene } from './scene.js';
import { expandAppearanceCorners } from './appearance-uvs.js';

(globalThis as Record<string, unknown>).GPUBufferUsage = {
  COPY_DST: 8,
  INDEX: 16,
  VERTEX: 32,
  UNIFORM: 64,
};
(globalThis as Record<string, unknown>).GPUTextureUsage = {
  COPY_DST: 2,
  TEXTURE_BINDING: 4,
};

function gpu() {
  const textures: {
    destroyed: number;
    destroy(): void;
    createView(): object;
  }[] = [];
  const buffers: { destroyed: number; destroy(): void; size: number }[] = [];
  const failures = { writeTexture: false, writeBufferOnce: false, batchBindGroupAt: 0 };
  let batchBindGroups = 0;
  let writes = 0;
  const device = {
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
    createBuffer: (descriptor: GPUBufferDescriptor) => {
      const data = new ArrayBuffer(descriptor.size);
      const buffer = {
        destroyed: 0,
        destroy() {
          this.destroyed++;
        },
        size: descriptor.size,
        getMappedRange: () => data,
        unmap() {},
      };
      buffers.push(buffer);
      return buffer;
    },
    createBindGroup: () => {
      if (++batchBindGroups === failures.batchBindGroupAt)
        throw new Error('injected batch bind group failure');
      return {};
    },
    createSampler: () => ({}),
    createTexture: () => {
      const texture = {
        destroyed: 0,
        destroy() {
          this.destroyed++;
        },
        createView: () => ({}),
      };
      textures.push(texture);
      return texture;
    },
    queue: {
      writeBuffer() {
        if (failures.writeBufferOnce) { failures.writeBufferOnce = false; throw new Error('injected buffer upload failure'); }
      },
      writeTexture() {
        if (failures.writeTexture)
          throw new Error('injected texture upload failure');
        writes++;
      },
    },
  };
  return {
    device: device as unknown as GPUDevice,
    textures,
    buffers,
    failures,
    get batchBindGroups() {
      return batchBindGroups;
    },
    get writes() {
      return writes;
    },
  };
}

function mesh(expressId: number, rgba: Uint8Array): MeshData {
  return {
    expressId,
    color: [1, 1, 1, 1],
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    texture: {
      rgba,
      width: 1,
      height: 1,
      repeatS: expressId === 1,
      repeatT: false,
    },
  };
}

const pipeline = {
  getUniformBufferSize: () => 256,
  getBindGroupLayout: () => ({}),
  createTexturedBindGroup: () => ({}),
} as unknown as Parameters<Scene['appendToBatches']>[2];

// #4243: Model translations retain placed wrappers. Preview edits must use the
// canonical Scene pieces, as the production viewer binder does after loading.
function residentParts(scene: Scene, sources: readonly MeshData[]): MeshData[] {
  return [...new Set(sources.map(part => part.expressId))].flatMap(id => scene.getMeshDataPieces(id)!);
}

describe('owned appearance preview (#4243)', () => {
  function setup() {
    const scene = new Scene(),
      state = gpu();
    const originals = [
      mesh(7, new Uint8Array([255, 0, 0, 255])),
      mesh(7, new Uint8Array([0, 255, 0, 255])),
    ];
    scene.appendToBatches(originals, state.device, pipeline);
    const api = scene.appearancePreview(state.device, pipeline);
    return { scene, state, originals: residentParts(scene, originals), api };
  }
  it('keeps all original parts alive, swaps without duplicates, and cancels without upload', () => {
    const { scene, state, originals, api } = setup();
    const originalGpu = [...scene.getTexturedMeshes()];
    const token = api.begin({ expressId: 7, modelIndex: 0 });
    const rgba = new Uint8Array([0, 0, 255, 255]);
    const parts = originals.map((part) => ({
      ...part,
      texture: { rgba, width: 1, height: 1, repeatS: true, repeatT: true },
    }));
    api.update(token, parts);
    assert.equal(scene.getTexturedMeshes().length, 2);
    assert.equal(state.textures.length, 3);
    assert.ok(state.textures.every((texture) => texture.destroyed === 0));
    api.update(
      token,
      parts.map((part) => ({
        ...part,
        uvs: new Float32Array([1, 1, 2, 1, 1, 2]),
      })),
    );
    assert.equal(scene.getTexturedMeshes().length, 2);
    assert.equal(
      state.textures.length,
      3,
      'same image keeps one GPU allocation across updates',
    );
    assert.equal(scene.getMeshDataPieces(7)?.length, 2);
    assert.strictEqual(
      scene.getMeshDataPieces(7)?.[0].positions,
      originals[0].positions,
    );
    api.cancel(token);
    assert.deepEqual(scene.getTexturedMeshes(), originalGpu);
    assert.strictEqual(
      scene.getMeshDataPieces(7)?.[0].texture,
      originals[0].texture,
    );
    assert.deepEqual(
      state.textures.map((t) => t.destroyed),
      [0, 0, 1],
    );
    assert.doesNotThrow(() => api.cancel(token));
    scene.clearFlatGeometry();
    assert.ok(state.buffers.every((buffer) => buffer.destroyed === 1));
  });
  it('commits CPU history while releasing original GPU ownership and invalidating the token', () => {
    const { scene, state, originals, api } = setup();
    const token = api.begin({ expressId: 7, modelIndex: 0 });
    const parts = originals.map((part) => ({
      ...part,
      texture: { ...part.texture!, rgba: new Uint8Array([1, 2, 3, 255]) },
    }));
    api.update(token, parts);
    const result = api.commit(token);
    assert.equal(result.before.length, 2);
    assert.equal(result.after.length, 2);
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.after));
    assert.deepEqual(
      state.textures.map((t) => t.destroyed),
      [1, 1, 0, 0],
    );
    const next = api.begin({ expressId: 7, modelIndex: 0 });
    assert.throws(() => api.update(token, originals), /Stale/);
    api.cancel(next);
    assert.strictEqual(
      scene.getMeshDataPieces(7)?.[0].texture,
      parts[0].texture,
    );
    scene.clearFlatGeometry();
    assert.ok(state.textures.every((texture) => texture.destroyed === 1));
  });
  it('rolls back a partial staged upload without removing any live resource', () => {
    const { scene, state, originals } = setup();
    const originalGpu = [...scene.getTexturedMeshes()];
    let calls = 0;
    const failingPipeline = {
      ...pipeline,
      createTexturedBindGroup() {
        if (++calls === 2) throw new Error('second part failed');
        return {};
      },
    } as unknown as typeof pipeline;
    // Controller is created lazily: a separate scene installs the injected pipeline.
    const failedScene = new Scene();
    failedScene.appendToBatches(originals, state.device, pipeline);
    const failedOriginals = residentParts(failedScene, originals);
    const failedGpu = [...failedScene.getTexturedMeshes()];
    const failing = failedScene.appearancePreview(
      state.device,
      failingPipeline,
    );
    const token = failing.begin({ expressId: 7, modelIndex: 0 });
    const parts = failedOriginals.map((part) => ({
      ...part,
      texture: { ...part.texture!, rgba: new Uint8Array(4) },
    }));
    assert.throws(() => failing.update(token, parts), /second part failed/);
    assert.deepEqual(failedScene.getTexturedMeshes(), failedGpu);
    assert.strictEqual(failedScene.getMeshDataPieces(7)?.[0], failedOriginals[0]);
    assert.deepEqual(scene.getTexturedMeshes(), originalGpu);
    failing.cancel(token);
    failedScene.clearFlatGeometry();
    scene.clearFlatGeometry();
    assert.ok(state.textures.every((texture) => texture.destroyed === 1));
    assert.ok(state.buffers.every((buffer) => buffer.destroyed === 1));
  });
  it('rejects wrong owners, foreign tokens, missing parts and geometry changes before upload', () => {
    const { scene, state, originals, api } = setup();
    assert.throws(() => api.begin({ expressId: 7, modelIndex: 1 }), /resident/);
    const token = api.begin({ expressId: 7, modelIndex: 0 });
    assert.throws(() => api.begin(token.owner), /already owns/);
    assert.throws(() => api.cancel({ owner: token.owner }), /Foreign/);
    assert.throws(
      () => api.update(token, originals.slice(0, 1)),
      /every original/,
    );
    assert.throws(
      () =>
        api.update(
          token,
          originals.map((p) => ({ ...p, positions: p.positions.slice() })),
        ),
      /geometry/,
    );
    assert.throws(
      () =>
        api.update(
          token,
          originals.map((p) => ({ ...p, uvs: new Float32Array(1) })),
        ),
      /finite UVs/,
    );
    assert.equal(state.textures.length, 2);
    scene.removeMeshesForEntity(7);
    assert.throws(() => api.commit(token), /Stale/);
    assert.equal(scene.getTexturedMeshes().length, 0);
  });
  it('a geometry edit cancels the draft before moving and invalidates its token', () => {
    const { scene, state, originals, api } = setup();
    const token = api.begin({ expressId: 7, modelIndex: 0 });
    api.update(
      token,
      originals.map((p) => ({
        ...p,
        texture: { ...p.texture!, rgba: new Uint8Array(4) },
      })),
    );
    scene.translateMeshesForEntity(7, [10, 0, 0]);
    assert.doesNotThrow(() => api.cancel(token));
    assert.strictEqual(
      scene.getMeshDataPieces(7)?.[0].texture,
      originals[0].texture,
    );
    assert.equal(scene.getMeshDataPieces(7)?.[0].positions[0], 10);
    scene.clearFlatGeometry();
    assert.ok(state.textures.every((texture) => texture.destroyed === 1));
  });
  it('teardown releases hidden originals and active drafts exactly once', () => {
    const { scene, state, originals, api } = setup();
    const token = api.begin({ expressId: 7, modelIndex: 0 });
    api.update(
      token,
      originals.map((p) => ({
        ...p,
        texture: { ...p.texture!, rgba: new Uint8Array(4) },
      })),
    );
    scene.clearFlatGeometry();
    assert.ok(state.textures.every((texture) => texture.destroyed === 1));
    assert.ok(state.buffers.every((buffer) => buffer.destroyed === 1));
    assert.doesNotThrow(() => api.cancel(token));
  });
});

describe('whole appearance command GPU commit (#4243)', () => {
  it('a stale later owner cannot consume an earlier owner', () => {
    const scene = new Scene(),
      state = gpu();
    const parts = [mesh(7, new Uint8Array(4)), mesh(8, new Uint8Array(4))];
    scene.appendToBatches(parts, state.device, pipeline);
    parts.splice(0, parts.length, ...residentParts(scene, parts));
    const api = scene.appearancePreview(state.device, pipeline);
    const a = api.begin({ expressId: 7, modelIndex: 0 }),
      b = api.begin({ expressId: 8, modelIndex: 0 });
    api.update(a, [
      {
        ...parts[0],
        texture: { ...parts[0].texture!, rgba: new Uint8Array(4) },
      },
    ]);
    api.update(b, [
      {
        ...parts[1],
        texture: { ...parts[1].texture!, rgba: new Uint8Array(4) },
      },
    ]);
    const commit = api.prepareCommit([a, b]);
    api.cancel(b);
    assert.throws(commit, /Stale/);
    assert.equal(
      state.textures[0].destroyed,
      0,
      'earlier original must still be owned',
    );
    api.cancel(a);
    assert.strictEqual(
      scene.getMeshDataPieces(7)?.[0].texture,
      parts[0].texture,
    );
    scene.clearFlatGeometry();
    assert.ok(state.textures.every((texture) => texture.destroyed === 1));
  });
  it('an updated prepared owner fences the entire commit; a successful commit is idempotent', () => {
    const scene = new Scene(),
      state = gpu(),
      source = mesh(7, new Uint8Array(4));
    let original = source;
    scene.appendToBatches([original], state.device, pipeline);
    original = scene.getMeshDataPieces(7)![0];
    const api = scene.appearancePreview(state.device, pipeline),
      token = api.begin({ expressId: 7, modelIndex: 0 });
    const stale = api.prepareCommit([token]);
    api.update(token, [
      {
        ...original,
        texture: { ...original.texture!, rgba: new Uint8Array(4) },
      },
    ]);
    assert.throws(stale, /changed after preparing/);
    const commit = api.prepareCommit([token]),
      result = commit();
    assert.strictEqual(commit(), result);
    assert.equal(state.textures[0].destroyed, 1);
    scene.clearFlatGeometry();
    assert.ok(state.textures.every((texture) => texture.destroyed === 1));
  });
  it('GPU disposal failures cannot partially consume a committed command', (t) => {
    const scene = new Scene(),
      state = gpu();
    const parts = [mesh(7, new Uint8Array(4)), mesh(8, new Uint8Array(4))];
    scene.appendToBatches(parts, state.device, pipeline);
    parts.splice(0, parts.length, ...residentParts(scene, parts));
    const api = scene.appearancePreview(state.device, pipeline);
    const tokens = parts.map((part) => {
      const token = api.begin({ expressId: part.expressId, modelIndex: 0 });
      api.update(token, [
        { ...part, texture: { ...part.texture!, rgba: new Uint8Array(4) } },
      ]);
      return token;
    });
    state.textures[0].destroy = function () {
      this.destroyed++;
      throw new Error('device disposal failure');
    };
    const warning = t.mock.method(console, 'warn', () => {});
    assert.equal(api.prepareCommit(tokens)().length, 2);
    assert.equal(warning.mock.callCount(), 1);
    assert.equal(
      state.textures[1].destroyed,
      1,
      'the second owner still releases its original',
    );
    for (const token of tokens) assert.doesNotThrow(() => api.cancel(token));
    scene.clearFlatGeometry();
    assert.ok(state.textures.every((texture) => texture.destroyed === 1));
  });
});

describe('flat batch appearance ownership (#4243)', () => {
  function setup() {
    const scene = new Scene(),
      state = gpu();
    const parts: MeshData[] = [7, 8, 9].map((id) => {
      const source = mesh(id, new Uint8Array(4));
      return { ...source, texture: undefined, uvs: undefined };
    });
    scene.appendToBatches(parts, state.device, pipeline);
    parts.splice(0, parts.length, ...residentParts(scene, parts));
    return {
      scene,
      state,
      parts,
      api: scene.appearancePreview(state.device, pipeline),
    };
  }
  const ids = (scene: Scene) =>
    scene
      .getBatchedMeshes()
      .flatMap((batch) => batch.expressIds)
      .sort();
  it('isolates owners sharing a batch; cancel order and undo retain every draw/pick identity', () => {
    const { scene, state, parts, api } = setup();
    assert.equal(scene.getBatchedMeshes().length, 1);
    const first = api.begin({ expressId: 7, modelIndex: 0 });
    const second = api.begin({ expressId: 8, modelIndex: 0 });
    for (const [index, token] of [first, second].entries())
      api.update(token, [
        {
          ...parts[index],
          texture: mesh(0, new Uint8Array(4)).texture,
          uvs: new Float32Array(6),
        },
      ]);
    assert.deepEqual(ids(scene), [9]);
    assert.deepEqual(
      scene
        .getTexturedMeshes()
        .map((part) => part.expressId)
        .sort(),
      [7, 8],
    );
    api.cancel(first);
    assert.deepEqual(ids(scene), [7, 9]);
    const change = api.commit(second);
    const undo = api.begin({ expressId: 8, modelIndex: 0 });
    api.update(undo, change.before);
    api.commit(undo);
    assert.deepEqual(ids(scene), [7, 8, 9]);
    assert.equal(scene.getTexturedMeshes().length, 0);
    assert.equal(
      scene.getBatchedMeshes().length,
      1,
      'undo rejoins the original cohort',
    );
    const fresh = api.begin({ expressId: 7, modelIndex: 0 });
    api.cancel(first); // Old cleanup must not cancel the new owner.
    assert.doesNotThrow(() => api.commit(fresh));
    scene.clearFlatGeometry();
    assert.ok(state.buffers.every((buffer) => buffer.destroyed === 1));
    assert.ok(state.textures.every((texture) => texture.destroyed === 1));
  });
  it('cancel all rejoins only the original batch and failed coalescing keeps split geometry valid', (t) => {
    const { scene, state, api } = setup();
    const a = api.begin({ expressId: 7, modelIndex: 0 });
    const b = api.begin({ expressId: 8, modelIndex: 0 });
    api.cancel(b);
    assert.equal(
      scene.getBatchedMeshes().length,
      3,
      'another draft still owns a split',
    );
    api.cancel(a);
    assert.equal(scene.getBatchedMeshes().length, 1);
    assert.deepEqual(ids(scene), [7, 8, 9]);
    const c = api.begin({ expressId: 7, modelIndex: 0 });
    const warning = t.mock.method(console, 'warn', () => {});
    // Fail the next batch bind group, after candidate buffers have allocated.
    state.failures.batchBindGroupAt = state.batchBindGroups + 1;
    api.cancel(c);
    assert.equal(warning.mock.callCount(), 1);
    assert.equal(scene.getBatchedMeshes().length, 2);
    assert.deepEqual(ids(scene), [7, 8, 9]);
    const retry = api.begin({ expressId: 7, modelIndex: 0 });
    api.cancel(retry);
    assert.equal(
      scene.getBatchedMeshes().length,
      1,
      'a later close retries coalescing',
    );
    scene.clearFlatGeometry();
    assert.ok(state.buffers.every((buffer) => buffer.destroyed === 1));
  });
  it('entity removal and reused IDs cannot reconnect a stale model cohort', () => {
    const { scene, state, api, parts } = setup();
    const removed = api.begin({ expressId: 7, modelIndex: 0 });
    scene.removeMeshesForEntity(7);
    api.cancel(removed);
    const replacement = { ...parts[0], modelIndex: 2 };
    scene.appendToBatches([replacement], state.device, pipeline);
    assert.throws(() => api.begin({ expressId: 7, modelIndex: 0 }), /resident/);
    const token = api.begin({ expressId: 7, modelIndex: 2 });
    api.cancel(token);
    assert.deepEqual(ids(scene), [7, 8, 9]);
    const owner = scene
      .getBatchedMeshes()
      .flatMap((batch) =>
        batch.expressIds.map((id, i) => [id, batch.modelIndices?.[i]]),
      );
    assert.deepEqual(
      owner.find(([id]) => id === 7),
      [7, 2],
    );
    scene.clearFlatGeometry();
    assert.ok(state.buffers.every((buffer) => buffer.destroyed === 1));
    scene.appendToBatches([replacement], state.device, pipeline);
    const fresh = api.begin({ expressId: 7, modelIndex: 2 });
    api.cancel(fresh);
    assert.deepEqual(ids(scene), [7]);
    scene.clearFlatGeometry();
    assert.ok(state.buffers.every((buffer) => buffer.destroyed === 1));
  });
  it('textures welded corners and restores compressed geometry on undo without moving bounds', () => {
    const scene = new Scene(),
      state = gpu();
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
    let original: MeshData = {
      expressId: 7,
      geometryItemId: 21,
      color: [1, 1, 1, 1],
      indices,
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
      normals: new Float32Array(12),
      appearanceSource: {
        kind: 'canonical-item',
        indices,
        sourceIndices: indices,
      },
    };
    scene.appendToBatches([original], state.device, pipeline);
    original = scene.getMeshDataPieces(7)![0];
    const bounds = scene.getEntityBoundingBox(7);
    const api = scene.appearancePreview(state.device, pipeline),
      token = api.begin({ expressId: 7, modelIndex: 0 });
    const expanded = expandAppearanceCorners(
      original,
      indices,
      [0, 0, 1, 0, 1, 1, 0.5, 0.5, 0.5, 1, 0, 1],
      new Uint32Array([0, 1, 2, 3, 4, 5]),
      new Float32Array(18).fill(0.0005),
      6,
    );
    api.update(token, [
      { ...expanded, texture: mesh(0, new Uint8Array(4)).texture },
    ]);
    const change = api.commit(token);
    assert.equal(scene.getMeshDataPieces(7)![0].positions.length / 3, 6);
    assert.deepEqual(scene.getMeshDataPieces(7)![0].normals, expanded.normals);
    assert.deepEqual(scene.getEntityBoundingBox(7), bounds);
    const undo = api.begin({ expressId: 7, modelIndex: 0 });
    api.update(undo, change.before);
    api.commit(undo);
    assert.strictEqual(
      scene.getMeshDataPieces(7)![0].normals,
      original.normals,
    );
    assert.strictEqual(
      scene.getMeshDataPieces(7)![0].indices,
      original.indices,
    );
    assert.deepEqual(scene.getEntityBoundingBox(7), bounds);
    scene.clearFlatGeometry();
    assert.ok(state.buffers.every((buffer) => buffer.destroyed === 1));
    assert.ok(state.textures.every((texture) => texture.destroyed === 1));
  });
  it('failed shared-bucket partition never replaces the active original or leaks staged buffers', () => {
    const { scene, state, api } = setup();
    const batches = [...scene.getBatchedMeshes()];
    const bounds = scene.getEntityBoundingBox(7);
    state.failures.batchBindGroupAt = 3; // Owner succeeds; shared remainder fails after three allocations.
    assert.throws(
      () => api.begin({ expressId: 7, modelIndex: 0 }),
      /injected batch/,
    );
    assert.deepEqual(scene.getBatchedMeshes(), batches);
    assert.deepEqual(scene.getEntityBoundingBox(7), bounds);
    assert.deepEqual(ids(scene), [7, 8, 9]);
    assert.ok(state.buffers.slice(3).every((buffer) => buffer.destroyed === 1));
    const token = api.begin({ expressId: 7, modelIndex: 0 });
    api.cancel(token);
    scene.clearFlatGeometry();
    assert.ok(state.buffers.every((buffer) => buffer.destroyed === 1));
  });
  it('texture staging failure leaves flat originals active and releases staged allocations', () => {
    const { scene, state, parts, api } = setup();
    const token = api.begin({ expressId: 7, modelIndex: 0 });
    const originals = [...scene.getBatchedMeshes()];
    state.failures.writeTexture = true;
    assert.throws(
      () =>
        api.update(token, [
          {
            ...parts[0],
            texture: mesh(0, new Uint8Array(4)).texture,
            uvs: new Float32Array(6),
          },
        ]),
      /injected/,
    );
    assert.deepEqual(scene.getBatchedMeshes(), originals);
    assert.deepEqual(ids(scene), [7, 8, 9]);
    api.cancel(token);
    scene.clearFlatGeometry();
    assert.ok(state.buffers.every((buffer) => buffer.destroyed === 1));
    assert.ok(state.textures.every((texture) => texture.destroyed === 1));
  });
});

it('occurrence remaps are explicit, immutable, geometry-preserving and cancellable (#4404)', () => {
  const scene = new Scene(), state = gpu();
  const source = { ...mesh(7, new Uint8Array([255, 0, 0, 255])), geometryItemId: 21 };
  scene.appendToBatches([source], state.device, pipeline);
  const original = scene.getMeshDataPieces(7)![0];
  const api = scene.appearancePreview(state.device, pipeline);
  const replacement = { ...original, geometryItemId: 31 };
  const ordinary = api.begin({ expressId: 7, modelIndex: 0 });
  assert.throws(() => api.update(ordinary, [replacement]), /geometry or ownership/);
  api.cancel(ordinary);
  assert.throws(() => api.begin({ expressId: 7, modelIndex: 0 }, { geometryItemRemaps: [{ from: 99, to: 31 }] }), /remap/);
  const pairs = [{ from: 21, to: 31 }];
  const token = api.begin({ expressId: 7, modelIndex: 0 }, { geometryItemRemaps: pairs });
  pairs[0].to = 999;
  assert.throws(() => api.update(token, [{ ...replacement, geometryItemId: 999 }]), /geometry or ownership/);
  assert.throws(() => api.update(token, [{ ...replacement, expressId: 8 }]), /geometry or ownership/);
  assert.throws(() => api.update(token, [{ ...replacement, positions: replacement.positions.map(value => value + 1) }]), /geometry or ownership/);
  api.update(token, [replacement]);
  assert.equal(scene.getMeshDataPieces(7)![0].geometryItemId, 31);
  api.cancel(token);
  assert.equal(scene.getMeshDataPieces(7)![0].geometryItemId, 21);
  const committed = api.begin({ expressId: 7, modelIndex: 0 }, { geometryItemRemaps: [{ from: 21, to: 31 }] });
  api.update(committed, [replacement]);
  const change = api.commit(committed);
  assert.deepEqual(change.geometryItemRemaps, [{ from: 21, to: 31 }]);
  assert.equal(change.before[0].geometryItemId, 21);
  assert.equal(change.after[0].geometryItemId, 31);
  assert.equal(scene.getMeshDataPieces(7)!.length, 1);
  scene.clear();
});

// #4404: real Scene adapter, shared template, canonical occurrence source and
// history references. GPU calls alone are stubbed; scene ownership is real.
describe('instanced occurrence appearance history (#4404)', () => {
  function setup() {
    const scene = new Scene(), state = gpu();
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const indices = new Uint32Array([0, 1, 2]);
    scene.addInstancedShard(state.device, { carriesItemIds: true,
      templates: [{ positions, normals, indices, origin: [0, 0, 0] }],
      instances: [7, 8].map((entityId, index) => ({ entityId, itemId: 21, templateIndex: 0,
        color: [1, 1, 1, 1], transform: new Float32Array([1, 0, 0, index * 5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) })),
    }, 3);
    const original: MeshData = { expressId: 7, modelIndex: 3, geometryItemId: 21,
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, -1]),
      normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), indices,
      origin: [0, 0, 0],
      color: [1, 1, 1, 1], appearanceSource: { kind: 'canonical-item', indices, sourceIndices: indices } };
    const replacement = { ...original, geometryItemId: 31, uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
      texture: { rgba: new Uint8Array([255, 0, 0, 255]), width: 1, height: 1, repeatS: false, repeatT: false } };
    const owner = { expressId: 7, modelIndex: 3 };
    const api = scene.appearancePreview(state.device, pipeline);
    const start = () => api.begin(owner, { materializedOriginals: [original], geometryItemRemaps: [{ from: 21, to: 31 }] });
    return { scene, state, original, replacement, owner, api, start };
  }
  it('cancels a remapped preview and abandons invalid remaps without retaining a lease', () => {
    const { scene, original, replacement, owner, api, start } = setup();
    assert.throws(() => api.begin(owner, { materializedOriginals: [original], geometryItemRemaps: [{ from: 99, to: 31 }] }), /remap/);
    const token = start(); api.update(token, [replacement]);
    assert.deepEqual([...scene.getInstancedEntityIds()], [8]);
    assert.equal(scene.getMeshDataPieces(7)!.length, 1);
    api.cancel(token);
    assert.deepEqual([...scene.getInstancedEntityIds()], [7, 8]);
    assert.equal(scene.getMeshDataPieces(7), undefined);
    assert.equal(scene.getEntityBoundingBox(7)?.max.x, 1);
    const lease = scene.retainInstancedOccurrence(7, 3); lease.release();
    scene.clear();
  });
  it('keeps a failed GPU restoration cancellable and disposes already hidden originals without GPU writes', () => {
    const { scene, state, replacement, owner, api, start } = setup();
    const token = start(); api.update(token, [replacement]);
    state.failures.writeBufferOnce = true;
    assert.throws(() => api.cancel(token), /buffer upload failure/);
    assert.deepEqual([...scene.getInstancedEntityIds()], [8]);
    assert.equal(scene.getMeshDataPieces(7)!.length, 1);
    api.cancel(token);
    assert.deepEqual([...scene.getInstancedEntityIds()], [7, 8]);
    const next = start(); api.update(next, [replacement]);
    const release = api.retainSource(owner); api.commit(next);
    state.failures.writeBufferOnce = true;
    release(); release();
    assert.equal(state.failures.writeBufferOnce, true, 'the already suppressed original requires no disposal upload');
    assert.equal(scene.isInstancedEntity(7), false);
    assert.equal(scene.getMeshDataPieces(7)!.length, 1);
    scene.clear();
  });
  it('validates a source rebuild before disposal and preserves surviving history across unrelated geometry', () => {
    const { scene, state, replacement, owner, api, start } = setup();
    const token = start(); api.update(token, [replacement]);
    const release = api.retainSource(owner); api.commit(token);
    const sources = scene.getMeshDataPieces(7)!.map(part => scene.appearanceSourceMesh(part));
    const external = scene.retainInstancedOccurrence(8, 3); external.setSuppressed(true);
    const destroyed = state.buffers.map(buffer => buffer.destroyed);
    state.failures.writeBufferOnce = true;
    assert.throws(() => scene.clearFlatGeometryForRebuild(sources, new Set([3])), /buffer upload failure/);
    assert.deepEqual(state.buffers.map(buffer => buffer.destroyed), destroyed);
    assert.equal(external.valid, true);
    assert.deepEqual([...scene.getInstancedEntityIds()], []);
    scene.clearFlatGeometryForRebuild(sources, new Set([3]));
    assert.equal(external.valid, false);
    scene.appendToBatches(sources, state.device, pipeline);
    assert.deepEqual([...scene.getInstancedEntityIds()], [8]);
    assert.equal(api.getParts(owner)![0].geometryItemId, 31);
    const undo = api.begin(owner, { geometryItemRemaps: [{ from: 31, to: 21 }] });
    const original = { ...sources[0], geometryItemId: 21, texture: undefined, uvs: undefined };
    api.update(undo, [original]); api.commit(undo);
    scene.clearFlatGeometryForRebuild([], new Set([3]));
    assert.deepEqual([...scene.getInstancedEntityIds()], [7, 8]);
    release();
    const fresh = scene.retainInstancedOccurrence(7, 3); fresh.release();
    scene.clear();
  });
  it('never resurrects a discarded converted original on a later source rebuild', () => {
    const { scene, state, replacement, owner, api, start } = setup();
    const token = start(); api.update(token, [replacement]);
    const release = api.retainSource(owner); api.commit(token);
    const sources = scene.getMeshDataPieces(7)!.map(part => scene.appearanceSourceMesh(part));
    scene.clearFlatGeometryForRebuild([], new Set([3]));
    assert.equal(scene.isInstancedEntity(7), false);
    scene.clearFlatGeometryForRebuild(sources, new Set([3]));
    scene.appendToBatches(sources, state.device, pipeline);
    assert.deepEqual([...scene.getInstancedEntityIds()], [8]);
    assert.equal(scene.getMeshDataPieces(7)!.length, 1);
    release(); scene.clear();
  });
  for (const undone of [false, true]) it(`retains originals across second Apply and history disposal, undone=${undone}`, () => {
    const { scene, original, replacement, owner, api, start } = setup();
    const sibling = scene.getInstancedMeshDataPieces(8)![0];
    const first = start(); api.update(first, [replacement]);
    const releaseFirst = api.retainSource(owner), change = api.commit(first);
    assert.equal(change.beforeInstanced, true);
    const second = api.begin(owner);
    const next = { ...api.getParts(owner)![0], texture: { ...replacement.texture, rgba: new Uint8Array([0, 255, 0, 255]) } };
    api.update(second, [next]); const releaseSecond = api.retainSource(owner); api.commit(second);
    releaseFirst();
    assert.deepEqual([...scene.getInstancedEntityIds()], [8], 'disposing first command cannot restore the original beneath the second edit');
    if (undone) {
      const undo = api.begin(owner, { geometryItemRemaps: [{ from: 31, to: 21 }] });
      api.update(undo, [original]);
      assert.equal(api.commit(undo).afterInstanced, true);
      assert.equal(scene.getEntityBoundingBox(7)?.max.x, 1);
      assert.equal(scene.getMeshDataPieces(7), undefined);
    }
    releaseSecond(); releaseSecond();
    assert.deepEqual([...scene.getInstancedEntityIds()], undone ? [7, 8] : [8]);
    assert.equal(scene.isInstancedEntity(7), undone);
    assert.deepEqual(scene.getInstancedMeshDataPieces(8)![0].positions, sibling.positions);
    if (undone) { const lease = scene.retainInstancedOccurrence(7, 3); lease.release(); }
    else assert.equal(scene.getMeshDataPieces(7)!.length, 1);
    scene.clear();
  });
});
