/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';

/** Occurrence triangle counts, rather than unique GPU-template storage (#10370).
 * IDs stay in the supplied geometry's space; federation callers resolve them.
 * Keep numbers only: no mesh, shard, file, or GPU buffer is retained. */
export class TriangleCounts {
  readonly byEntity = new Map<number, number>();

  add(entityId: number, triangles: number): void {
    this.byEntity.set(entityId, (this.byEntity.get(entityId) ?? 0) + triangles);
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
}

interface TriangleCountHost {
  instances: ReadonlyMap<number, readonly { templateIndex: number }[]>;
  templates: readonly ({ indexCount: number } | null | undefined)[];
}

/** Source counts survive chunk eviction and CPU geometry release. Re-uploading
 * a cold chunk does not register a new source; a rebuild clears and queues it.
 * Instance counts come from live slots without materializing vertices. */
export class SceneTriangleCounts {
  private flat = new TriangleCounts();
  private revision = -1;
  private cached: ReadonlyMap<number, number> | undefined;

  noteSources(meshes: readonly MeshData[]): void {
    for (const mesh of meshes) this.flat.addMesh(mesh);
    this.cached = undefined;
  }

  read(host: TriangleCountHost, revision: number, hydrating: boolean): ReadonlyMap<number, number> | null {
    if (hydrating) return null;
    if (this.revision === revision && this.cached) return this.cached;
    const counts = new TriangleCounts();
    for (const [id, count] of this.flat.byEntity) counts.add(id, count);
    for (const [id, occurrences] of host.instances) for (const occurrence of occurrences) {
      const template = host.templates[occurrence.templateIndex];
      if (template) counts.add(id, template.indexCount / 3);
    }
    this.revision = revision;
    return this.cached = counts.byEntity;
  }

  remove(id: number): void { this.flat.byEntity.delete(id); this.cached = undefined; }
  clear(): void { this.flat = new TriangleCounts(); this.cached = undefined; this.revision = -1; }
}
