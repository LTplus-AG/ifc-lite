/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { DecodedInstancedShard, MeshData } from '@ifc-lite/geometry';

/** Occurrence triangle counts, rather than unique GPU-template storage (#10370).
 * IDs stay in the supplied geometry's space; federation callers resolve them.
 * Keep numbers only: no mesh, shard, file, or GPU buffer is retained. */
export class TriangleCounts {
  readonly byEntity = new Map<number, number>();
  total = 0;

  private add(entityId: number, triangles: number): void {
    this.byEntity.set(entityId, (this.byEntity.get(entityId) ?? 0) + triangles);
    this.total += triangles;
  }

  addMesh(mesh: Pick<MeshData, 'expressId' | 'indices' | 'entityIds'>): void {
    if (!mesh.entityIds) {
      this.add(mesh.expressId, mesh.indices.length / 3);
      return;
    }
    // A merged batch's expressId names the batch, while the per-vertex IDs
    // preserve each original object's ownership. Count each indexed face once.
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const id = mesh.entityIds[mesh.indices[i]];
      this.add(id, 1);
    }
  }

  addInstancedShard(shard: Pick<DecodedInstancedShard, 'templates' | 'instances'>): void {
    for (const instance of shard.instances) {
      this.add(instance.entityId, shard.templates[instance.templateIndex].indices.length / 3);
    }
  }
}
