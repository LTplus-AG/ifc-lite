/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Picker snapshot and expressId → asset resolution over point-cloud nodes.
 *
 * Pure and node-shaped rather than inlined in `PointCloudRenderer`, mirroring
 * `buildRayQuerySources` in `point-cloud-ray-transform.ts` — testable without
 * a `GPUDevice`.
 */

export interface PickSourceNodeLike {
  pointCount: number;
  meta: { expressId: number; modelIndex?: number };
  model?: Float32Array;
  chunks: Array<{ vertexBuffer: GPUBuffer; pointCount: number }>;
}

export interface PickNodeSource {
  expressId: number;
  modelIndex?: number;
  model?: Float32Array;
  chunks: Array<{ vertexBuffer: GPUBuffer; pointCount: number }>;
}

/** Picker snapshot includes the exact model matrix used by visible splats. */
export function buildPickNodeSources<TNode extends PickSourceNodeLike>(
  nodes: Iterable<TNode>,
): PickNodeSource[] {
  const out: PickNodeSource[] = [];
  for (const node of nodes) {
    if (node.pointCount === 0) continue;
    out.push({
      expressId: node.meta.expressId,
      modelIndex: node.meta.modelIndex,
      model: node.model,
      chunks: node.chunks.map((c) => ({ vertexBuffer: c.vertexBuffer, pointCount: c.pointCount })),
    });
  }
  return out;
}

/**
 * Resolve a packed objectId rgba8 sample back to the asset that owns it.
 * Returns null when the sample doesn't match any asset's expressId.
 */
export function resolvePickedAsset<TNode extends { meta: { expressId: number } }>(
  entries: Iterable<[number, TNode]>,
  expressId: number,
): { handle: { id: number }; meta: TNode['meta'] } | null {
  for (const [id, node] of entries) {
    if ((node.meta.expressId >>> 0) === (expressId >>> 0)) {
      return { handle: { id }, meta: node.meta };
    }
  }
  return null;
}
