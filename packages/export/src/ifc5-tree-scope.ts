/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Effective IFC5 tree membership and parent selection (#4841). */

import { RelationshipType, createLogger, flattenRelationshipEdges } from '@ifc-lite/data';
import { EntityExtractor, type IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView, NewEntity } from '@ifc-lite/mutations';
import { authoredEntityRefs, type EffectiveEntityIndex } from './effective-index.js';
const CYCLE_CHECK_VISIT_BUDGET = 2_000_000;
const log = createLogger('Ifc5TreeScope');
interface SpatialTreeNode { expressId: number; name?: string; children: SpatialTreeNode[] }
interface RelationEdges {
  childrenByParent: Map<number, number[]>;
  parentsByChild: Map<number, number[]>;
  parentSetsByChild: Map<number, Set<number>>;
}
interface EffectiveTreeGraph {
  decomposition: RelationEdges;
  containment: RelationEdges;
  hasDecompositionRecords: boolean;
  hasContainmentRecords: boolean;
  decompositionModified: boolean;
  containmentModified: boolean;
}
/** All tree answers used by one IFC5 export. */
export interface Ifc5TreeScope {
  treeIds: Set<number>;
  parentOf: Map<number, number>;
  spatialNodeNames: Map<number, string>;
}

function newEdges(): RelationEdges {
  return { childrenByParent: new Map(), parentsByChild: new Map(), parentSetsByChild: new Map() };
}
function parsedSingleRef(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function parsedRefs(value: unknown): number[] {
  if (Array.isArray(value)) return value.flatMap(parsedRefs);
  const id = parsedSingleRef(value);
  return id === undefined ? [] : [id];
}

function authoredKnownRefs(value: unknown): number[] {
  const found: number[] = [];
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      if (seen.has(current)) continue;
      seen.add(current);
      for (let i = current.length - 1; i >= 0; i--) pending.push(current[i]);
      continue;
    }
    const numeric = parsedSingleRef(current);
    found.push(...(numeric === undefined
      ? authoredEntityRefs(current as Parameters<typeof authoredEntityRefs>[0])
      : [numeric]));
  }
  return found;
}

function refs(value: unknown, authored: boolean): number[] {
  return authored ? authoredKnownRefs(value) : parsedRefs(value);
}

function appendChild(edges: RelationEdges, parentId: number, childId: number): void {
  if (parentId === childId) return;
  const children = edges.childrenByParent.get(parentId) ?? [];
  children.push(childId); // duplicates are harmless to the visited-set closure
  edges.childrenByParent.set(parentId, children);
}

function appendCandidate(edges: RelationEdges, childId: number, parentId: number): void {
  if (parentId === childId) return;
  const seen = edges.parentSetsByChild.get(childId) ?? new Set<number>();
  if (seen.has(parentId)) return;
  seen.add(parentId);
  edges.parentSetsByChild.set(childId, seen);
  const parents = edges.parentsByChild.get(childId) ?? [];
  parents.push(parentId);
  edges.parentsByChild.set(childId, parents);
}

function addEdge(edges: RelationEdges, parentId: number, childId: number): void {
  appendChild(edges, parentId, childId);
  appendCandidate(edges, childId, parentId);
}

const existsOrWasDeleted = (effective: EffectiveEntityIndex, id: number): boolean =>
  effective.has(id) || effective.isDeleted(id);

function effectiveAttributes(
  id: number,
  sourceAttributes: unknown[] | undefined,
  created: NewEntity | undefined,
  view: MutablePropertyView | null,
): unknown[] | undefined {
  const attributes = created ? [...created.attributes] : sourceAttributes?.slice();
  if (!attributes || !view) return attributes;
  for (const [index, value] of view.getPositionalMutationsForEntity(id) ?? []) attributes[index] = value;
  const slots = new Map<string, number>([
    ['RelatingObject', 4], ['RelatedObjects', 5],
    ['RelatedElements', 4], ['RelatingStructure', 5],
  ]);
  for (const { name, value } of view.getAttributeMutationsForEntity(id)) {
    const index = slots.get(name);
    if (index !== undefined) attributes[index] = value;
  }
  return attributes;
}

function slotIsAuthored(
  id: number,
  index: number,
  name: string,
  created: NewEntity | undefined,
  view: MutablePropertyView | null,
): boolean {
  return created !== undefined
    || view?.getPositionalMutationsForEntity(id)?.has(index) === true
    || view?.getAttributeMutationsForEntity(id).some((change) => change.name === name) === true;
}

function addRawEdges(
  dataStore: IfcDataStore,
  graph: EffectiveTreeGraph,
  effective: EffectiveEntityIndex,
  view: MutablePropertyView | null,
): void {
  const relationships = dataStore.relationships;
  if (!relationships) return;
  const relations = new Map<number, { type: RelationshipType; parent: number; children: number[] }>();
  for (const row of flattenRelationshipEdges(relationships.forward)) {
    const relation = relations.get(row.relationshipId)
      ?? { type: row.type, parent: row.sourceId, children: [] };
    relation.children.push(row.targetId);
    relations.set(row.relationshipId, relation);
  }
  const declarationOrder = new Map<number, number>();
  for (const row of flattenRelationshipEdges(relationships.inverse)) {
    if (!declarationOrder.has(row.relationshipId)) declarationOrder.set(row.relationshipId, declarationOrder.size);
  }
  const created = new Map((view?.getNewEntities() ?? []).map((entity) => [entity.expressId, entity]));
  const orderedRelations = [...relations].sort(([left], [right]) =>
    (declarationOrder.get(left) ?? 0) - (declarationOrder.get(right) ?? 0));
  for (const [id, relation] of orderedRelations) {
    const rawDecomposition = relation.type === RelationshipType.Aggregates || relation.type === RelationshipType.Nests;
    const rawContainment = relation.type === RelationshipType.ContainsElements;
    // @raw-entity-enumeration-ok parsed graph edge provides a source-class fallback; effective.typeOf below applies live retypes
    const rawType = relation.type === RelationshipType.Nests ? 'IFCRELNESTS'
      : rawDecomposition ? 'IFCRELAGGREGATES' : rawContainment
        ? 'IFCRELCONTAINEDINSPATIALSTRUCTURE' : dataStore.entityIndex.byId.get(id)?.type ?? '';
    const effectiveType = effective.typeOf(id);
    const type = effectiveType ?? rawType;
    const isDecomposition = type === 'IFCRELAGGREGATES' || type === 'IFCRELNESTS';
    const isContainment = type === 'IFCRELCONTAINEDINSPATIALSTRUCTURE';
    if (!rawDecomposition && !rawContainment && !isDecomposition && !isContainment) continue;
    const typeChanged = effectiveType !== undefined && effectiveType !== rawType;
    const parentIndex = isDecomposition ? 4 : 5;
    const childrenIndex = isDecomposition ? 5 : 4;
    const endpointsAuthored = slotIsAuthored(
      id, parentIndex, isDecomposition ? 'RelatingObject' : 'RelatingStructure', undefined, view,
    ) || slotIsAuthored(
      id, childrenIndex, isDecomposition ? 'RelatedObjects' : 'RelatedElements', undefined, view,
    );
    const modified = effective.isDeleted(id) || typeChanged || endpointsAuthored;
    if (rawDecomposition && modified) graph.decompositionModified = true;
    if (rawContainment && modified) graph.containmentModified = true;
    if (isDecomposition && (typeChanged || endpointsAuthored)) graph.decompositionModified = true;
    if (isContainment && (typeChanged || endpointsAuthored)) graph.containmentModified = true;
    if (effective.isDeleted(id)) continue;
    if (!isDecomposition && !isContainment) continue;
    const source = rawDecomposition && isDecomposition
      ? [null, null, null, null, relation.parent, relation.children]
      : rawContainment && isContainment
        ? [null, null, null, null, relation.children, relation.parent]
        : new Array<unknown>(6).fill(null);
    const attributes = effectiveAttributes(id, source, undefined, view) as unknown[];
    const parentId = refs(attributes[isDecomposition ? 4 : 5], modified)[0];
    const edges = isDecomposition ? graph.decomposition : graph.containment;
    if (parentId === undefined || !existsOrWasDeleted(effective, parentId)) continue;
    for (const childId of refs(attributes[isDecomposition ? 5 : 4], modified)) {
      if (existsOrWasDeleted(effective, childId)) addEdge(edges, parentId, childId);
    }
  }
  for (const entity of created.values()) {
    const type = effective.typeOf(entity.expressId);
    const decomposition = type === 'IFCRELAGGREGATES' || type === 'IFCRELNESTS';
    const containment = type === 'IFCRELCONTAINEDINSPATIALSTRUCTURE';
    if (!decomposition && !containment) continue;
    if (decomposition) graph.decompositionModified = true;
    else graph.containmentModified = true;
    const attributes = effectiveAttributes(entity.expressId, undefined, entity, view) as unknown[];
    const parentId = refs(attributes[decomposition ? 4 : 5], true)[0];
    if (parentId === undefined || !existsOrWasDeleted(effective, parentId)) continue;
    const edges = decomposition ? graph.decomposition : graph.containment;
    for (const childId of refs(attributes[decomposition ? 5 : 4], true)) {
      if (existsOrWasDeleted(effective, childId)) addEdge(edges, parentId, childId);
    }
  }
}
function buildEffectiveTreeGraph(
  dataStore: IfcDataStore,
  effective: EffectiveEntityIndex,
  view: MutablePropertyView | null,
): EffectiveTreeGraph {
  // @raw-entity-enumeration-ok source relationship presence stays authoritative even after tombstones, preventing stale-tree fallback
  const sourceTypes = dataStore.entityIndex.byType;
  const graph: EffectiveTreeGraph = {
    decomposition: newEdges(), containment: newEdges(),
    // Source records still establish authority after an overlay tombstones
    // every one of them; otherwise an empty effective graph would resurrect
    // their stale parsed hierarchy through the synthetic-store fallback.
    hasDecompositionRecords:
      (sourceTypes.get('IFCRELAGGREGATES')?.length ?? 0) > 0
      || (sourceTypes.get('IFCRELNESTS')?.length ?? 0) > 0,
    hasContainmentRecords:
      (sourceTypes.get('IFCRELCONTAINEDINSPATIALSTRUCTURE')?.length ?? 0) > 0,
    decompositionModified: false,
    containmentModified: false,
  };
  // Server/synthetic stores retain a truthy zero-byte source object. In that
  // state the parsed RelationshipGraph is the only relationship authority.
  if (dataStore.source.byteLength === 0) {
    addRawEdges(dataStore, graph, effective, view);
    return graph;
  }

  const extractor = new EntityExtractor(dataStore.source);
  const created = new Map<number, NewEntity>();
  for (const entity of view?.getNewEntities() ?? []) created.set(entity.expressId, entity);

  // Effective iteration preserves declaration order and appends creations.
  for (const [id, record] of effective) {
    const type = effective.effectiveType(id, record.type);
    const decomposition = type === 'IFCRELAGGREGATES' || type === 'IFCRELNESTS';
    const containment = type === 'IFCRELCONTAINEDINSPATIALSTRUCTURE';
    if (!decomposition && !containment) continue;
    if (decomposition) graph.hasDecompositionRecords = true;
    if (containment) graph.hasContainmentRecords = true;
    const createdEntity = created.get(id);
    // @raw-entity-enumeration-ok effective iteration chose this surviving id; source bytes supply its pre-edit attributes
    const sourceRef = createdEntity ? undefined : dataStore.entityIndex.byId.get(id);
    const sourceEntity = sourceRef ? extractor.extractEntity(sourceRef) : null;
    const attributes = effectiveAttributes(id, sourceEntity?.attributes, createdEntity, view);
    if (!attributes) continue;
    const parentIndex = decomposition ? 4 : 5;
    const childrenIndex = decomposition ? 5 : 4;
    const parentName = decomposition ? 'RelatingObject' : 'RelatingStructure';
    const childrenName = decomposition ? 'RelatedObjects' : 'RelatedElements';
    const parentId = refs(
      attributes[parentIndex],
      slotIsAuthored(id, parentIndex, parentName, createdEntity, view),
    )[0];
    if (parentId === undefined || !existsOrWasDeleted(effective, parentId)) continue;
    const edges = decomposition ? graph.decomposition : graph.containment;
    for (const childId of refs(
      attributes[childrenIndex],
      slotIsAuthored(id, childrenIndex, childrenName, createdEntity, view),
    )) {
      if (existsOrWasDeleted(effective, childId)) addEdge(edges, parentId, childId);
    }
  }
  return graph;
}

function seedProjectAndNames(dataStore: IfcDataStore, treeIds: Set<number>, names: Map<number, string>): boolean {
  const project = dataStore.spatialHierarchy?.project;
  if (!project) return false;
  treeIds.add(project.expressId);
  const stack: SpatialTreeNode[] = [project];
  while (stack.length > 0) {
    const node = stack.pop() as SpatialTreeNode;
    if (node.name) names.set(node.expressId, node.name);
    stack.push(...node.children);
  }
  return true;
}

function seedSourcelessSpatialFallback(
  dataStore: IfcDataStore,
  treeIds: Set<number>,
  parentOf: Map<number, number>,
  names: Map<number, string>,
  includeDecomposition: boolean,
  includeContainment: boolean,
): boolean {
  const hierarchy = dataStore.spatialHierarchy;
  if (hierarchy?.project) {
    const stack: SpatialTreeNode[] = [hierarchy.project];
    while (stack.length > 0) {
      const node = stack.pop() as SpatialTreeNode;
      if (includeDecomposition || node === hierarchy.project) treeIds.add(node.expressId);
      if (node.name) names.set(node.expressId, node.name);
      for (const child of node.children) {
        if (includeDecomposition) parentOf.set(child.expressId, node.expressId);
        stack.push(child);
      }
    }
  }
  if (hierarchy && includeContainment) {
    for (const map of [hierarchy.bySite, hierarchy.byBuilding, hierarchy.byStorey, hierarchy.bySpace]) {
      for (const [parentId, children] of map ?? []) {
        for (const childId of children ?? []) { treeIds.add(childId); parentOf.set(childId, parentId); }
      }
    }
  }
  return hierarchy?.project !== undefined;
}

function closeTree(treeIds: Set<number>, graph: EffectiveTreeGraph): void {
  const pending = [...treeIds];
  while (pending.length > 0) {
    const id = pending.pop() as number;
    const children = [
      ...(graph.decomposition.childrenByParent.get(id) ?? []),
      ...(graph.containment.childrenByParent.get(id) ?? []),
    ];
    for (const childId of children) {
      if (treeIds.has(childId)) continue;
      treeIds.add(childId);
      pending.push(childId);
    }
  }
}

function descendants(childId: number, edges: RelationEdges, budget: { visits: number }): Set<number> | null {
  const visited = new Set<number>([childId]);
  const pending = [childId];
  while (pending.length > 0) {
    for (const kid of edges.childrenByParent.get(pending.pop() as number) ?? []) {
      if (--budget.visits < 0) return null;
      if (!visited.has(kid)) { visited.add(kid); pending.push(kid); }
    }
  }
  return visited;
}

function addParents(graph: EffectiveTreeGraph, treeIds: Set<number>, parentOf: Map<number, number>): void {
  // Containment remains authoritative where a file declares both mechanisms.
  for (const [childId, parents] of graph.containment.parentsByChild) {
    // A zero-byte/synthetic store has no record stream from which to rebuild
    // effective relations; its pre-digested spatial hierarchy is canonical.
    if (parentOf.has(childId)) continue;
    const winner = parents.find((parent) => treeIds.has(parent)) ?? parents[0];
    if (winner !== undefined) parentOf.set(childId, winner);
  }
  const budget = { visits: CYCLE_CHECK_VISIT_BUDGET };
  let exhausted = false;
  for (const [childId, candidates] of graph.decomposition.parentsByChild) {
    if (parentOf.has(childId) || candidates.length === 0) continue;
    let usable = candidates;
    if (candidates.length > 1 && !exhausted) {
      const below = descendants(childId, graph.decomposition, budget);
      if (below === null) {
        exhausted = true;
        log.warn(`Aggregation cycle checks stopped after ${CYCLE_CHECK_VISIT_BUDGET} graph visits`);
      } else {
        const nonCyclic = candidates.filter((candidate) => !below.has(candidate));
        if (nonCyclic.length > 0) usable = nonCyclic;
      }
    }
    parentOf.set(childId, usable.find((parent) => treeIds.has(parent)) ?? usable[0]);
  }
}

/** Build membership and hierarchy from the same effective relationship graph. */
export function buildIfc5TreeScope(
  dataStore: IfcDataStore,
  effective: EffectiveEntityIndex,
  view: MutablePropertyView | null,
): Ifc5TreeScope {
  const treeIds = new Set<number>();
  const parentOf = new Map<number, number>();
  const spatialNodeNames = new Map<number, string>();
  const graph = buildEffectiveTreeGraph(dataStore, effective, view);
  const sourceless = dataStore.source.byteLength === 0;
  const useRawDecomposition = sourceless
    ? !graph.decompositionModified
    : !graph.hasDecompositionRecords;
  const useRawContainment = sourceless
    ? !graph.containmentModified
    : !graph.hasContainmentRecords;
  const hasProject = useRawDecomposition || useRawContainment
    ? seedSourcelessSpatialFallback(
      dataStore, treeIds, parentOf, spatialNodeNames, useRawDecomposition, useRawContainment,
    )
    : seedProjectAndNames(dataStore, treeIds, spatialNodeNames);
  // Preserve the old malformed/no-project fallback: contained occurrences are
  // still exported at the document root rather than filtering everything.
  if (!hasProject) for (const childId of graph.containment.parentsByChild.keys()) treeIds.add(childId);
  closeTree(treeIds, graph);
  addParents(graph, treeIds, parentOf);
  return { treeIds, parentOf, spatialNodeNames };
}
