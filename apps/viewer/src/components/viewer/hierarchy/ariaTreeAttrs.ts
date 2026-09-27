/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ARIA tree-row attributes (`aria-level` / `aria-posinset` / `aria-setsize`)
 * for the WAI-ARIA APG tree view pattern (#5883). `TreeNode.depth` is the
 * only structural signal the flat, already-virtualization-friendly node
 * arrays carry, so this derives level/position/set-size from `depth` alone,
 * in one linear pass, using the same "one slot per depth" technique
 * `findNodePath` (`treeDataBuilder.ts`) uses to recover an ancestor chain:
 * every node's parent is the nearest earlier node whose depth is exactly one
 * less, so a single stack of "current children counter, per open ancestor"
 * gives every node's 1-based level and position without a second pass.
 * `setSize` is read from a shared, still-mutating counter object AFTER the
 * loop finishes, once every sibling has been counted.
 */

import type { TreeNode } from './types';

export interface AriaTreeAttrs {
  /** 1-based `aria-level` (APG levels start at 1, `TreeNode.depth` at 0). */
  level: number;
  /** 1-based `aria-posinset`: this node's position among its siblings. */
  posInSet: number;
  /** `aria-setsize`: how many siblings (including this node) share its parent. */
  setSize: number;
}

interface SiblingGroup {
  count: number;
}

/** Computes {@link AriaTreeAttrs} for every node in a flat, depth-first,
 *  pre-order node list (one root scope — call separately per rendered tree:
 *  the storeys list, the models list, and the single-model/grouped list are
 *  three independent trees, never mixed in one call). */
export function computeAriaTreeAttrs(nodes: readonly TreeNode[]): AriaTreeAttrs[] {
  const result: AriaTreeAttrs[] = new Array(nodes.length);
  const rootGroup: SiblingGroup = { count: 0 };
  // stack[d] holds the SiblingGroup that d's own children share, pushed the
  // moment a node at depth d is visited (its group starts empty and fills as
  // its children arrive).
  const stack: SiblingGroup[] = [];
  const groups: SiblingGroup[] = new Array(nodes.length);

  for (let i = 0; i < nodes.length; i++) {
    const depth = nodes[i].depth;
    stack.length = depth; // pop back to this node's own ancestor scope
    const parentGroup = depth === 0 ? rootGroup : stack[depth - 1];
    parentGroup.count += 1;
    const posInSet = parentGroup.count;
    const myGroup: SiblingGroup = { count: 0 };
    stack[depth] = myGroup;
    groups[i] = parentGroup;
    result[i] = { level: depth + 1, posInSet, setSize: 0 };
  }

  // setSize is only final once every sibling has been counted, so back-fill
  // it in a second, allocation-free pass over the already-built result array.
  for (let i = 0; i < nodes.length; i++) {
    result[i].setSize = groups[i].count;
  }

  return result;
}
