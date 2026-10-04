/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Presents a (partially loaded) COPC hierarchy as `LodNode`s (#6869).
 *
 * Node bounds come from the voxel key, in the frame the decoder emits points
 * in: native coordinates minus `originOffset` (the same f64 subtraction the
 * decoder applies). A host whose scene applies a further affine placement
 * should move the CAMERA into this frame (view-projection times placement)
 * rather than the boxes, which keeps them exact instead of re-boxed.
 *
 * A node whose children include the root of an unloaded hierarchy page
 * reports `children: null`, so `selectLod` lists it in `needsChildren` and
 * the host loads exactly those pages.
 */

import { bboxInDecodedFrame } from '../formats/las.js';
import { copcNodeBounds, voxelKeyId, type CopcInfo, type VoxelKey } from '../copc/copc-info.js';
import { copcChildKeys, type CopcHierarchy, type CopcNodeEntry, type CopcPageRef } from '../copc/copc-hierarchy.js';
import type { LodNode } from './select.js';

export interface CopcLodNode extends LodNode {
  readonly entry: CopcNodeEntry;
  readonly children: readonly CopcLodNode[] | null;
}

export interface CopcLodTree {
  /** The root, or null when the hierarchy has no root node entry. */
  readonly root: CopcLodNode | null;
  /** Pending pages whose subtree roots are children of `node`. */
  pendingPagesUnder(node: LodNode): CopcPageRef[];
}

export function createCopcLodTree(
  hierarchy: CopcHierarchy,
  info: CopcInfo,
  originOffset?: readonly [number, number, number],
): CopcLodTree {
  const cache = new Map<string, CopcLodNode>();
  const nodeFor = (key: VoxelKey): CopcLodNode | null => {
    const id = voxelKeyId(key);
    const cached = cache.get(id);
    if (cached) return cached;
    const entry = hierarchy.nodes.get(id);
    if (!entry) return null;
    const node: CopcLodNode = {
      id,
      entry,
      bounds: bboxInDecodedFrame(copcNodeBounds(info, key), originOffset),
      pointCount: entry.pointCount,
      get children(): readonly CopcLodNode[] | null {
        const out: CopcLodNode[] = [];
        for (const childKey of copcChildKeys(key)) {
          const state = hierarchy.stateOf(childKey);
          if (state === 'page') return null;
          if (state === 'node') {
            const child = nodeFor(childKey);
            if (child) out.push(child);
          }
        }
        return out;
      },
    };
    cache.set(id, node);
    return node;
  };
  return {
    get root() {
      return nodeFor({ d: 0, x: 0, y: 0, z: 0 });
    },
    pendingPagesUnder(node: LodNode): CopcPageRef[] {
      const entry = cache.get(node.id)?.entry;
      if (!entry) return [];
      return copcChildKeys(entry.key)
        .map((k) => hierarchy.pendingPages.get(voxelKeyId(k)))
        .filter((ref): ref is CopcPageRef => ref !== undefined);
    },
  };
}
