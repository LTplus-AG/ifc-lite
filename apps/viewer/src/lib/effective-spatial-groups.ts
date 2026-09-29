/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { edgeSurvives, isSpatialStructureTypeName, RelationshipType } from '@ifc-lite/data';
import { iterateEffectiveEntityIds, type MutablePropertyView } from '@ifc-lite/mutations';
import { normalizeIfcTypeName, type IfcDataStore } from '@ifc-lite/parser';
import { effectiveMutationRelationships } from '@/sdk/adapters/query-overlay-relations';
import { effectiveContextType } from '@/components/viewer/EntityContextMenu.effective-selection';

type ParentIndex = Map<number, number[]>;

function spatialSourceIds(store: IfcDataStore): number[] {
  const project = store.spatialHierarchy?.project;
  if (!project) return [];
  const ids: number[] = [];
  const pending = [project];
  const seen = new Set<number>();
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (seen.has(node.expressId)) continue;
    seen.add(node.expressId);
    ids.push(node.expressId);
    for (let i = node.children.length - 1; i >= 0; i--) pending.push(node.children[i]);
  }
  return ids;
}

/** Cheap availability check; generation builds the relationship index once. */
export function hasEffectiveScheduleContainers(store: IfcDataStore, view: MutablePropertyView): boolean {
  if (!store.spatialHierarchy) return false;
  return !iterateEffectiveEntityIds(store, view, ['IfcBuildingStorey', 'IfcBuilding'], spatialSourceIds(store))
    .next().done;
}

function append(index: ParentIndex, child: number, parent: number): void {
  const parents = index.get(child) ?? [];
  if (!parents.includes(parent)) parents.push(parent);
  index.set(child, parents);
}

/** Current contained products grouped by current storey or building. */
export function effectiveScheduleGroups(
  store: IfcDataStore,
  view: MutablePropertyView,
  typeName: 'IfcBuildingStorey' | 'IfcBuilding',
  options?: { includeSpatialNodes?: boolean },
): Map<number, number[]> {
  const hierarchy = store.spatialHierarchy;
  if (!hierarchy) return new Map();
  const overlay = effectiveMutationRelationships(store, view);
  const superseded = (id: number) => view.isDeleted(id) || overlay.supersededSourceIds.has(id);
  const containment: ParentIndex = new Map();
  const aggregation: ParentIndex = new Map();
  const aggregateChildren = new Map<number, number[]>();
  const add = (kind: 'contains' | 'aggregates', parent: number, child: number) => {
    if (view.isDeleted(parent) || view.isDeleted(child)) return;
    append(kind === 'contains' ? containment : aggregation, child, parent);
    if (kind === 'aggregates') append(aggregateChildren, parent, child);
  };

  // The graph's source-id index visits each source relationship edge once.
  // Superseded or deleted IfcRel* records do not leave phantom memberships.
  for (const parent of store.relationships.forward.offsets.keys()) {
    for (const edge of store.relationships.forward.getEdges(parent)) {
      if (!edgeSurvives(edge, superseded)) continue;
      if (edge.type === RelationshipType.ContainsElements) add('contains', parent, edge.target);
      else if (edge.type === RelationshipType.Aggregates) add('aggregates', parent, edge.target);
    }
  }
  for (const relation of overlay.relationships) {
    const type = relation.relationshipType.toUpperCase();
    const kind = type === 'IFCRELCONTAINEDINSPATIALSTRUCTURE' ? 'contains'
      : type === 'IFCRELAGGREGATES' || type === 'IFCRELNESTS' ? 'aggregates' : null;
    if (!kind) continue;
    for (const parent of relation.relating) for (const child of relation.related) add(kind, parent, child);
  }

  const groups = new Map<number, number[]>();
  for (const { expressId } of iterateEffectiveEntityIds(store, view, [typeName], spatialSourceIds(store))) groups.set(expressId, []);
  const isSpatial = (id: number) => isSpatialStructureTypeName(normalizeIfcTypeName(effectiveContextType(store, view, id)));

  // A contained product and its aggregate descendants are schedule products.
  // Spaces are traversed as ancestors, never emitted as task products.
  const products: number[] = [];
  const seenProducts = new Set<number>();
  const addProduct = (id: number) => {
    if (seenProducts.has(id) || view.isDeleted(id) || (!options?.includeSpatialNodes && isSpatial(id))) return;
    seenProducts.add(id);
    products.push(id);
  };
  for (const id of containment.keys()) addProduct(id);
  // An IfcRelAggregates child can inherit its storey through a product parent
  // (or be aggregated directly by the storey) without any containment edge.
  for (const id of aggregation.keys()) addProduct(id);
  for (let i = 0; i < products.length; i++) {
    for (const child of aggregateChildren.get(products[i]) ?? []) addProduct(child);
  }

  for (const product of products) {
    const queue = [product];
    const visited = new Set<number>(queue);
    let assigned = false;
    for (let i = 0; i < queue.length && !assigned; i++) {
      const current = queue[i];
      for (const parent of [...containment.get(current) ?? [], ...aggregation.get(current) ?? []]) {
        if (view.isDeleted(parent) || visited.has(parent)) continue;
        if (groups.has(parent)) {
          groups.get(parent)!.push(product);
          assigned = true;
          break;
        }
        visited.add(parent);
        queue.push(parent);
      }
    }
  }
  return groups;
}
