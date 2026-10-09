/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { iterateEffectiveEntityIds, type MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { editOwnershipRefusal } from '@ifc-lite/export';
import { AnchorEntityReader } from './resolve-anchor.js';
import { conformsTo, schemaRegistry } from './schema-attributes.js';
import type { SpatialAnchorSchema } from './anchor.js';
import { placementInAncestor, placementRelativeTo, refId, type Frame3 } from './host-geometry-frame.js';

const OP = 'reassignElementsToStoreyInStore';
const fail = (message: string): never => { throw new Error(`${OP}: ${message}`); };
export type ReassignmentRelationship = { id: number; type: string; parent: number; children: number[]; listIndex: number; parentIndex: number };
export type StoreyReassignmentPlan = {
  sourceStoreyId: number; destinationStoreyId: number; destinationPlacementId: number;
  products: { expressId: number; GlobalId: string; type: string; attributes: readonly unknown[]; placementId: number; world: Frame3 }[];
  placements: { expressId: number; relative: Frame3 }[];
  relationships: ReassignmentRelationship[];
  sourceMemberships: ReassignmentRelationship[];
};

function refs(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) return fail('unreadable empty relationship membership');
  const ids = value.map(refId);
  if (ids.some(id => id === null) || new Set(ids).size !== ids.length) return fail('unreadable or duplicate relationship membership');
  return ids as number[];
}

/** Effective relationships, not stale parser edges. The finite closure includes
 * aggregate/nested parts and the complete host → opening → filling chain. */
function relationships(reader: AnchorEntityReader): ReassignmentRelationship[] {
  const result: ReassignmentRelationship[] = [];
  let work = 0;
  for (const type of ['IFCRELAGGREGATES', 'IFCRELNESTS', 'IFCRELVOIDSELEMENT', 'IFCRELFILLSELEMENT', 'IFCRELCONTAINEDINSPATIALSTRUCTURE']) {
    for (const id of reader.ids(type)) {
      const entity = reader.entity(id) ?? fail(`unreadable relationship #${id}`);
      const contained = type === 'IFCRELCONTAINEDINSPATIALSTRUCTURE';
      const parentIndex = contained ? 5 : 4, listIndex = contained ? 4 : 5;
      const parent = refId(entity.attributes[parentIndex]) ?? fail(`unreadable parent of #${id}`);
      const singleton = type === 'IFCRELVOIDSELEMENT' || type === 'IFCRELFILLSELEMENT';
      const rawChildren = entity.attributes[listIndex];
      work += 1 + (Array.isArray(rawChildren) ? rawChildren.length : 1);
      if (work > 2_000_000) fail('relationship inventory exceeds 2,000,000 references');
      const children = singleton ? [refId(entity.attributes[listIndex]) ?? fail(`unreadable child of #${id}`)] : refs(entity.attributes[listIndex]);
      result.push({ id, type, parent, children, listIndex, parentIndex });
    }
  }
  return result;
}

/** Read-only admission shared by native commit and reviewed transport. Frames
 * are in the model's native length unit: preserving them is unit-independent. */
export function planStoreyReassignment(
  store: IfcDataStore, view: MutablePropertyView, selectedIds: readonly number[], sourceStoreyId: number, destinationStoreyId: number,
): StoreyReassignmentPlan {
  if (!selectedIds.length || selectedIds.length > 200 || new Set(selectedIds).size !== selectedIds.length) fail('select 1–200 distinct products');
  if (sourceStoreyId === destinationStoreyId) fail('source and destination storeys must differ');
  const reader = new AnchorEntityReader(store, view);
  const registry = schemaRegistry(store.schemaVersion as SpatialAnchorSchema, OP);
  const storeyPlacement = (id: number) => {
    const entity = reader.entity(id);
    if (entity?.type.toUpperCase() !== 'IFCBUILDINGSTOREY') return fail(`#${id} is not a live IfcBuildingStorey in this model`);
    const placement = refId(entity.attributes[5]) ?? fail(`storey #${id} has no placement`);
    if (!placementInAncestor(reader, placement, null)) fail(`storey #${id} has an unreadable world placement`);
    return placement;
  };
  storeyPlacement(sourceStoreyId);
  const destinationPlacementId = storeyPlacement(destinationStoreyId);
  const allRelationships = relationships(reader), ids = new Set(selectedIds), queue = [...ids];
  const outgoing = new Map<number, ReassignmentRelationship[]>();
  for (const rel of allRelationships) { const edges = outgoing.get(rel.parent) ?? []; edges.push(rel); outgoing.set(rel.parent, edges); }
  for (let index = 0; index < queue.length; index++) {
    for (const rel of outgoing.get(queue[index]) ?? []) {
      for (const child of rel.children) {
        if (ids.has(child)) continue;
        if (ids.size >= 5_000) fail('dependency closure exceeds 5,000 products');
        ids.add(child); queue.push(child);
      }
    }
  }
  const incoming = new Map<number, ReassignmentRelationship[]>();
  for (const rel of allRelationships) for (const child of rel.children) {
    if (!ids.has(child)) continue;
    const parents = incoming.get(child) ?? []; parents.push(rel); incoming.set(child, parents);
    if (!ids.has(rel.parent) && rel.parent !== sourceStoreyId) fail(`#${child} belongs to an external host, assembly or container #${rel.parent}`);
  }
  // Each direct spatial owner is unique; host and aggregate ownership may
  // coexist with containment but never be silently detached.
  for (const id of ids) {
    const spatial = (incoming.get(id) ?? []).filter(rel => rel.type === 'IFCRELCONTAINEDINSPATIALSTRUCTURE'
      || (rel.type === 'IFCRELAGGREGATES' && rel.parent === sourceStoreyId));
    if (spatial.length > 1) fail(`#${id} has duplicate spatial ownership`);
    for (const family of [['IFCRELAGGREGATES', 'IFCRELNESTS'], ['IFCRELVOIDSELEMENT'], ['IFCRELFILLSELEMENT']]) {
      if ((incoming.get(id) ?? []).filter(rel => family.includes(rel.type)).length > 1) fail(`#${id} has ambiguous dependency ownership`);
    }
  }
  const ownedRelationships = allRelationships.filter(rel => ids.has(rel.parent) && rel.children.some(id => ids.has(id)));
  const indegree = new Map([...ids].map(id => [id, 0]));
  for (const rel of ownedRelationships) for (const child of rel.children) indegree.set(child, (indegree.get(child) ?? 0) + 1);
  const roots = [...ids].filter(id => indegree.get(id) === 0), topo = [...roots];
  for (let i = 0; i < topo.length; i++) for (const rel of outgoing.get(topo[i]) ?? []) {
    for (const child of rel.children) { const n = indegree.get(child)! - 1; indegree.set(child, n); if (n === 0) topo.push(child); }
  }
  if (topo.length !== ids.size) fail('cyclic hosted or aggregate dependencies');
  if (roots.some(id => !(incoming.get(id) ?? []).some(rel => rel.parent === sourceStoreyId))) fail('selected roots must belong directly to the declared source storey');
  const products = [...ids].sort((a, b) => a - b).map(expressId => {
    const entity = reader.entity(expressId) ?? fail(`missing product #${expressId}`);
    if (!conformsTo(registry, entity.type, 'IfcProduct') || ['IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY', 'IFCGRID'].includes(entity.type.toUpperCase())) fail(`#${expressId} is not a supported movable product`);
    const guid = entity.attributes[0];
    const GlobalId = typeof guid === 'string' && /^[0-3][0-9A-Za-z_$]{21}$/.test(guid) ? guid : fail(`#${expressId} has no valid GlobalId`);
    const placementId = refId(entity.attributes[5]) ?? fail(`#${expressId} has no ObjectPlacement`);
    const world = placementInAncestor(reader, placementId, null) ?? fail(`#${expressId} has an unreadable world placement`);
    return { expressId, GlobalId, type: entity.type, attributes: entity.attributes, placementId, world };
  });
  const storeyGuids = [sourceStoreyId, destinationStoreyId].map(id => {
    const guid = reader.entity(id)?.attributes[0];
    return typeof guid === 'string' && /^[0-3][0-9A-Za-z_$]{21}$/.test(guid) ? guid : fail(`storey #${id} has no valid GlobalId`);
  });
  const guids = new Set([...storeyGuids, ...products.map(product => product.GlobalId)]), guidCounts = new Map<string, number>();
  for (const { expressId } of iterateEffectiveEntityIds(store, view)) {
    const entity = reader.entity(expressId);
    const guid = entity?.attributes[0];
    if (entity && conformsTo(registry, entity.type, 'IfcRoot') && typeof guid === 'string' && guids.has(guid)) guidCounts.set(guid, (guidCounts.get(guid) ?? 0) + 1);
  }
  if (guids.size !== products.length + 2 || [...guids].some(guid => guidCounts.get(guid) !== 1)) fail('ambiguous duplicate product GlobalId');
  const placementIds = new Set(products.map(product => product.placementId));
  const placements = [...placementIds].filter(id => {
    const visited = new Set<number>(); let parent = refId(reader.entity(id)?.attributes[0]);
    while (parent !== null) {
      if (visited.has(parent) || visited.size >= 10_000) return fail('cyclic placement ancestry');
      visited.add(parent); if (placementIds.has(parent)) return false;
      parent = refId(reader.entity(parent)?.attributes[0]);
    }
    return true;
  }).map(expressId => {
    // Reparenting under a descendant would introduce a new placement cycle.
    const visited = new Set<number>(); let parent: number | null = destinationPlacementId;
    while (parent !== null) {
      if (parent === expressId) fail('destination placement depends on a moved product');
      if (visited.has(parent) || visited.size >= 10_000) fail('cyclic destination placement');
      visited.add(parent); parent = refId(reader.entity(parent)?.attributes[0]);
    }
    const relative = placementRelativeTo(reader, expressId, destinationPlacementId) ?? fail(`cannot express placement #${expressId} in destination frame`);
    return { expressId, relative };
  });
  const refusal = editOwnershipRefusal(store, view, placements.map(p => p.expressId), ids);
  if (refusal) fail(refusal);
  return { sourceStoreyId, destinationStoreyId, destinationPlacementId, products, placements,
    relationships: ownedRelationships, sourceMemberships: allRelationships.filter(rel => rel.parent === sourceStoreyId && rel.children.some(id => ids.has(id))) };
}
