/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';
import { BVH } from './bvh.js';
import type { Ray } from './raycaster.js';
import type { SceneContents } from './scene-contents.js';

/** Raycast-only capabilities; optional for existing custom SceneContents adapters. */
export type RaycastScene = SceneContents & {
  getTexturedMeshes?(): readonly Pick<MeshData, 'expressId' | 'modelIndex'>[];
  getPickGeometryRevision?(): number;
  /** CPU geometry discarded by host eviction or explicit release. */
  onHostEviction?(listener: () => void): (() => void) | void;
};

type DrawRef = Pick<MeshData, 'expressId' | 'modelIndex'>;

interface FlatPieces {
  revision: number | undefined;
  meshes: readonly unknown[];
  textured: readonly unknown[];
  batches: readonly unknown[];
  batchIds: readonly (readonly number[])[];
  batchIdCounts: readonly number[];
  pieces: MeshData[];
}

function sameItems(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Every flat, textured and batched piece, with visibility NOT applied, and one
 * BVH over them (#9504). Hiding or isolating filters each ray's candidates and
 * rebuilds nothing, and an unchanged scene re-collects nothing per ray.
 */
export class RaycastFlatIndex {
  private readonly bvh = new BVH();
  private flat: FlatPieces | null = null;
  private bvhPieces: MeshData[] | null = null;
  private readonly unsubscribe: (() => void) | void;

  constructor(private readonly scene: RaycastScene, private readonly bvhThreshold: number) {
    // Cold eviction exists to free those typed arrays, so let go of them now
    // rather than at the next ray.
    this.unsubscribe = scene.onHostEviction?.(() => this.invalidate());
  }

  /** Identity and revision checks only. An adapter without a revision is never known fresh. */
  private isFresh(): boolean {
    const flat = this.flat;
    const revision = this.scene.getPickGeometryRevision?.();
    if (!flat || revision === undefined || flat.revision !== revision) return false;
    const batches = this.scene.getBatchedMeshes();
    return sameItems(flat.meshes, this.scene.getMeshes())
      && sameItems(flat.textured, this.scene.getTexturedMeshes?.() ?? [])
      && sameItems(flat.batches, batches)
      && batches.every((batch, i) => batch.expressIds === flat.batchIds[i] && batch.expressIds.length === flat.batchIdCounts[i]);
  }

  private collect(): MeshData[] {
    if (this.isFresh()) return this.flat!.pieces;
    const meshes = this.scene.getMeshes();
    const textured: readonly DrawRef[] = this.scene.getTexturedMeshes?.() ?? [];
    const batches = this.scene.getBatchedMeshes();
    const collected: MeshData[] = [];
    const queried = new Map<number, Set<number>>();
    const seen = new Set<MeshData>();
    const push = (expressId: number, modelIndex?: number) => {
      // One owner/model query returns every resident fragment. Deduplicate the
      // query, then each distinct MeshData: equal-sized fragments can collide
      // on any geometry signature (#4556).
      const scope = modelIndex ?? -1;
      let ids = queried.get(scope);
      if (!ids) queried.set(scope, ids = new Set());
      if (ids.has(expressId)) return;
      ids.add(expressId);
      for (const piece of this.scene.getMeshDataPieces(expressId, modelIndex) ?? []) {
        if (seen.has(piece)) continue;
        seen.add(piece);
        collected.push(piece);
      }
    };
    for (const mesh of meshes) push(mesh.expressId, mesh.modelIndex);
    for (const mesh of textured) push(mesh.expressId, mesh.modelIndex);
    // Batches group by colour, NOT by model: two federated models sharing an
    // expressId and colour can be co-batched, so scope each entry to its own
    // modelIndex (parallel array) rather than querying the id unscoped.
    for (const batch of batches) {
      for (let i = 0; i < batch.expressIds.length; i++) push(batch.expressIds[i], batch.modelIndices?.[i]);
    }
    // Same objects in the same order keep the array, and with it the BVH.
    const pieces = this.flat && sameItems(this.flat.pieces, collected) ? this.flat.pieces : collected;
    this.flat = {
      revision: this.scene.getPickGeometryRevision?.(),
      meshes: meshes.slice(), textured: textured.slice(), batches: batches.slice(),
      batchIds: batches.map(batch => batch.expressIds),
      batchIdCounts: batches.map(batch => batch.expressIds.length),
      pieces,
    };
    return pieces;
  }

  /** Visible pieces whose bounds the ray may cross. `visible` absent means all of them. */
  query(ray: Ray, visible?: (piece: MeshData) => boolean): MeshData[] {
    const pieces = this.collect();
    if (pieces.length <= this.bvhThreshold) return visible ? pieces.filter(visible) : pieces.slice();
    if (this.bvhPieces !== pieces) {
      this.bvh.build(pieces);
      this.bvhPieces = pieces;
    }
    const candidates: MeshData[] = [];
    for (const i of this.bvh.getMeshesForRay(ray, pieces)) {
      if (!visible || visible(pieces[i])) candidates.push(pieces[i]);
    }
    return candidates;
  }

  /** True when the next query rebuilds nothing. Cheap: revision and identity checks. */
  isWarm(): boolean {
    if (!this.isFresh()) return false;
    const pieces = this.flat!.pieces;
    return pieces.length <= this.bvhThreshold || this.bvhPieces === pieces;
  }

  invalidate(): void {
    this.flat = null;
    this.bvhPieces = null;
    this.bvh.clear();
  }

  /** Discarded engines must stop retaining a scene listener (#9512). */
  dispose(): void {
    if (typeof this.unsubscribe === 'function') this.unsubscribe();
    this.invalidate();
  }
}
