/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { generateIfcGuid } from '@ifc-lite/encoding';
import { StoreEditor, type MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { conformsTo, schemaRegistry } from './schema-attributes.js';
import { GroupGraph, GROUP_GRAPH_LIMITS, referenceId, type GroupRootIdentity, type GroupSnapshot } from './group-graph.js';

export interface GroupStoreContext {
  store: IfcDataStore;
  mutationView: MutablePropertyView;
  ownerHistoryId: number | null;
  /** A reviewed draft may replay its native allocations at commit; ownership checks still apply. */
  guidSource?: () => string;
}
export interface GroupInStoreParams {
  Name: string;
  Description?: string | null;
  ObjectType?: string | null;
  GlobalId?: string;
  RelatedObjects: readonly GroupRootIdentity[];
}
export interface GroupInStorePatch {
  Name?: string | null;
  Description?: string | null;
  ObjectType?: string | null;
  /** Entire intended membership, never an implicit append or subtraction. */
  RelatedObjects: readonly GroupRootIdentity[];
}
export type { GroupRootIdentity, GroupSnapshot, GroupMembershipSnapshot } from './group-graph.js';

function text(value: unknown, name: string): void {
  if (value !== undefined && value !== null && (typeof value !== 'string' || value.length > 16_384)) {
    throw new Error(`IfcGroup.${name} must be text or null within the text budget`);
  }
}

function members(graph: GroupGraph, values: readonly GroupRootIdentity[], groupId?: number): number[] {
  if (!Array.isArray(values) || values.length > GROUP_GRAPH_LIMITS.members) throw new Error('Group membership budget exceeded or list missing');
  const registry = schemaRegistry(graph.store.schemaVersion as 'IFC4' | 'IFC4X3', 'IfcGroup');
  const ids = values.map(value => {
    if (!value || !Number.isSafeInteger(value.expressId) || typeof value.GlobalId !== 'string') throw new Error('Group member identity is missing');
    const root = graph.root(value.expressId, value.GlobalId);
    if (!conformsTo(registry, graph.entities.get(root.expressId)!.type, 'IfcObjectDefinition', graph.schemaNames)) {
      throw new Error('Group membership requires an IfcObjectDefinition');
    }
    if (root.expressId === groupId) throw new Error('IfcGroup cannot assign itself');
    return root.expressId;
  });
  if (new Set(ids).size !== ids.length) throw new Error('Group membership contains duplicate identities');
  return ids;
}

function newGuid(graph: GroupGraph, reserved: ReadonlySet<string> = new Set(), source: () => string = generateIfcGuid): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    const guid = source();
    if (reserved.has(guid)) continue;
    try { graph.availableGuid(guid); return guid; }
    catch (error) { if (attempt === 99) throw error; }
  }
  throw new Error('Cannot allocate an unowned Group GlobalId');
}

function owner(graph: GroupGraph, id: number | null): string | null {
  if (id === null) return null;
  if (graph.entities.get(id)?.type.toUpperCase() !== 'IFCOWNERHISTORY') throw new Error('Group OwnerHistory is not live in this source');
  return `#${id}`;
}

function unchanged(graph: GroupGraph, expected: GroupSnapshot): GroupSnapshot {
  const current = graph.snapshot(expected);
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('Group expected current identity, metadata or membership changed');
  return current;
}

function protectRelationships(graph: GroupGraph, removed: ReadonlySet<number>): void {
  for (const id of removed) {
    for (const referrer of graph.incoming.get(id) ?? []) {
      if (!removed.has(referrer)) throw new Error(`Group relationship #${id} has protected incoming reference #${referrer}`);
    }
  }
}

function atomicGroupEdit<T>(context: GroupStoreContext, edit: (editor: StoreEditor) => T): T {
  // The constructor seeds the allocator; even that initialization belongs to the detached transaction.
  return context.mutationView.runAtomic(view => edit(new StoreEditor(context.store, view)));
}

/** Complete current, source-bound readback used by SDK and reviewed authoring. */
export function readGroupInStore(context: GroupStoreContext, target: GroupRootIdentity): GroupSnapshot {
  return new GroupGraph(context.store, context.mutationView).snapshot(target);
}

/** Group and optional nonempty relationship are published in one native atomic edit. */
export function addGroupToStore(context: GroupStoreContext, params: GroupInStoreParams): GroupRootIdentity {
  return atomicGroupEdit(context, editor => {
    const graph = new GroupGraph(context.store, editor.getMutationView());
    text(params.Name, 'Name'); text(params.Description, 'Description'); text(params.ObjectType, 'ObjectType');
    if (typeof params.Name !== 'string' || !params.Name.length) throw new Error('Group Name is required');
    const ids = members(graph, params.RelatedObjects);
    const GlobalId = params.GlobalId ?? newGuid(graph, undefined, context.guidSource); graph.availableGuid(GlobalId);
    const history = owner(graph, context.ownerHistoryId);
    const relationGuid = ids.length ? newGuid(graph, new Set([GlobalId]), context.guidSource) : undefined;
    const expressId = editor.addEntity('IfcGroup', [GlobalId, history, params.Name, params.Description ?? null, params.ObjectType ?? null]).expressId;
    if (relationGuid) editor.addEntity('IfcRelAssignsToGroup', [relationGuid, history, null, null, ids.map(id => `#${id}`), null, `#${expressId}`]);
    return { expressId, GlobalId };
  });
}

/** Preserve group identity and reuse its first exact relationship; empty membership removes all own relations. */
export function updateGroupInStore(context: GroupStoreContext, expected: GroupSnapshot, patch: GroupInStorePatch): GroupRootIdentity {
  return atomicGroupEdit(context, editor => {
    const graph = new GroupGraph(context.store, editor.getMutationView());
    const current = unchanged(graph, expected);
    text(patch.Name, 'Name'); text(patch.Description, 'Description'); text(patch.ObjectType, 'ObjectType');
    const ids = members(graph, patch.RelatedObjects, current.expressId);
    const keep = ids.length ? current.memberships[0]?.relationship.expressId : undefined;
    const removed = new Set(current.memberships.map(row => row.relationship.expressId).filter(id => id !== keep));
    protectRelationships(graph, removed);
    const history = owner(graph, context.ownerHistoryId);
    const relationGuid = ids.length && keep === undefined ? newGuid(graph, undefined, context.guidSource) : undefined;
    for (const [name, index] of [['Name', 2], ['Description', 3], ['ObjectType', 4]] as const) {
      if (patch[name] !== undefined) editor.setPositionalAttribute(current.expressId, index, patch[name]);
    }
    for (const id of removed) editor.removeEntity(id);
    if (keep !== undefined) editor.setPositionalAttribute(keep, 4, ids.map(id => `#${id}`));
    else if (relationGuid) editor.addEntity('IfcRelAssignsToGroup', [relationGuid, history, null, null, ids.map(id => `#${id}`), null, `#${current.expressId}`]);
    return { expressId: current.expressId, GlobalId: current.GlobalId };
  });
}

/** Delete only the group and membership edges; retain members and other group memberships. */
export function removeGroupInStore(context: GroupStoreContext, expected: GroupSnapshot): void {
  atomicGroupEdit(context, editor => {
    const graph = new GroupGraph(context.store, editor.getMutationView());
    const current = unchanged(graph, expected);
    const removed = new Set(current.memberships.map(row => row.relationship.expressId));
    const rewritten = new Map<number, number[]>();
    for (const id of graph.incoming.get(current.expressId) ?? []) {
      if (removed.has(id)) continue;
      const entity = graph.entities.get(id)!;
      if (entity.type.toUpperCase() !== 'IFCRELASSIGNSTOGROUP') throw new Error(`IfcGroup has protected incoming dependency #${id}`);
      const relating = referenceId(entity.attributes[6]);
      if (relating === null) throw new Error('Incoming group membership has an unreadable owner');
      graph.root(relating);
      if (!conformsTo(schemaRegistry(graph.store.schemaVersion as 'IFC4' | 'IFC4X3', 'IfcGroup'), graph.entities.get(relating)!.type, 'IfcGroup', graph.schemaNames)) throw new Error('Incoming membership owner is not an IfcGroup');
      graph.root(id);
      const raw = entity.attributes[4];
      if (!Array.isArray(raw) || raw.length > GROUP_GRAPH_LIMITS.members) throw new Error('Incoming group membership is incomplete');
      const ids = raw.map(value => referenceId(value));
      if (ids.some(value => value === null) || new Set(ids).size !== ids.length || !ids.includes(current.expressId)) throw new Error('Incoming group membership is unreadable');
      ids.forEach(value => {
        const member = graph.root(value!);
        if (!conformsTo(schemaRegistry(graph.store.schemaVersion as 'IFC4' | 'IFC4X3', 'IfcGroup'), graph.entities.get(member.expressId)!.type, 'IfcObjectDefinition', graph.schemaNames)) {
          throw new Error('Incoming group membership has an invalid object definition');
        }
      });
      const remaining = ids.filter((value): value is number => value !== null && value !== current.expressId);
      if (remaining.length) rewritten.set(id, remaining); else removed.add(id);
    }
    protectRelationships(graph, removed);
    for (const [id, ids] of rewritten) editor.setPositionalAttribute(id, 4, ids.map(member => `#${member}`));
    for (const id of removed) editor.removeEntity(id);
    editor.removeEntity(current.expressId);
  });
}
