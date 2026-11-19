/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TreeNode } from './types';

/** Plain-data equality for tree rows: primitives, arrays and plain objects. */
function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) {
    // Comparing a rebuilt member list costs no more than building it did.
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameData(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b) || Object.getPrototypeOf(a) !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (!Object.hasOwn(b, key) || !sameData((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }
  return true;
}

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
  // Rows usually keep their positions; index by id only when one moved.
  let byId: Map<string, TreeNode> | undefined;
  let unchanged = previous.length === next.length;
  const shared = next.map((node, i) => {
    const prior = previous[i]?.id === node.id ? previous[i]
      : (byId ??= new Map(previous.map((row) => [row.id, row]))).get(node.id);
    const kept = prior && sameData(prior, node) ? prior : node;
    if (kept !== previous[i]) unchanged = false;
    return kept;
  });
  return unchanged ? previous : shared;
}
