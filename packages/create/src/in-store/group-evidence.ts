/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { isValidIfcGuid } from '@ifc-lite/encoding';
import { conformsTo, schemaRegistry } from './schema-attributes.js';
import { iterateEffectiveEntityIds } from '@ifc-lite/mutations';
import { createSchemaEntityNameSnapshot } from '@ifc-lite/parser';
import { AnchorEntityReader } from './resolve-anchor.js';
import { assertGroupEntityBudget, GROUP_GRAPH_LIMITS, GroupGraph, referenceId, type GroupRootIdentity, type GroupSnapshot } from './group-graph.js';
import type { GroupStoreContext } from './group.js';

export interface GroupNativeEvidence {
  source: { contentKey: string; byteLength: number };
  selected: number[];
  members: GroupRootIdentity[];
  groups: GroupSnapshot[];
  /** Current records for selected roots, their owned assignments and immediate incoming dependencies. */
  records: Array<{ expressId: number; type: string; attributes: unknown[] }>;
  incoming: Array<{ target: number; referrers: number[] }>;
}

function selectionSource(context: GroupStoreContext, selected: readonly number[]) {
  const contentKey = context.store.source.contentKey;
  if (!contentKey || !context.store.source.byteLength) throw new Error('Group evidence requires its current native source content identity');
  if (!Array.isArray(selected) || !selected.length || selected.length > 100 || new Set(selected).size !== selected.length
    || selected.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('Group evidence requires 1–100 distinct captured native identities');
  return { contentKey, source: context.store.source.byteLength };
}

/** Review facts come from the lifecycle owner's same bounded current graph. */
export function readGroupEvidenceInStore(context: GroupStoreContext, selected: readonly number[]): GroupNativeEvidence {
  const { contentKey } = selectionSource(context, selected);
  const graph = new GroupGraph(context.store, context.mutationView);
  const registry = schemaRegistry(context.store.schemaVersion as 'IFC4' | 'IFC4X3', 'IfcGroup');
  const members: GroupRootIdentity[] = [], groups: GroupSnapshot[] = [];
  const roots = new Set<number>();
  for (const id of selected) {
    const identity = graph.root(id), row = graph.entities.get(id)!;
    if (!conformsTo(registry, row.type, 'IfcObjectDefinition', graph.schemaNames)) throw new Error('Captured group member is not an IfcObjectDefinition');
    members.push(identity); roots.add(id);
    if (row.type.toUpperCase() === 'IFCGROUP') {
      const snapshot = graph.snapshot(identity); groups.push(snapshot);
      for (const membership of snapshot.memberships) {
        roots.add(membership.relationship.expressId);
        for (const member of membership.RelatedObjects) roots.add(member.expressId);
      }
    }
  }
  const incoming = [...roots].sort((a, b) => a - b).map(target => ({ target, referrers: [...graph.incoming.get(target) ?? []].sort((a, b) => a - b) }));
  const ids = new Set([...roots, ...incoming.flatMap(row => row.referrers)]);
  if (ids.size > 200) throw new Error('Complete Group records and incoming dependencies exceed the review budget');
  const records = [...ids].sort((a, b) => a - b).map(expressId => {
    const record = graph.entities.get(expressId);
    if (!record) throw new Error('Group evidence has an unavailable dependency');
    return { expressId, type: record.type, attributes: structuredClone(record.attributes) as unknown[] };
  });
  if (JSON.stringify(records).length > 80_000) throw new Error('Complete Group record evidence exceeds the transport budget');
  return { source: { contentKey, byteLength: context.store.source.byteLength }, selected: [...selected], members, groups, records, incoming };
}

/**
 * Bounded facts for a selection that touches no exact generic IfcGroup (#7346):
 * no selected root is an IfcGroup, and no current IfcRelAssignsToGroup naming
 * an exact IfcGroup relates or is any selected root. Such a selection can only
 * start a new group, so the review owner reads the complete graph itself.
 * GlobalId uniqueness is not established here; review re-checks it.
 */
export interface GroupCreateEvidence {
  scope: 'no-group-context';
  source: { contentKey: string; byteLength: number };
  selected: number[];
  members: GroupRootIdentity[];
}

/**
 * Index-seeded alternative to the whole-model graph: decodes only the selected
 * roots and every IfcRelAssignsToGroup (so its cost scales with the model's
 * group-assignment count). Throws over the graph's entity budget, which review
 * could never read. Returns null when the selection touches an exact generic
 * IfcGroup, or when a decoded assignment is unreadable, so the complete owner
 * gives the answer or its own refusal.
 */
export function readGroupCreateEvidenceInStore(context: GroupStoreContext, selected: readonly number[],
  entityLimit: number = GROUP_GRAPH_LIMITS.entities): GroupCreateEvidence | null {
  const { contentKey, source } = selectionSource(context, selected);
  if (context.store.schemaVersion !== 'IFC4' && context.store.schemaVersion !== 'IFC4X3') return null;
  // Review must read the complete graph, so a model over its budget is refused here, not after a round trip.
  assertGroupEntityBudget(context.store, context.mutationView, entityLimit);
  const registry = schemaRegistry(context.store.schemaVersion, 'IfcGroup'), names = createSchemaEntityNameSnapshot(registry);
  const reader = new AnchorEntityReader(context.store, context.mutationView, names);
  const wanted = new Set(selected), members: GroupRootIdentity[] = [];
  for (const id of selected) {
    const row = reader.entity(id);
    if (!row || row.type.toUpperCase() === 'IFCGROUP') return null;
    if (!conformsTo(registry, row.type, 'IfcObjectDefinition', names)) throw new Error('Captured group member is not an IfcObjectDefinition');
    const GlobalId = row.names[0] === 'GlobalId' ? row.attributes[0] : undefined;
    if (typeof GlobalId !== 'string' || !isValidIfcGuid(GlobalId)) throw new Error(`Group graph #${id} is not a live valid IfcRoot`);
    members.push({ expressId: id, GlobalId });
  }
  const generic = new Map<number, boolean>();
  // Registry keys are canonical, so their own chains name every assignment subtype.
  const assignments = Object.entries(registry.entities).filter(([, row]) => row.inheritanceChain?.includes('IfcRelAssignsToGroup')).map(([name]) => name);
  for (const { expressId } of iterateEffectiveEntityIds(context.store, context.mutationView, assignments)) {
    const row = reader.entity(expressId);
    const relating = row ? referenceId(row.attributes[row.names.indexOf('RelatingGroup')]) : null;
    const related = row?.attributes[row.names.indexOf('RelatedObjects')];
    if (relating === null || !Array.isArray(related)) return null;
    if (!generic.has(relating)) {
      const group = reader.entity(relating);
      if (!group) return null;
      generic.set(relating, group.type.toUpperCase() === 'IFCGROUP');
    }
    if (!generic.get(relating)) continue;
    if (wanted.has(expressId)) return null;
    for (const value of related) {
      const id = referenceId(value);
      if (id === null || wanted.has(id)) return null;
    }
  }
  return { scope: 'no-group-context', source: { contentKey, byteLength: source }, selected: [...selected], members };
}
