/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Emitting one spatial-tree element row (and its `IfcRelAggregates` subtree,
 * issue #1133), and emitting a whole direct-container list of them split into
 * shaped rows plus one grayed "Other" bucket (#4764) for the ones with no
 * shape. Extracted from `treeDataBuilder.ts` — which had two call sites for
 * this exact split (the single/federated spatial tree and the multi-model
 * Storeys section's per-model contribution) — so the row shape stays one
 * implementation rather than two, and so `treeDataBuilder.ts` stays under its
 * module-size budget.
 */

import { getAggregatedChildren, collectAggregatedDescendants, type AggregationRelationships } from '@/utils/aggregation';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { FederatedModel } from '@/store';
import { isPhysicalObjectType } from '@/lib/physical-objects';
import { resolveTreeGlobalId } from './productTree';
import type { TreeNode, HierarchySortMode, ExpansionLookup } from './types';

/** Natural, case-insensitive name collation so "Level 2" sorts before "Level
 *  10" — the same convention `treeDataBuilder.ts`'s storey sort uses. A
 *  second `Intl.Collator` instance rather than a shared import: cheap to
 *  construct, and it keeps this file free of a back-import from
 *  `treeDataBuilder.ts` for one constant. */
const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** The name a spatial element row renders with: its entity name, or a
 *  "<Type> #<id>" fallback. Single source of truth so the displayed label
 *  (`emitElementSubtree`) and the name-sort key (`orderElementIdsByName`)
 *  can't drift apart. Callers that already resolved the type name pass it as
 *  `typeName` so the fallback branch does not fetch it a second time. */
function getElementDisplayName(id: number, dataStore: IfcDataStore, typeName?: string): string {
  const entities = dataStore.entities;
  const name = entities?.getName(id);
  if (name) return name;
  return `${typeName || entities?.getTypeName(id) || 'Unknown'} #${id}`;
}

/** Order the element rows within a spatial container by the active browser sort
 *  (issue #1476). A name sort orders elements by the same visible name the row
 *  renders (`getName || "<Type> #<id>"`), using the natural-numeric collator so
 *  "W-2" sorts before "W-10"; this makes the sort reach INSIDE a storey, not just
 *  the storey rows — the whole point of the reported bug (one storey means the
 *  storey sort is a no-op). Elevation modes keep the as-modeled document order, since
 *  individual elements carry no elevation. Returns the input array unchanged (not
 *  a copy) when nothing to reorder, so callers must treat the result as readonly.
 *  `Array.prototype.sort` is stable, so equal-named elements keep document order. */
export function orderElementIdsByName(
  elementIds: number[],
  dataStore: IfcDataStore,
  mode: HierarchySortMode,
): number[] {
  if ((mode !== 'name-asc' && mode !== 'name-desc') || elementIds.length < 2) {
    return elementIds;
  }
  const dir = mode === 'name-desc' ? -1 : 1;
  // Decorate-sort-undecorate: resolve each display name exactly once rather than
  // O(n log n) times inside the comparator.
  return elementIds
    .map((id) => ({ id, name: getElementDisplayName(id, dataStore) }))
    .sort((a, b) => dir * nameCollator.compare(a.name, b.name))
    .map((e) => e.id);
}

/**
 * Emit one element row and, if it decomposes via `IfcRelAggregates`, its parts
 * nested underneath (recursively). A decomposing assembly — an
 * `IfcElementAssembly`, or an `IfcStair`/`IfcRoof`/`IfcRamp` used as a container
 * — appears in the spatial tree as a leaf contained in its storey, while its
 * stair flights / railings / landing slabs / virtual clearance volumes hang off
 * it via aggregation and hold the actual geometry. Without nesting, those parts
 * were absent from the spatial panel and the assembly was unselectable
 * (issue #1133).
 *
 * `ancestors` is the aggregation path from the storey-level element down to
 * here, used to break malformed `IfcRelAggregates` cycles. `noGeometry` marks
 * a row (and, propagated, its subtree) as known to have no shape (#4764) — set
 * only by {@link emitElementsWithOtherBucket} for a row it bucketed under
 * "Other"; every other caller leaves it at the default.
 */
export function emitElementSubtree(
  elementId: number,
  modelId: string,
  models: Map<string, FederatedModel>,
  dataStore: IfcDataStore,
  depth: number,
  expandedNodes: ExpansionLookup,
  nodes: TreeNode[],
  ancestors: Set<number>,
  sortMode: HierarchySortMode,
  noGeometry = false,
): void {
  const relationships = dataStore.relationships as AggregationRelationships | undefined;
  const globalId = resolveTreeGlobalId(modelId, elementId, models);
  const entityType = dataStore.entities?.getTypeName(elementId) || 'Unknown';
  // Reuse entityType so an unnamed element resolves its type name only once.
  const entityName = getElementDisplayName(elementId, dataStore, entityType);

  // Direct decomposition children, minus anything already on the path (cycle
  // guard), ordered by the active name sort so it reaches inside a decomposing
  // assembly too, not just the storey rows (issue #1476).
  const childIds = orderElementIdsByName(
    getAggregatedChildren(relationships, elementId).filter(
      (id) => id !== elementId && !ancestors.has(id),
    ),
    dataStore,
    sortMode,
  );
  const hasChildren = childIds.length > 0;
  const nodeId = `element-${modelId}-${elementId}`;
  const isExpanded = hasChildren && expandedNodes.has(nodeId);

  // All descendant parts carry the geometry — stash their global IDs so a click
  // on the (geometry-less) assembly can highlight / frame / isolate the whole
  // thing at once, even while the row is collapsed.
  const assemblyChildGlobalIds = hasChildren
    ? collectAggregatedDescendants(relationships, elementId).map((id) =>
        resolveTreeGlobalId(modelId, id, models),
      )
    : undefined;

  nodes.push({
    id: nodeId,
    expressIds: [elementId],
    globalIds: [globalId],
    modelIds: [modelId],
    modelId,
    name: entityName,
    type: 'element',
    ifcType: entityType,
    depth,
    hasChildren,
    isExpanded,
    isVisible: true, // Computed lazily during render
    elementCount: hasChildren ? childIds.length : undefined,
    assemblyChildGlobalIds,
    noGeometry,
  });

  if (isExpanded) {
    const nextAncestors = new Set(ancestors).add(elementId);
    for (const childId of childIds) {
      // A geometry-less element by definition has no geometry-bearing
      // aggregated part either (else `hasShape`/`renders` would have said
      // yes), so in practice this row has no children whenever `noGeometry`
      // is true. Propagate anyway rather than assume it, so a future caller
      // can never end up with a normal-looking child under a grayed parent.
      emitElementSubtree(childId, modelId, models, dataStore, depth + 1, expandedNodes, nodes, nextAncestors, sortMode, noGeometry);
    }
  }
}

/**
 * Emit a list of direct-container elements, splitting off those known to
 * have no shape into one collapsed "Other" bucket row (grayed, BIMcollab
 * Zoom convention — see AGENTS.md's product-owner note on #4764) instead of
 * mixing them in with normal rows or dropping them.
 *
 * `hasShape` is `null` while geometry for this model hasn't loaded yet
 * (`makeShapeTest`'s `geometryKnown` gate) — absence is unanswerable then,
 * so every element is emitted normally with no split and no "Other" row,
 * exactly like the count badge already treats that window.
 *
 * A shapeless row joins "Other" only when it is ALSO a physical object
 * (`isPhysicalObjectType` — the same predicate `AssemblyGeometry.isOther`
 * gates on for the By Class / By Type tabs, #4764 review). A directly
 * contained `IfcAnnotation` or other non-physical row with no representation
 * is schema-legal and ordinary — it renders as a normal selectable row
 * instead, never grayed or bucketed, so the three tree paths agree on what
 * "Other" means.
 */
export function emitElementsWithOtherBucket(
  elementIds: readonly number[],
  modelId: string,
  models: Map<string, FederatedModel>,
  dataStore: IfcDataStore,
  depth: number,
  expandedNodes: ExpansionLookup,
  nodes: TreeNode[],
  sortMode: HierarchySortMode,
  hasShape: ((id: number) => boolean) | null,
  otherNodeId: string,
): void {
  const ordered = orderElementIdsByName(elementIds as number[], dataStore, sortMode);

  if (!hasShape) {
    for (const elementId of ordered) {
      emitElementSubtree(elementId, modelId, models, dataStore, depth, expandedNodes, nodes, new Set(), sortMode);
    }
    return;
  }

  const shaped: number[] = [];
  const other: number[] = [];
  for (const elementId of ordered) {
    if (hasShape(elementId)) {
      shaped.push(elementId);
      continue;
    }
    // Mirrors `AssemblyGeometry.isOther`'s physical-object gate: only a
    // physical element with no shape belongs in "Other". A non-physical row
    // (an annotation, for instance) with no representation is normal and
    // stays a plain row instead of being swept into the bucket.
    const typeName = dataStore.entities?.getTypeName(elementId) ?? 'Unknown';
    (isPhysicalObjectType(typeName) ? other : shaped).push(elementId);
  }

  for (const elementId of shaped) {
    emitElementSubtree(elementId, modelId, models, dataStore, depth, expandedNodes, nodes, new Set(), sortMode);
  }

  if (other.length === 0) return;

  const isOtherExpanded = expandedNodes.has(otherNodeId);
  nodes.push({
    id: otherNodeId,
    expressIds: other,
    globalIds: other.map((id) => resolveTreeGlobalId(modelId, id, models)),
    modelIds: [modelId],
    modelId,
    name: 'Other',
    type: 'other-group',
    depth,
    hasChildren: true,
    isExpanded: isOtherExpanded,
    isVisible: true,
    elementCount: other.length,
  });

  if (isOtherExpanded) {
    // Already in `orderElementIdsByName` order as a subsequence of `ordered`.
    for (const elementId of other) {
      emitElementSubtree(elementId, modelId, models, dataStore, depth + 1, expandedNodes, nodes, new Set(), sortMode, true);
    }
  }
}
