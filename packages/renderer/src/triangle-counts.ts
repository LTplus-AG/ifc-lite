/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import { meshTriangleCount } from '@ifc-lite/geometry/compact';

/** Occurrence triangle counts, rather than unique GPU-template storage (#10370).
 * IDs stay in the supplied geometry's space; federation callers resolve them.
 * Keep numbers only: no mesh, shard, file, or GPU buffer is retained. */
export class TriangleCounts {
  readonly byEntity = new Map<number, number>();

  add(entityId: number, triangles: number): void {
    this.byEntity.set(entityId, (this.byEntity.get(entityId) ?? 0) + triangles);
  }

  addMesh(mesh: Pick<MeshData, 'expressId' | 'indices' | 'entityIds' | 'compact'>): void {
    if (!mesh.entityIds?.length) {
      this.add(mesh.expressId, meshTriangleCount(mesh)); // a compact mesh is counted from its row, not decoded
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
  private sourceKnown = false;
  private replayComplete = false;
  isReplayComplete(): boolean { return this.replayComplete; }
  setReplayComplete(complete: boolean): boolean { const changed = this.replayComplete !== complete; if (complete) this.sourceKnown = true; this.replayComplete = complete; return changed; }
  private flat = new TriangleCounts();
  private queued = new TriangleCounts();
  private revision = -1;
  private cached: ReadonlyMap<number, number> | undefined;

  noteSources(meshes: readonly MeshData[], queued = false): void {
    this.sourceKnown = true;
    this.replayComplete = false;
    const added = new TriangleCounts();
    for (const mesh of meshes) added.addMesh(mesh);
    for (const [id, count] of added.byEntity) {
      this.flat.add(id, count);
      if (queued) this.queued.add(id, count);
    }
    this.cached = undefined;
  }

  uploaded(meshes: readonly MeshData[]): void {
    const added = new TriangleCounts();
    for (const mesh of meshes) added.addMesh(mesh);
    for (const [id, count] of added.byEntity) {
      const left = (this.queued.byEntity.get(id) ?? 0) - count;
      if (left > 0) this.queued.byEntity.set(id, left);
      else this.queued.byEntity.delete(id);
    }
  }

  read(host: TriangleCountHost, revision: number, hydrating: boolean): ReadonlyMap<number, number> | null {
    if (hydrating) return null;
    // A replacement Scene has not replayed any source yet. An empty map is
    // a measured zero only after a source (including an empty one) arrived.
    if (host.instances.size > 0) this.sourceKnown = true;
    if (!this.sourceKnown) return null;
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

  remove(id: number): void {
    const pending = this.queued.byEntity.get(id);
    if (pending) this.flat.byEntity.set(id, pending);
    else this.flat.byEntity.delete(id);
    this.cached = undefined;
  }
  clear(): void { this.sourceKnown = false; this.replayComplete = false; this.flat = new TriangleCounts(); this.queued = new TriangleCounts(); this.cached = undefined; this.revision = -1; }
}
