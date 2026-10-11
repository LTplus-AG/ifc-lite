/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { conformsTo, schemaRegistry } from './schema-attributes.js';
import { GroupGraph, type GroupRootIdentity, type GroupSnapshot } from './group-graph.js';
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

/** Review facts come from the lifecycle owner's same bounded current graph. */
export function readGroupEvidenceInStore(context: GroupStoreContext, selected: readonly number[]): GroupNativeEvidence {
  const contentKey = context.store.source.contentKey;
  if (!contentKey || !context.store.source.byteLength) throw new Error('Group evidence requires its current native source content identity');
  if (!Array.isArray(selected) || !selected.length || selected.length > 100 || new Set(selected).size !== selected.length
    || selected.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('Group evidence requires 1–100 distinct captured native identities');
  const graph = new GroupGraph(context.store, context.mutationView);
  const registry = schemaRegistry(context.store.schemaVersion as 'IFC4' | 'IFC4X3', 'IfcGroup');
  const members: GroupRootIdentity[] = [], groups: GroupSnapshot[] = [];
  const roots = new Set<number>();
  for (const id of selected) {
    const identity = graph.root(id), row = graph.entities.get(id)!;
    if (!conformsTo(registry, row.type, 'IfcObjectDefinition')) throw new Error('Captured group member is not an IfcObjectDefinition');
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
