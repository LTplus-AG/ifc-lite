/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tombstone (deletion overlay) semantics for IFCX composition.
 *
 * A tombstone is an opinion `{ "ifclite::deleted": true }` at an entity
 * path. Composition resolves the attribute with normal layer strength
 * (stronger layers override weaker ones), so:
 *
 * - a tombstone shadows all weaker opinions for that path, including the
 *   entity's child subtree (entity tombstones delete the subtree), and
 * - a stronger layer may resurrect the entity by asserting
 *   `"ifclite::deleted": false` (this is how a revert layer undoes a
 *   deletion).
 *
 * The filter runs after attribute merging, so the surviving value of
 * `ifclite::deleted` is already the strongest opinion in the stack.
 *
 * Spec: docs/architecture/layer-prs/02-layer-format.md §2.3.
 */

import type { ComposedNode } from './types.js';
import { IFCLITE_ATTR } from './types.js';

/** True when a merged attribute record marks the node as deleted. */
export function isTombstoned(attributes: Map<string, unknown>): boolean {
  return attributes.get(IFCLITE_ATTR.DELETED) === true;
}

/**
 * Remove tombstoned nodes (and their subtrees) from a composed node map.
 *
 * - Nodes whose strongest `ifclite::deleted` opinion is `true` are removed.
 * - Their descendants (reachable through `children`) are removed with them.
 * - References to removed nodes are dropped from surviving parents.
 * - The `ifclite::deleted` marker itself is stripped from survivors so the
 *   composed state is clean for extractors and export.
 *
 * The input map is mutated in place (composition owns these structures)
 * and returned for convenience.
 */
export function applyTombstones<T extends ComposedNode>(
  composed: Map<string, T>
): Map<string, T> {
  const deleted = new Set<string>();
  for (const [path, node] of composed) {
    if (isTombstoned(node.attributes)) deleted.add(path);
  }
  if (deleted.size === 0) {
    // Still strip explicit `deleted: false` resurrect markers.
    for (const node of composed.values()) {
      node.attributes.delete(IFCLITE_ATTR.DELETED);
    }
    return composed;
  }

  // Entity tombstones shadow child paths: expand to full subtrees.
  const queue = [...deleted];
  while (queue.length > 0) {
    const path = queue.pop();
    if (path === undefined) break;
    const node = composed.get(path);
    if (!node) continue;
    for (const child of node.children.values()) {
      // A child carrying its own resurrect opinion stays only if it is
      // also referenced by a surviving parent; subtree shadowing wins here.
      if (!deleted.has(child.path)) {
        deleted.add(child.path);
        queue.push(child.path);
      }
    }
  }

  for (const path of deleted) {
    composed.delete(path);
  }
  for (const node of composed.values()) {
    node.attributes.delete(IFCLITE_ATTR.DELETED);
    for (const [name, child] of node.children) {
      if (deleted.has(child.path)) node.children.delete(name);
    }
  }
  return composed;
}
