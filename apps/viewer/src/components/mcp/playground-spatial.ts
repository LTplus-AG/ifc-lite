/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EntityData, EntityRef } from '@ifc-lite/sdk';
import { effectiveEntities } from './playground-effective.js';
import type { LoadedPlaygroundModel } from './playground-dispatcher.js';

interface SpatialNode {
  expressId: number;
  type: string;
  name: string;
  children: SpatialNode[];
}

const MAX_HIERARCHY_NODES = 5_000;
const MAX_HIERARCHY_DEPTH = 6;
const MAX_CONTAINMENT_STEPS = 32;

/** Build a chat-sized live spatial tree. Path-local cycle detection keeps
 * legitimate shared descendants visible under each parent. */
export function playgroundSpatialHierarchy(model: LoadedPlaygroundModel): {
  tree: SpatialNode[];
  truncated: boolean;
} {
  let remaining = MAX_HIERARCHY_NODES;
  let truncated = false;
  const build = (entity: EntityData, depth: number, path: Set<number>): SpatialNode | null => {
    if (remaining === 0) { truncated = true; return null; }
    remaining--;
    const out: SpatialNode = {
      expressId: entity.ref.expressId,
      type: entity.type,
      name: entity.name,
      children: [],
    };
    const children = [...model.bim.decomposes(entity.ref), ...model.bim.contains(entity.ref)];
    if (depth >= MAX_HIERARCHY_DEPTH) {
      if (children.length > 0) truncated = true;
      return out;
    }
    const siblings = new Set<number>();
    for (const child of children) {
      if (remaining === 0) { truncated = true; break; }
      const id = child.ref.expressId;
      if (siblings.has(id)) continue;
      siblings.add(id);
      if (path.has(id)) { truncated = true; continue; }
      path.add(id);
      const nested = build(child, depth + 1, path);
      path.delete(id);
      if (nested) out.children.push(nested);
    }
    return out;
  };

  const tree: SpatialNode[] = [];
  for (const { expressId } of effectiveEntities(model, ['IFCPROJECT'])) {
    if (remaining === 0) { truncated = true; break; }
    const root = model.bim.entity({ modelId: model.id, expressId });
    if (!root) continue;
    const node = build(root, 0, new Set([expressId]));
    if (node) tree.push(node);
  }
  return { tree, truncated };
}

/** Walk upward through live containment/aggregation edges, reporting a bound
 * or cycle instead of returning an apparently complete path. */
export function playgroundContainmentChain(model: LoadedPlaygroundModel, ref: EntityRef): {
  path: Array<{ expressId: number; type: string; name: string; globalId: string }>;
  truncated: boolean;
} {
  const path: Array<{ expressId: number; type: string; name: string; globalId: string }> = [];
  const seen = new Set<number>();
  let truncated = false;
  let current = model.bim.entity(ref);
  while (current) {
    const id = current.ref.expressId;
    if (seen.has(id)) { truncated = true; break; }
    seen.add(id);
    path.push({ expressId: id, type: current.type, name: current.name, globalId: current.globalId });
    const next = model.bim.containedIn(current.ref) ?? model.bim.decomposedBy(current.ref);
    if (next && path.length >= MAX_CONTAINMENT_STEPS) { truncated = true; break; }
    current = next;
  }
  return { path, truncated };
}
