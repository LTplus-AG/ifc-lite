/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The "Other" bucket (#4764): a physical element that belongs in a products
 * tree but has neither its own geometry nor a geometry-bearing aggregated
 * part used to be dropped outright. The product decision instead grays such
 * a row out and files it under one flat, collapsed "Other" node, following
 * the BIMcollab Zoom convention — never grouped by its own class (that would
 * put it back among the objects it is deliberately excluded from), and never
 * counted (the badge above it already excludes it via the same shape test).
 *
 * `buildTypeTree` (By Class) and `buildIfcTypeTree` (By Type) both need this
 * exact shape, so it lives once here rather than as two hand-written copies
 * that could drift — the same reasoning `productTree.ts`'s header gives for
 * living apart from `treeDataBuilder.ts`.
 */

import type { TreeNode, ExpansionLookup } from './types';

export interface OtherBucketEntry {
  expressId: number;
  globalId: number;
  name: string;
  modelId: string;
  /** The entity's own IFC class — carried along for context and the row's
   *  icon, since this row is no longer grouped under a class header. */
  ifcType: string;
}

/**
 * Build the "Other" bucket header row plus, when expanded, one grayed
 * (`noGeometry: true`) element row per entry. Empty when there is nothing to
 * bucket — including while geometry is still streaming, since callers only
 * collect entries once `AssemblyGeometry.isOther` says so, and it is `false`
 * for everything mid-load (see its own doc).
 */
export function buildOtherGroupNodes(
  entries: readonly OtherBucketEntry[],
  otherNodeId: string,
  expandedNodes: ExpansionLookup,
): TreeNode[] {
  if (entries.length === 0) return [];

  const nodes: TreeNode[] = [];
  const isOtherExpanded = expandedNodes.has(otherNodeId);
  nodes.push({
    id: otherNodeId,
    expressIds: entries.map((e) => e.expressId),
    globalIds: entries.map((e) => e.globalId),
    memberGlobalIds: entries.map((e) => e.globalId),
    modelIds: [],
    name: 'Other',
    type: 'other-group',
    depth: 0,
    hasChildren: true,
    isExpanded: isOtherExpanded,
    isVisible: true,
    elementCount: entries.length,
  });

  if (isOtherExpanded) {
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of sorted) {
      nodes.push({
        id: `element-${entry.modelId}-${entry.expressId}`,
        expressIds: [entry.expressId],
        globalIds: [entry.globalId],
        modelIds: [entry.modelId],
        modelId: entry.modelId,
        name: entry.name,
        type: 'element',
        ifcType: entry.ifcType,
        depth: 1,
        hasChildren: false,
        isExpanded: false,
        isVisible: true,
        noGeometry: true,
      });
    }
  }

  return nodes;
}
