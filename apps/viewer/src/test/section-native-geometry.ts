/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { TestContext } from 'node:test';
import { IfcAPI } from '@ifc-lite/wasm';
import { CoordinateHandler, decodeInstancedShard, type MeshData } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { ensureWasm } from './scan-slab-fixture';

const file = new URL('../../../../tests/models/ara3d/AC20-FZK-Haus.ifc', import.meta.url);
export const sourceDigest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** #7525: real FZK through the same partitioned native producer as the worker.
 * Copy-out getters own their arrays; every WASM handle is freed deterministically. */
export function sectionNativeGeometry(t: TestContext) {
  if (!existsSync(file)) { t.skip('Real FZK fixture absent: run pnpm fixtures'); return null; }
  if (!ensureWasm(t)) return null;
  const source = readFileSync(file);
  assert.equal(sourceDigest(source), 'd42ab0dee01173106c16cd823b4614efe188fa15dd65195d95b9879bec59acc5');
  const api = new IfcAPI();
  try {
    api.setMergeLayers(false); api.setSkipSmallCuts(true);
    const pre = api.buildPrePassOnce(source);
    const partition = api.processGeometryBatchPartitioned(source, pre.jobs, pre.unitScale,
      pre.rtcOffset[0], pre.rtcOffset[1], pre.rtcOffset[2], pre.needsShift,
      pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors,
      pre.planeAngleToRadians, pre.materialElementIds, pre.materialColorCounts, pre.materialColors);
    try {
      const collection = partition.takeMeshes(); assert.ok(collection);
      const meshes: MeshData[] = [];
      try {
        for (let i = 0; i < collection.length; i++) {
          const mesh = collection.takeMesh(i); if (!mesh) continue;
          try {
            const color = mesh.color, origin = mesh.origin;
            meshes.push({ expressId: mesh.expressId, ifcType: mesh.ifcType, geometryClass: mesh.geometryClass,
              positions: mesh.positions, normals: mesh.normals, indices: mesh.indices,
              color: [color[0], color[1], color[2], color[3]], origin: [origin[0], origin[1], origin[2]] });
          } finally { mesh.free(); }
        }
      } finally { collection.free(); }
      const shardBytes = partition.takeShard();
      const shard = decodeInstancedShard(shardBytes);
      assert.ok(meshes.length > 0); assert.ok(shard.instances.length > 0, 'Real native IFNS is mandatory');
      return { source, meshes, shard, shardBytes, coordinateInfo: new CoordinateHandler().processMeshes(meshes) };
    } finally { partition.free(); }
  } finally { api.clearPrePassCache(); api.free(); }
}

/** Independent extrema from actual indexed triangle corners, both storage paths.
 * No renderer bounding-box helper supplies the expected result. */
export function sectionIndexedBounds(scene: ReturnType<Renderer['getScene']>, ids: readonly number[]) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let corners = 0, flat = 0, instanced = 0;
  for (const id of ids) {
    const pieces = scene.getMeshDataPieces(id) ?? [], instances = scene.getInstancedMeshDataPieces(id) ?? [];
    flat += pieces.length; instanced += instances.length;
    for (const piece of [...pieces, ...instances]) for (const index of piece.indices) {
      assert.ok(++corners <= 2_000_000, 'Real fixture traversal stays bounded');
      for (let axis = 0; axis < 3; axis++) {
        const value = piece.positions[index * 3 + axis] + (piece.origin?.[axis] ?? 0);
        assert.ok(Number.isFinite(value)); min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value);
      }
    }
  }
  assert.ok(corners > 0); assert.ok(flat > 0); assert.ok(instanced > 0);
  return { min: { x: min[0], y: min[1], z: min[2] }, max: { x: max[0], y: max[1], z: max[2] } };
}
