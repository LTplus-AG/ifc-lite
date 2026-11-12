/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { structuralGraph } from './_structural-graph.js';

/** Remove a structural root and exclusively owned resources. Required direct
 * dependents refuse the entire operation; relationships detach or shrink.
 * Shared resources and all descendants reachable from a survivor stay live. */
export function removeStructuralEntityInStore(store: IfcDataStore, editor: StoreEditor, expressId: number): void {
  const graph = structuralGraph(store, editor);
  graph.requireStructural(expressId);
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
    const memberRel = record.type === 'IfcRelConnectsStructuralMember';
    const activityRel = graph.schema === 'IFC2X3' && record.type === 'IfcRelConnectsStructuralActivity';
    const groupRel = graph.schema === 'IFC2X3' && record.type === 'IfcRelAssignsToGroup';
    if (!memberRel && !activityRel && !groupRel) continue;
    const endpointName = memberRel ? 'RelatedStructuralConnection' : groupRel ? 'RelatingGroup' : 'RelatedStructuralActivity';
    const endpoint = graph.edges(id).find(e => e.attribute.name === endpointName)?.target;
    if (endpoint === undefined || removed.has(endpoint)) continue;
    const alternative = [...graph.records].some(([other, candidate]) => !removed.has(other)
      && candidate.type === record.type
      && graph.edges(other).some(e => e.attribute.name === endpointName && e.target === endpoint));
    if (!alternative) blockers.push(`${graph.records.get(endpoint)?.type} #${endpoint}.${memberRel ? 'ConnectsStructuralMembers' : groupRel ? 'IsGroupedBy' : 'AssignedToStructuralItem'}`);
  }
  if (blockers.length) throw new Error(`removeStructuralEntity: #${expressId} has dependents: ${blockers.join(', ')}`);
  // Iterative closure, bounded by the number of live entities even for cyclic
  // or branching file-supplied references. Never follow PlacementRelTo.
  const candidates = new Set(removed);
  const pending = [...removed];
  while (pending.length) {
    for (const { target } of graph.edges(pending.pop()!, true)) {
      if (!candidates.has(target)) { candidates.add(target); pending.push(target); }
    }
  }
  const kept = new Set<number>();
  for (const [id] of graph.records) {
    if (candidates.has(id)) continue;
    for (const { target } of graph.edges(id)) {
      if (candidates.has(target) && !removed.has(target)) kept.add(target);
    }
  }
  const survivors = [...kept];
  while (survivors.length) {
    for (const { target } of graph.edges(survivors.pop()!)) {
      if (candidates.has(target) && !kept.has(target)) { kept.add(target); survivors.push(target); }
    }
  }
  editor.runAtomic(draft => {
    for (const { id, index, value } of writes) if (!removed.has(id)) draft.setPositionalAttribute(id, index, value);
    for (const id of candidates) if (!kept.has(id)) draft.removeEntity(id);
  });
}
