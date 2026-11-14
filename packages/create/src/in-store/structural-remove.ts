/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { iterateEffectiveEntityIds, type StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { structuralGraph, structuralReader } from './_structural-graph.js';

/** Remove a structural root and exclusively owned resources. Required direct
 * dependents refuse the entire operation; relationships detach or shrink.
 * Shared resources and all descendants reachable from a survivor stay live.
 * A shape aspect is removed with its product shape and kept while the shape is kept. */
export function removeStructuralEntityInStore(store: IfcDataStore, editor: StoreEditor, expressId: number): void {
  if (store.source.byteLength === 0) {
    for (const { expressId: id } of iterateEffectiveEntityIds(store, editor.getMutationView())) {
      if (!editor.getNewEntity(id)) {
        throw new Error(`removeStructuralEntity: cannot remove #${expressId} from a source-less model; raw entity records are required to inspect ownership`);
      }
    }
  }
  // Lazy single-record check before the full-store graph is built.
  const reader = structuralReader(store, editor);
  // Required by IfcRelConnectsWithEccentricity and optional on non-structural
  // connections, so it is removed only with the relationship that owns it.
  if (reader.meta(reader.requireStructural(expressId).type)?.name === 'IfcConnectionPointEccentricity') {
    throw new Error(`removeStructuralEntity: #${expressId} is an IfcConnectionPointEccentricity; remove the relationship that owns it`);
  }
  const graph = structuralGraph(store, editor, reader);
  // Schema inheritance covers derived links and uppercase source type names.
  const isA = (type: string, base: string) => graph.meta(type)?.inheritanceChain?.includes(base) ?? false;
  const removed = new Set([expressId]);
  const writes: { id: number; index: number; value: string[] | null }[] = [];
  const blockers: string[] = [];
  for (const [id, record] of graph.records) {
    if (id === expressId) continue;
    for (const edge of graph.edges(id).filter(e => e.target === expressId)) {
      const { attribute, index } = edge;
      const aggregate = attribute.isArray || attribute.isList || attribute.isSet;
      if (record.type.toUpperCase().startsWith('IFCREL') && /^(Relating|Related)/.test(attribute.name)) {
        const remaining = graph.refs(record.attributes[index]).filter(t => t !== expressId);
        if (aggregate && remaining.length) writes.push({ id, index, value: remaining.map(t => `#${t}`) });
        else removed.add(id);
      } else if (attribute.optional && attribute.name !== 'ResultForLoadGroup') {
        const remaining = graph.refs(record.attributes[index]).filter(t => t !== expressId);
        writes.push({ id, index, value: aggregate && remaining.length ? remaining.map(t => `#${t}`) : null });
      } else blockers.push(`${record.type} #${id}.${attribute.name}`);
    }
  }
  // These inverse lower bounds are not present in registry.allAttributes.
  // IFC2X3 activities have one required assignment; connections in every
  // schema need at least one member. Refuse rather than cascade products.
  for (const id of removed) {
    const record = graph.records.get(id)!;
    const memberRel = isA(record.type, 'IfcRelConnectsStructuralMember');
    const activityRel = graph.schema === 'IFC2X3' && isA(record.type, 'IfcRelConnectsStructuralActivity');
    const groupRel = graph.schema === 'IFC2X3' && isA(record.type, 'IfcRelAssignsToGroup');
    if (!memberRel && !activityRel && !groupRel) continue;
    const endpointName = memberRel ? 'RelatedStructuralConnection' : groupRel ? 'RelatingGroup' : 'RelatedStructuralActivity';
    const endpoint = graph.edges(id).find(e => e.attribute.name === endpointName)?.target;
    if (endpoint === undefined || removed.has(endpoint)) continue;
    const family = memberRel ? 'IfcRelConnectsStructuralMember' : groupRel ? 'IfcRelAssignsToGroup' : 'IfcRelConnectsStructuralActivity';
    const alternative = [...graph.records].some(([other, candidate]) => !removed.has(other)
      && isA(candidate.type, family)
      && graph.edges(other).some(e => e.attribute.name === endpointName && e.target === endpoint));
    if (!alternative) {
      const type = graph.meta(graph.records.get(endpoint)?.type ?? '')?.name ?? 'entity';
      blockers.push(`${type} #${endpoint}.${memberRel ? 'ConnectsStructuralMembers' : groupRel ? 'IsGroupedBy' : 'AssignedToStructuralItem'}`);
    }
  }
  if (blockers.length) throw new Error(`removeStructuralEntity: #${expressId} has dependents: ${blockers.join(', ')}`);
  // A shape aspect belongs to the product shape it describes (the inverse
  // HasShapeAspects), so it joins the closure when that shape does.
  const aspectsOf = new Map<number, number[]>();
  for (const [id, record] of graph.records) {
    if (graph.meta(record.type)?.name !== 'IfcShapeAspect') continue;
    for (const { target, attribute } of graph.edges(id)) {
      if (attribute.name !== 'PartOfProductDefinitionShape') continue;
      const list = aspectsOf.get(target);
      if (list) list.push(id); else aspectsOf.set(target, [id]);
    }
  }
  function* followers(id: number, owned = false) {
    for (const { target } of graph.edges(id, owned)) yield target;
    yield* aspectsOf.get(id) ?? [];
  }
  // Iterative closure, bounded by the number of live entities even for cyclic
  // or branching file-supplied references. Never follow PlacementRelTo.
  const candidates = new Set(removed);
  const pending = [...removed];
  while (pending.length) {
    for (const target of followers(pending.pop()!, true)) {
      if (!candidates.has(target)) { candidates.add(target); pending.push(target); }
    }
  }
  const kept = new Set<number>();
  for (const [id] of graph.records) {
    if (candidates.has(id)) continue;
    for (const target of followers(id)) {
      if (candidates.has(target) && !removed.has(target)) kept.add(target);
    }
  }
  const survivors = [...kept];
  while (survivors.length) {
    for (const target of followers(survivors.pop()!)) {
      if (candidates.has(target) && !kept.has(target)) { kept.add(target); survivors.push(target); }
    }
  }
  editor.runAtomic(draft => {
    for (const { id, index, value } of writes) if (!removed.has(id)) draft.setPositionalAttribute(id, index, value);
    for (const id of candidates) if (!kept.has(id)) draft.removeEntity(id);
  });
}
