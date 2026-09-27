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
 * module-size budget. The rows, their "Other" shape test and the storey
 * badge all read an element's name and class through the session's mutation
 * view, so an element authored this session is labelled like any other (#6233).
 */

import { getAggregatedChildren, collectAggregatedDescendants, type AggregationRelationships } from '@/utils/aggregation';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { FederatedModel } from '@/store';
import { isPhysicalObjectType } from '@/lib/physical-objects';
import { makeAssemblyGeometry, resolveTreeGlobalId } from './productTree';
import { effectiveTreeEntityName } from './effectiveTypeEntities.js';
import { effectiveRowType, type TreeOverlay } from './treeOverlay.js';
import type { TreeNode, HierarchySortMode, ExpansionLookup } from './types';

/** One model's mutation view as the spatial tree reads it; absent = no edits. */
export type ElementRowView = MutablePropertyView | null | undefined;

/** The spatial tree's view for `modelId`. Legacy single-store mode keys its
 *  edits under `__legacy__`, as the Inspector does. */
export function spatialRowView(overlay: TreeOverlay | undefined, modelId: string): ElementRowView {
  return overlay?.(modelId === 'legacy' ? '__legacy__' : modelId);
}

/** The class a spatial element row shows and counts: the edited class, so an
 *  element authored this session reads as its own class rather than the
 *  parsed table's `'Unknown'` (#6233). A deleted parsed row keeps its parsed
 *  class; taking it out of the tree is not this label's job. */
export function elementRowType(dataStore: IfcDataStore, view: ElementRowView, id: number): string {
  return effectiveRowType(dataStore, view, id) ?? (dataStore.entities?.getTypeName(id) || 'Unknown');
}

/**
 * The shape half of the object count: "would this entity put anything on
 * screen?".
 *
 * It is `makeAssemblyGeometry`'s own `renders`, not a second reading of the
 * mesh set, so the spatial badge and the By Class tab cannot answer the same
 * question differently -- an `IfcRoof` whose geometry sits on its
 * `IfcRelAggregates` beams renders in both or neither.
 *
 * `null` while nothing has streamed: the shape test is unanswerable then, so
 * the count reports every physical object and says on hover that it is still
 * provisional, rather than reading an empty mesh set as "nothing has a shape".
 */
export function makeShapeTest(
  dataStore: IfcDataStore,
  view: ElementRowView,
  modelId: string,
  models: Map<string, FederatedModel>,
  geometricIds: Set<number> | undefined,
  geometryKnown = !!geometricIds && geometricIds.size > 0,
): ((id: number) => boolean) | null {
  if (!geometryKnown) return null;
  const assemblyGeometry = makeAssemblyGeometry(dataStore, modelId, models, geometricIds, true);
  return (id: number) =>
    assemblyGeometry.renders(
      elementRowType(dataStore, view, id),
      id,
      resolveTreeGlobalId(modelId, id, models),
    );
}

/** Natural, case-insensitive name collation so "Level 2" sorts before "Level
 *  10" — the same convention `treeDataBuilder.ts`'s storey sort uses. A
 *  second `Intl.Collator` instance rather than a shared import: cheap to
 *  construct, and it keeps this file free of a back-import from
 *  `treeDataBuilder.ts` for one constant. */
const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** The name a spatial element row renders with: its effective (overlay-aware)
 *  entity name, or a "<Type> #<id>" fallback. Single source of truth so the
 *  displayed label (`emitElementSubtree`) and the name-sort key
 *  (`orderElementIdsByName`) can't drift apart. Callers that already resolved
 *  the type name pass it as `typeName` so it is not resolved a second time. */
function getElementDisplayName(id: number, dataStore: IfcDataStore, view: ElementRowView, typeName?: string): string {
  return effectiveTreeEntityName(dataStore, view, id, '')
    || `${typeName ?? elementRowType(dataStore, view, id)} #${id}`;
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
  view: ElementRowView,
  mode: HierarchySortMode,
): number[] {
  if ((mode !== 'name-asc' && mode !== 'name-desc') || elementIds.length < 2) {
    return elementIds;
  }
  const dir = mode === 'name-desc' ? -1 : 1;
  // Decorate-sort-undecorate: resolve each display name exactly once rather than
  // O(n log n) times inside the comparator.
  return elementIds
    .map((id) => ({ id, name: getElementDisplayName(id, dataStore, view) }))
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
  view: ElementRowView,
  depth: number,
  expandedNodes: ExpansionLookup,
  nodes: TreeNode[],
  ancestors: Set<number>,
  sortMode: HierarchySortMode,
  noGeometry = false,
): void {
  const relationships = dataStore.relationships as AggregationRelationships | undefined;
  const globalId = resolveTreeGlobalId(modelId, elementId, models);
  const entityType = elementRowType(dataStore, view, elementId);
  // Reuse entityType so an unnamed element resolves its type name only once.
  const entityName = getElementDisplayName(elementId, dataStore, view, entityType);

  // Direct decomposition children, minus anything already on the path (cycle
  // guard), ordered by the active name sort so it reaches inside a decomposing
  // assembly too, not just the storey rows (issue #1476).
  const childIds = orderElementIdsByName(
    getAggregatedChildren(relationships, elementId).filter(
      (id) => id !== elementId && !ancestors.has(id),
    ),
    dataStore,
    view,
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
      emitElementSubtree(childId, modelId, models, dataStore, view, depth + 1, expandedNodes, nodes, nextAncestors, sortMode, noGeometry);
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
  view: ElementRowView,
  depth: number,
  expandedNodes: ExpansionLookup,
  nodes: TreeNode[],
  sortMode: HierarchySortMode,
  hasShape: ((id: number) => boolean) | null,
  otherNodeId: string,
): void {
  const ordered = orderElementIdsByName(elementIds as number[], dataStore, view, sortMode);

  if (!hasShape) {
    for (const elementId of ordered) {
      emitElementSubtree(elementId, modelId, models, dataStore, view, depth, expandedNodes, nodes, new Set(), sortMode);
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
    const typeName = elementRowType(dataStore, view, elementId);
    (isPhysicalObjectType(typeName) ? other : shaped).push(elementId);
  }

  for (const elementId of shaped) {
    emitElementSubtree(elementId, modelId, models, dataStore, view, depth, expandedNodes, nodes, new Set(), sortMode);
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
      emitElementSubtree(elementId, modelId, models, dataStore, view, depth + 1, expandedNodes, nodes, new Set(), sortMode, true);
    }
  }
}
