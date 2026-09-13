/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DecodedInstancedShard, MeshData } from '@ifc-lite/geometry';
import { Scene } from './scene.js';
import { INSTANCE_FLAGS_OFFSET, INSTANCE_FLAG_SELECTED, INSTANCE_STRIDE_BYTES } from './instanced-render.js';

/**
 * Representation-item-level highlighting (#4382), a follow-up on #2985: an
 * optional `itemId` narrows a still-product-scoped selection (`selectedId` /
 * `expressIds`) to the ONE representation item within it, so the renderer
 * hydrates/flags only the matching flat or instanced piece(s) instead of the
 * whole product.
 *
 * Two independent paths carry a per-item identity and both are covered here:
 * - the flat path, where `Scene.meshDataMap` already stores one `MeshData`
 *   piece per representation item (each tagged with its own `geometryItemId`,
 *   #3210) — `Scene.getMeshDataPieces` and `Scene.disposeHydratedMeshesExcept`
 *   are what narrow hydration to one of them.
 * - the GPU-instanced path, where `Scene.instancedEntityMap` already tracks a
 *   per-occurrence `itemId` (#3528) — `Scene.setInstancedSelection` and
 *   `Scene.writeInstanceFlags` are what narrow the per-occurrence selected bit.
 */

// WebGPU enum globals used by Scene buffer creation (not defined in node).
(globalThis as Record<string, unknown>).GPUBufferUsage = {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};

function fakeDevice(): { device: GPUDevice; buffers: WeakMap<GPUBuffer, ArrayBuffer> } {
  const buffers = new WeakMap<GPUBuffer, ArrayBuffer>();
  const device = {
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
    createBuffer: (desc: GPUBufferDescriptor) => {
      const data = new ArrayBuffer(desc.size);
      const buffer = { size: desc.size, getMappedRange: () => data, unmap() {}, destroy() {} } as unknown as GPUBuffer;
      buffers.set(buffer, data);
      return buffer;
    },
    queue: {
      writeBuffer: (buffer: GPUBuffer, offset: number, data: ArrayBufferView) => {
        new Uint8Array(buffers.get(buffer)!, offset, data.byteLength)
          .set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      },
    },
  } as unknown as GPUDevice;
  return { device, buffers };
}

function triangle(expressId: number, geometryItemId: number | undefined, color: [number, number, number, number]): MeshData {
  return {
    expressId,
    geometryItemId,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color,
  } as MeshData;
}

describe('flat-path item-level highlighting (#4382)', () => {
  const ITEM_A = 501;
  const ITEM_B = 502;
  const GREY: [number, number, number, number] = [0.5, 0.5, 0.5, 1];

  function twoItemProduct(): Scene {
    const scene = new Scene();
    // Two representation-item pieces for the SAME product (expressId 9), as
    // #3210's export already produces for a multi-item IfcMappedItem.
    scene.addMeshData(triangle(9, ITEM_A, GREY));
    scene.addMeshData(triangle(9, ITEM_B, GREY));
    return scene;
  }

  it('without an itemId, getMeshDataPieces returns every piece of the product (whole-product, unchanged default)', () => {
    const scene = twoItemProduct();
    const pieces = scene.getMeshDataPieces(9);
    assert.equal(pieces?.length, 2);
    assert.deepEqual(new Set(pieces!.map((p) => p.geometryItemId)), new Set([ITEM_A, ITEM_B]));
  });

  it('with an itemId, getMeshDataPieces returns only the matching piece', () => {
    const scene = twoItemProduct();
    const pieces = scene.getMeshDataPieces(9, undefined, ITEM_A);
    assert.equal(pieces?.length, 1);
    assert.equal(pieces![0].geometryItemId, ITEM_A);
  });

  it('an itemId with no matching piece returns undefined rather than falling back to the whole product', () => {
    const scene = twoItemProduct();
    assert.equal(scene.getMeshDataPieces(9, undefined, 999999), undefined);
  });

  it('disposeHydratedMeshesExcept frees only the non-matching item of the item-filtered product', () => {
    const scene = twoItemProduct();
    const device = fakeDevice().device;
    // Hydrate both pieces, as whole-product selection would.
    for (const piece of scene.getMeshDataPieces(9)!) {
      const vb = device.createBuffer({ size: 64, usage: 32 } as GPUBufferDescriptor);
      const ib = device.createBuffer({ size: 12, usage: 16 } as GPUBufferDescriptor);
      scene.addMesh({
        expressId: piece.expressId,
        geometryItemId: piece.geometryItemId,
        vertexBuffer: vb,
        indexBuffer: ib,
        indexCount: 3,
        transform: { m: new Float32Array(16) },
        color: piece.color,
        hydrated: true,
      });
    }
    assert.equal(scene.getMeshes().filter((m) => m.hydrated).length, 2);

    // Narrow to ITEM_A: the ITEM_B piece must be disposed, ITEM_A kept.
    const disposedCount = scene.disposeHydratedMeshesExcept(new Set([9]), undefined, 9, ITEM_A);
    assert.equal(disposedCount, 1);
    const remaining = scene.getMeshes().filter((m) => m.hydrated);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].geometryItemId, ITEM_A);
  });

  it('switching the itemId within the same product replaces the highlight cleanly (both directions)', () => {
    const scene = twoItemProduct();
    const device = fakeDevice().device;
    const hydrate = (piece: MeshData) => scene.addMesh({
      expressId: piece.expressId,
      geometryItemId: piece.geometryItemId,
      vertexBuffer: device.createBuffer({ size: 64, usage: 32 } as GPUBufferDescriptor),
      indexBuffer: device.createBuffer({ size: 12, usage: 16 } as GPUBufferDescriptor),
      indexCount: 3,
      transform: { m: new Float32Array(16) },
      color: piece.color,
      hydrated: true,
    });

    // Select item A only.
    hydrate(scene.getMeshDataPieces(9, undefined, ITEM_A)![0]);
    let hydrated = scene.getMeshes().filter((m) => m.hydrated);
    assert.equal(hydrated.length, 1);
    assert.equal(hydrated[0].geometryItemId, ITEM_A);

    // Switch to item B within the SAME product: dispose stale A, hydrate B.
    scene.disposeHydratedMeshesExcept(new Set([9]), undefined, 9, ITEM_B);
    hydrate(scene.getMeshDataPieces(9, undefined, ITEM_B)![0]);
    hydrated = scene.getMeshes().filter((m) => m.hydrated);
    assert.equal(hydrated.length, 1, 'item A is gone, only item B highlights — not both accumulating');
    assert.equal(hydrated[0].geometryItemId, ITEM_B);

    // Deselecting the item filter (whole product again) restores both pieces
    // once re-hydrated — the ordinary (non-item) path is unaffected by any of
    // the above. disposeHydratedMeshesExcept(keep, ..., undefined, undefined)
    // is what a real render() calls first (clears item-scoped state); here
    // that keeps the current item-B mesh (still a valid piece of product 9),
    // so only item A needs a fresh hydrate to restore the full set.
    scene.disposeHydratedMeshesExcept(new Set([9]), undefined, undefined, undefined);
    hydrate(scene.getMeshDataPieces(9, undefined, ITEM_A)![0]);
    hydrated = scene.getMeshes().filter((m) => m.hydrated);
    assert.equal(hydrated.length, 2, 'whole-product selection still hydrates every piece');
  });

  it('an itemId filter never touches a DIFFERENT selected product (multi-selection stays whole-product)', () => {
    const scene = new Scene();
    scene.addMeshData(triangle(9, ITEM_A, GREY));
    scene.addMeshData(triangle(9, ITEM_B, GREY));
    scene.addMeshData(triangle(20, undefined, GREY)); // a second, unrelated selected product
    const device = fakeDevice().device;
    const hydrate = (piece: MeshData) => scene.addMesh({
      expressId: piece.expressId,
      geometryItemId: piece.geometryItemId,
      vertexBuffer: device.createBuffer({ size: 64, usage: 32 } as GPUBufferDescriptor),
      indexBuffer: device.createBuffer({ size: 12, usage: 16 } as GPUBufferDescriptor),
      indexCount: 3,
      transform: { m: new Float32Array(16) },
      color: piece.color,
      hydrated: true,
    });
    for (const piece of scene.getMeshDataPieces(9)!) hydrate(piece);
    hydrate(scene.getMeshDataPieces(20)![0]);

    // Item-filter product 9 down to ITEM_A; product 20 is also kept (multi-select).
    const disposed = scene.disposeHydratedMeshesExcept(new Set([9, 20]), undefined, 9, ITEM_A);
    assert.equal(disposed, 1, 'only the non-matching item of product 9 is freed');
    const remaining = scene.getMeshes().filter((m) => m.hydrated).map((m) => m.expressId);
    assert.deepEqual(remaining.sort((a, b) => a - b), [9, 20]);
  });

  it('OVERLAP: when the item-filtered product is ALSO present in the multi-select set, it is still narrowed to the item — the item filter tracks selectedId, not membership in the keep set', () => {
    // Mirrors a caller whose selectedIds includes its own primary selection
    // (`selectedIds ⊇ {selectedId}`), which index.ts's selectedExpressIds
    // union produces for every ordinary "extend the multi-select from the
    // current pick" gesture. Product 9 is simultaneously: the item-filtered
    // selectedId, AND a member of the keep set alongside product 20.
    const scene = new Scene();
    scene.addMeshData(triangle(9, ITEM_A, GREY));
    scene.addMeshData(triangle(9, ITEM_B, GREY));
    scene.addMeshData(triangle(20, undefined, GREY));
    const device = fakeDevice().device;
    const hydrate = (piece: MeshData) => scene.addMesh({
      expressId: piece.expressId,
      geometryItemId: piece.geometryItemId,
      vertexBuffer: device.createBuffer({ size: 64, usage: 32 } as GPUBufferDescriptor),
      indexBuffer: device.createBuffer({ size: 12, usage: 16 } as GPUBufferDescriptor),
      indexCount: 3,
      transform: { m: new Float32Array(16) },
      color: piece.color,
      hydrated: true,
    });
    for (const piece of scene.getMeshDataPieces(9)!) hydrate(piece);
    hydrate(scene.getMeshDataPieces(20)![0]);

    // keep = {9, 20} — product 9 is in the keep set (as selectedIds would
    // put it) AND is itemFilterExpressId (as selectedId would). The item
    // filter still narrows it: only ITEM_A survives, ITEM_B is freed, even
    // though 9 is "multi-selected" too.
    const disposed = scene.disposeHydratedMeshesExcept(new Set([9, 20]), undefined, 9, ITEM_A);
    assert.equal(disposed, 1, 'ITEM_B piece of the overlapping product is freed, not kept whole');
    const remainingItemIds = scene.getMeshes()
      .filter((m) => m.hydrated && m.expressId === 9)
      .map((m) => m.geometryItemId);
    assert.deepEqual(remainingItemIds, [ITEM_A], 'product 9 narrows to ITEM_A despite being in the multi-select set');
    const product20 = scene.getMeshes().filter((m) => m.hydrated && m.expressId === 20);
    assert.equal(product20.length, 1, 'the OTHER multi-selected product (20) is untouched, whole-product');
  });
});

describe('GPU-instanced item-level highlighting (#4382)', () => {
  const ITEM_A = 701;
  const ITEM_B = 702;

  function itemSplitShard(): DecodedInstancedShard {
    return {
      carriesItemIds: true,
      templates: [{
        positions: new Float32Array([-1, 0, -1, 1, 0, -1, 0, 0, 1]),
        normals: new Float32Array([0, -1, 0, 0, -1, 0, 0, -1, 0]),
        indices: new Uint32Array([0, 1, 2]),
        origin: [0, 0, 0],
      }],
      // One product (entityId 9), instanced twice — one occurrence per
      // representation item, matching #3528's per-item template granularity.
      instances: [
        { templateIndex: 0, entityId: 9, itemId: ITEM_A, color: [0.4, 0.5, 0.6, 1], transform: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) },
        { templateIndex: 0, entityId: 9, itemId: ITEM_B, color: [0.4, 0.5, 0.6, 1], transform: new Float32Array([1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) },
      ],
    };
  }

  function fixture() {
    const { device, buffers } = fakeDevice();
    const scene = new Scene();
    scene.addInstancedShard(device, itemSplitShard(), 3);
    const gpu = scene.getInstancedTemplates()[0];
    const flags = (occurrenceIndex: number) =>
      new DataView(buffers.get(gpu.instanceBuffer)!).getUint32(occurrenceIndex * INSTANCE_STRIDE_BYTES + INSTANCE_FLAGS_OFFSET, true);
    return { scene, flags };
  }

  it('without an itemId filter, selecting the product flags every occurrence (whole-product, unchanged default)', () => {
    const { scene, flags } = fixture();
    scene.setInstancedSelection(new Set([9]));
    assert.equal(flags(0) & INSTANCE_FLAG_SELECTED, INSTANCE_FLAG_SELECTED, 'item A occurrence selected');
    assert.equal(flags(1) & INSTANCE_FLAG_SELECTED, INSTANCE_FLAG_SELECTED, 'item B occurrence also selected');
  });

  it('with an itemId filter, only the matching occurrence is flagged selected', () => {
    const { scene, flags } = fixture();
    scene.setInstancedSelection(new Set([9]), 9, ITEM_A);
    assert.equal(flags(0) & INSTANCE_FLAG_SELECTED, INSTANCE_FLAG_SELECTED, 'item A occurrence selected');
    assert.equal(flags(1) & INSTANCE_FLAG_SELECTED, 0, 'item B occurrence NOT selected');
  });

  it('switching the item filter within the same still-selected product moves the flag cleanly (both directions)', () => {
    const { scene, flags } = fixture();
    scene.setInstancedSelection(new Set([9]), 9, ITEM_A);
    assert.equal(flags(0) & INSTANCE_FLAG_SELECTED, INSTANCE_FLAG_SELECTED);
    assert.equal(flags(1) & INSTANCE_FLAG_SELECTED, 0);

    scene.setInstancedSelection(new Set([9]), 9, ITEM_B);
    assert.equal(flags(0) & INSTANCE_FLAG_SELECTED, 0, 'item A occurrence is un-flagged');
    assert.equal(flags(1) & INSTANCE_FLAG_SELECTED, INSTANCE_FLAG_SELECTED, 'item B occurrence is now flagged');

    // Clearing the item filter (whole product again) restores both — the
    // ordinary (non-item) path is unaffected by any of the above.
    scene.setInstancedSelection(new Set([9]));
    assert.equal(flags(0) & INSTANCE_FLAG_SELECTED, INSTANCE_FLAG_SELECTED);
    assert.equal(flags(1) & INSTANCE_FLAG_SELECTED, INSTANCE_FLAG_SELECTED);
  });

  it('an item filter never touches a DIFFERENT selected product (multi-selection stays whole-product)', () => {
    const { device, buffers } = fakeDevice();
    const scene = new Scene();
    const shard = itemSplitShard();
    shard.instances.push({ templateIndex: 0, entityId: 20, color: [0.1, 0.1, 0.1, 1], transform: new Float32Array([1, 0, 0, 9, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) });
    scene.addInstancedShard(device, shard, 3);
    const gpu = scene.getInstancedTemplates()[0];
    const flags = (i: number) => new DataView(buffers.get(gpu.instanceBuffer)!).getUint32(i * INSTANCE_STRIDE_BYTES + INSTANCE_FLAGS_OFFSET, true);

    scene.setInstancedSelection(new Set([9, 20]), 9, ITEM_A);
    assert.equal(flags(0) & INSTANCE_FLAG_SELECTED, INSTANCE_FLAG_SELECTED, 'product 9 item A selected');
    assert.equal(flags(1) & INSTANCE_FLAG_SELECTED, 0, 'product 9 item B not selected');
    assert.equal(flags(2) & INSTANCE_FLAG_SELECTED, INSTANCE_FLAG_SELECTED, 'product 20 (multi-selected, no item filter) stays whole-product selected');
  });

  it('OVERLAP: when the item-filtered product is ALSO present in the multi-select set, its occurrences are still narrowed to the item', () => {
    // Same overlap as the flat-path OVERLAP test: expressIds = {9, 20} (as
    // index.ts's selectedExpressIds union produces when selectedId's product
    // is also a member of selectedIds), and itemFilterExpressId = 9 = the
    // SAME product that is also in the multi-select set.
    const { device, buffers } = fakeDevice();
    const scene = new Scene();
    const shard = itemSplitShard();
    shard.instances.push({ templateIndex: 0, entityId: 20, color: [0.1, 0.1, 0.1, 1], transform: new Float32Array([1, 0, 0, 9, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) });
    scene.addInstancedShard(device, shard, 3);
    const gpu = scene.getInstancedTemplates()[0];
    const flags = (i: number) => new DataView(buffers.get(gpu.instanceBuffer)!).getUint32(i * INSTANCE_STRIDE_BYTES + INSTANCE_FLAGS_OFFSET, true);

    scene.setInstancedSelection(new Set([9, 20]), 9, ITEM_A);
    assert.equal(flags(0) & INSTANCE_FLAG_SELECTED, INSTANCE_FLAG_SELECTED, 'product 9 item A occurrence selected despite 9 also being multi-selected');
    assert.equal(flags(1) & INSTANCE_FLAG_SELECTED, 0, 'product 9 item B occurrence NOT selected, even though product 9 is in expressIds');
    assert.equal(flags(2) & INSTANCE_FLAG_SELECTED, INSTANCE_FLAG_SELECTED, 'product 20, the other multi-selected product, stays whole-product (untouched by the item filter)');
  });
});
