/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TreeNode } from './types';

/** Find the first node matching `isMatch` in a fully expanded flat node list
 *  and return its ancestor id chain, using the same one-pass technique
 *  `treeDataBuilder.ts`'s `filterNodes` (#6112) uses: keep, per depth, the
 *  flat-array index of the last node seen there, so any node's ancestors are
 *  recoverable in O(1) without a second walk. Reveals a selection made
 *  outside the tree (#5881) — unlike `filterNodes`, which only needs to know
 *  a node is INCLUDED, this needs the actual ancestor ids in order, to expand
 *  a collapsed chain down to the target. */
export function findNodePath(
  nodes: TreeNode[],
  isMatch: (node: TreeNode) => boolean,
): { ancestorIds: string[]; targetId: string; targetIndex: number } | null {
  const ancestors: number[] = [];
  let modelsHeader = -1;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (node.id === 'models-header') {
      modelsHeader = index;
      ancestors.length = 0;
      continue;
    }
    ancestors.length = Math.min(ancestors.length, node.depth);
    if (isMatch(node)) {
      const ancestorIds = ancestors.slice(0, node.depth).map((i) => nodes[i].id);
      if (modelsHeader >= 0) ancestorIds.unshift(nodes[modelsHeader].id);
      return { ancestorIds, targetId: node.id, targetIndex: index };
    }
    ancestors[node.depth] = index;
  }
  return null;
}
