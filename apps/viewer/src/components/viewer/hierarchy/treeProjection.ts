/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TreeNode } from './types';

interface Branch {
  node: TreeNode;
  children: Branch[];
}

/** Index the fully built pre-order tree once. Expansion then visits only rows
 * that can be shown; a collapsed subtree never enters the toggle path. */
export function indexHierarchyTree(nodes: readonly TreeNode[]): readonly Branch[] {
  const roots: Branch[] = [];
  const ancestors: Branch[] = [];
  for (const node of nodes) {
    ancestors.length = node.depth;
    const branch: Branch = { node, children: [] };
    if (node.depth === 0) {
      roots.push(branch);
    } else {
      const parent = ancestors[node.depth - 1];
      if (!parent) throw new Error(`Hierarchy node ${node.id} has no parent at depth ${node.depth - 1}`);
      parent.children.push(branch);
    }
    ancestors[node.depth] = branch;
  }
  return roots;
}

/** Preserve the builders' row order and expansion semantics without calling
 * a builder or scanning the children of a collapsed branch. */
export function flattenVisibleHierarchy(
  roots: readonly Branch[],
  expanded: ReadonlySet<string>,
): TreeNode[] {
  const visible: TreeNode[] = [];
  const pending = [...roots].reverse();
  while (pending.length > 0) {
    const branch = pending.pop()!;
    const { node } = branch;
    // A builder may deliberately keep a row unexpandable (Materials, the
    // Models divider). Its full-tree isExpanded value remains authoritative.
    const isExpanded = node.isExpanded && expanded.has(node.id);
    visible.push(node.isExpanded === isExpanded ? node : { ...node, isExpanded });
    if (isExpanded) {
      for (let i = branch.children.length - 1; i >= 0; i--) pending.push(branch.children[i]);
    }
  }
  return visible;
}
