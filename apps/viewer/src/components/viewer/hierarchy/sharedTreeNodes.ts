/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TreeNode } from './types';

/**
 * Keep the previous object for every row whose data did not change, and the
 * previous array when no row did (#10535). Tree builders and the expansion
 * projection return fresh objects, so without this an edit that leaves the
 * tree as it was still re-renders every visible row.
 */
export function shareUnchangedNodes(
  previous: TreeNode[],
  next: TreeNode[],
): TreeNode[] {
  if (previous === next) return next;
  const byId = new Map(previous.map((row) => [row.id, row]));
  let unchanged = previous.length === next.length;
  const shared = next.map((node, i) => {
    const prior = byId.get(node.id);
    // Rows are plain data (strings, numbers, booleans, arrays, plain objects): their JSON is their content.
    const kept = prior && (prior === node || JSON.stringify(prior) === JSON.stringify(node)) ? prior : node;
    if (kept !== previous[i]) unchanged = false;
    return kept;
  });
  return unchanged ? previous : shared;
}
