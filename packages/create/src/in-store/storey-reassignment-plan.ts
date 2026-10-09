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
export type ReassignmentRelationship = { id: number; type: string; parent: number; children: number[]; listIndex: number; parentIndex: number; attributes: readonly unknown[] };
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
      result.push({ id, type, parent, children, listIndex, parentIndex, attributes: entity.attributes });
    }
  }
  return result;
}

type Inventory = ReturnType<typeof planningInventory>;

/** One ephemeral effective snapshot per synchronous planning request. Never
 * reuse it across mutation revisions or native transactions. */
function planningInventory(store: IfcDataStore, view: MutablePropertyView) {
  class CachedReader extends AnchorEntityReader {
    private readonly records = new Map<number, ReturnType<AnchorEntityReader['entity']>>();
    override entity(id: number) {
      if (!this.records.has(id)) this.records.set(id, super.entity(id));
      return this.records.get(id) ?? null;
    }
  }
  const reader = new CachedReader(store, view), registry = schemaRegistry(store.schemaVersion as SpatialAnchorSchema, OP);
  const allRelationships = relationships(reader), outgoing = new Map<number, ReassignmentRelationship[]>();
  const incomingById = new Map<number, ReassignmentRelationship[]>(), relationOrder = new Map<number, number>();
  for (const [index, rel] of allRelationships.entries()) {
    relationOrder.set(rel.id, index);
    const edges = outgoing.get(rel.parent) ?? []; edges.push(rel); outgoing.set(rel.parent, edges);
    for (const child of rel.children) {
      const parents = incomingById.get(child) ?? []; parents.push(rel); incomingById.set(child, parents);
    }
  }
  const rootTypes = Object.entries(registry.entities).filter(([name, entity]) => name === 'IfcRoot' || entity.inheritanceChain?.includes('IfcRoot')).map(([name]) => name.toUpperCase());
  const guidCounts = new Map<string, number>();
  for (const { expressId } of iterateEffectiveEntityIds(store, view, rootTypes)) {
    const guid = reader.entity(expressId)?.attributes[0];
    if (typeof guid === 'string') guidCounts.set(guid, (guidCounts.get(guid) ?? 0) + 1);
  }
  return { reader, registry, outgoing, incomingById, relationOrder, guidCounts, ownership: new Map<string, string | null>() };
}

function planWithInventory(store: IfcDataStore, view: MutablePropertyView, selectedIds: readonly number[], sourceStoreyId: number,
  destinationStoreyId: number, inventory: Inventory): StoreyReassignmentPlan {
  if (!selectedIds.length || selectedIds.length > 200 || new Set(selectedIds).size !== selectedIds.length) fail('select 1–200 distinct products');
  if (sourceStoreyId === destinationStoreyId) fail('source and destination storeys must differ');
  const { reader, registry, outgoing, incomingById, relationOrder, guidCounts, ownership } = inventory;
  const storeyPlacement = (id: number) => {
    const entity = reader.entity(id);
    if (entity?.type.toUpperCase() !== 'IFCBUILDINGSTOREY') return fail(`#${id} is not a live IfcBuildingStorey in this model`);
    const placement = refId(entity.attributes[5]) ?? fail(`storey #${id} has no placement`);
    if (!placementInAncestor(reader, placement, null)) fail(`storey #${id} has an unreadable world placement`);
    return placement;
  };
  storeyPlacement(sourceStoreyId);
  const destinationPlacementId = storeyPlacement(destinationStoreyId);
  const ids = new Set(selectedIds), queue = [...ids];
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
  for (const child of ids) for (const rel of incomingById.get(child) ?? []) {
    const parents = incoming.get(child) ?? []; parents.push(rel); incoming.set(child, parents);
    if (!ids.has(rel.parent) && rel.parent !== sourceStoreyId) fail(`#${child} belongs to an external host, assembly or container #${rel.parent}`);
    if (rel.parent === sourceStoreyId && ['IFCRELVOIDSELEMENT', 'IFCRELFILLSELEMENT'].includes(rel.type)) fail('storey cannot own hosted dependencies');
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
  const ownedRelationships = [...ids].flatMap(id => outgoing.get(id) ?? []).sort((a, b) => relationOrder.get(a.id)! - relationOrder.get(b.id)!);
  const indegree = new Map([...ids].map(id => [id, 0]));
  for (const rel of ownedRelationships) for (const child of rel.children) indegree.set(child, (indegree.get(child) ?? 0) + 1);
  const roots = [...ids].filter(id => indegree.get(id) === 0), topo = [...roots];
  for (let i = 0; i < topo.length; i++) for (const rel of outgoing.get(topo[i]) ?? []) {
    for (const child of rel.children) { const n = indegree.get(child)! - 1; indegree.set(child, n); if (n === 0) topo.push(child); }
  }
  if (topo.length !== ids.size) fail('cyclic hosted or aggregate dependencies');
  for (const id of roots) {
    const spatialRoot = conformsTo(registry, reader.entity(id)?.type ?? '', 'IfcSpatialStructureElement');
    if (!(incoming.get(id) ?? []).some(rel => rel.parent === sourceStoreyId &&
      (rel.type === 'IFCRELCONTAINEDINSPATIALSTRUCTURE' || (spatialRoot && rel.type === 'IFCRELAGGREGATES')))) {
      fail('selected roots must have a spatial owner directly in the declared source storey');
    }
  }
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
  const guids = new Set([...storeyGuids, ...products.map(product => product.GlobalId)]);
  if (guids.size !== products.length + 2 || [...guids].some(guid => guidCounts.get(guid) !== 1)) fail('ambiguous duplicate product GlobalId');
  const sourceMemberships = (outgoing.get(sourceStoreyId) ?? []).filter(rel => rel.children.some(id => ids.has(id)));
  for (const relation of [...ownedRelationships, ...sourceMemberships]) {
    const guid = relation.attributes[0];
    if (typeof guid !== 'string' || !/^[0-3][0-9A-Za-z_$]{21}$/.test(guid)) fail(`relationship GlobalId is missing or malformed for #${relation.id}`);
    if (guidCounts.get(guid) !== 1) fail(`ambiguous duplicate relationship GlobalId for #${relation.id}`);
  }
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
  const ownershipKey = JSON.stringify([placements.map(p => p.expressId), products.map(p => p.expressId)]);
  if (!ownership.has(ownershipKey)) ownership.set(ownershipKey, editOwnershipRefusal(store, view, placements.map(p => p.expressId), ids));
  const refusal = ownership.get(ownershipKey);
  if (refusal) fail(refusal);
  return { sourceStoreyId, destinationStoreyId, destinationPlacementId, products, placements,
    relationships: ownedRelationships, sourceMemberships };
}

/** Complete read-only admission for one destination. */
export function planStoreyReassignment(store: IfcDataStore, view: MutablePropertyView, selectedIds: readonly number[],
  sourceStoreyId: number, destinationStoreyId: number): StoreyReassignmentPlan {
  return planWithInventory(store, view, selectedIds, sourceStoreyId, destinationStoreyId, planningInventory(store, view));
}

/** Selection capture shares one effective Root/relationship inventory across
 * at most 20 destination candidates. Each refusal remains explicit. */
export function planStoreyReassignmentCandidates(store: IfcDataStore, view: MutablePropertyView, selectedIds: readonly number[],
  sourceStoreyId: number, destinationStoreyIds: readonly number[]) {
  if (destinationStoreyIds.length > 20 || new Set(destinationStoreyIds).size !== destinationStoreyIds.length) fail('choose at most 20 distinct destination storeys');
  const inventory = planningInventory(store, view);
  return destinationStoreyIds.map(destinationStoreyId => {
    try { return { destinationStoreyId, plan: planWithInventory(store, view, selectedIds, sourceStoreyId, destinationStoreyId, inventory), refusal: null }; }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      return { destinationStoreyId, plan: null, refusal: error.message };
    }
  });
}
