/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SpatialNode } from '@ifc-lite/data';

/** Depth-first search for a spatial node by express id. */
export function findSpatialNode(node: SpatialNode, expressId: number): SpatialNode | null {
  if (node.expressId === expressId) return node;
  for (const child of node.children) {
    const hit = findSpatialNode(child, expressId);
    if (hit) return hit;
  }
  return null;
}
