/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { isValidIfcGuid } from '@ifc-lite/encoding';
import { effectiveCreatedRecord, effectiveSourceRecord } from '@ifc-lite/export';
import { iterateEffectiveEntityIds, type MutablePropertyView } from '@ifc-lite/mutations';
import { createSchemaEntityNameSnapshot, type SchemaEntityNameSnapshot, type EffectiveEntityRecord, type IfcDataStore } from '@ifc-lite/parser';
import { AnchorEntityReader } from './resolve-anchor.js';
import { conformsTo, schemaRegistry } from './schema-attributes.js';

/** Explicit bounds on file-controlled input; refusal never returns a partial graph. */
export const GROUP_GRAPH_LIMITS = { entities: 250_000, recordCharacters: 4_000_000, totalRecordCharacters: 80_000_000, references: 2_000_000, members: 10_000 } as const;
export type GroupGraphLimits = { readonly [K in keyof typeof GROUP_GRAPH_LIMITS]: number };

export interface GroupRootIdentity { expressId: number; GlobalId: string }
export interface GroupMembershipSnapshot {
  relationship: GroupRootIdentity;
  RelatedObjects: GroupRootIdentity[];
}
export interface GroupSnapshot extends GroupRootIdentity {
  Name: string | null;
  Description: string | null;
  ObjectType: string | null;
  memberships: GroupMembershipSnapshot[];
}

/** Scan actual effective export records, never attribute numbers mistaken for refs. */
export function groupRecordReferences(text: string): number[] {
  const refs: number[] = [];
  let attributes = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new Error('Group graph has an unterminated record');
      i = end + 1; continue;
    }
    if (text[i] === "'") {
      let end = i;
      do {
        end = text.indexOf("'", end + 1);
        if (end < 0) throw new Error('Group graph has an unterminated record');
        if (text[end + 1] !== "'") break;
        end++;
      } while (true);
      i = end;
      continue;
    }
    if (text[i] === '(') attributes = true;
    if (!attributes || text[i] !== '#') continue;
    let end = i + 1;
    while (end < text.length && text[end] >= '0' && text[end] <= '9') end++;
    if (end === i + 1) throw new Error('Group graph has an unreadable reference');
    const id = Number(text.slice(i + 1, end));
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Group graph has an invalid reference');
    refs.push(id); i = end - 1;
  }
  if (!attributes) throw new Error('Group graph has an unreadable record');
  return refs;
}

export class GroupGraph {
  readonly schemaNames: SchemaEntityNameSnapshot;
  readonly entities = new Map<number, EffectiveEntityRecord>();
  readonly incoming = new Map<number, Set<number>>();
  private readonly roots = new Map<string, number[]>();

  /** `limits` exists so the budgets can be exercised at test scale; callers use the defaults. */
  constructor(readonly store: IfcDataStore, readonly view: MutablePropertyView,
    private readonly limits: GroupGraphLimits = GROUP_GRAPH_LIMITS) {
    if (store.schemaVersion !== 'IFC4' && store.schemaVersion !== 'IFC4X3') {
      throw new Error('Generic IfcGroup authoring requires a declared IFC4 or IFC4X3 model');
    }
    this.schemaNames = createSchemaEntityNameSnapshot(schemaRegistry(store.schemaVersion, 'IfcGroup'));
    const reader = new AnchorEntityReader(store, view, this.schemaNames);
    let referenceCount = 0;
    let recordCharacters = 0;
    for (const { expressId } of iterateEffectiveEntityIds(store, view)) {
      if (this.entities.size >= this.limits.entities) throw new Error('Group graph entity budget exceeded');
      const entity = reader.entity(expressId);
      if (!entity) throw new Error(`Group graph cannot read current entity #${expressId}`);
      this.entities.set(expressId, entity);
      if (entity.names[0] === 'GlobalId' && typeof entity.attributes[0] === 'string') {
        const guid = entity.attributes[0];
        const ids = this.roots.get(guid) ?? []; ids.push(expressId); this.roots.set(guid, ids);
      }
      const created = effectiveCreatedRecord(view, expressId, store.schemaVersion);
      // @raw-entity-enumeration-ok current candidate came from the canonical live iterator; source lookup supplies export record bytes only
      const source = created ? undefined : store.entityIndex.byId.get(expressId);
      const record = created ?? (source ? effectiveSourceRecord(view, expressId,
        store.source.decodeUtf8(source.byteOffset, source.byteOffset + source.byteLength), source.type, store.schemaVersion) : null);
      if (!record || record.notWritten.length) throw new Error(`Group graph cannot certify exported entity #${expressId}`);
      if (record.text.length > this.limits.recordCharacters) throw new Error('Group graph record budget exceeded');
      recordCharacters += record.text.length;
      if (recordCharacters > this.limits.totalRecordCharacters) throw new Error('Group graph total record work budget exceeded');
      for (const target of groupRecordReferences(record.text)) {
        if (++referenceCount > this.limits.references) throw new Error('Group graph reference budget exceeded');
        const ids = this.incoming.get(target) ?? new Set<number>(); ids.add(expressId); this.incoming.set(target, ids);
      }
    }
  }

  root(id: number, expected?: string): GroupRootIdentity {
    const entity = this.entities.get(id);
    const guid = entity?.names[0] === 'GlobalId' ? entity.attributes[0] : undefined;
    if (typeof guid !== 'string' || !isValidIfcGuid(guid)) throw new Error(`Group graph #${id} is not a live valid IfcRoot`);
    if (this.roots.get(guid)?.length !== 1) throw new Error(`Group graph GlobalId ${guid} has ambiguous current ownership`);
    if (expected !== undefined && guid !== expected) throw new Error(`Group graph #${id} GlobalId changed`);
    return { expressId: id, GlobalId: guid };
  }

  availableGuid(guid: string): void {
    if (!isValidIfcGuid(guid) || this.roots.has(guid)) throw new Error('Group GlobalId is invalid or already owned');
  }

  snapshot(target: GroupRootIdentity): GroupSnapshot {
    if (typeof target?.GlobalId !== 'string' || !isValidIfcGuid(target.GlobalId)) throw new Error('Group target must pin its current GlobalId');
    const identity = this.root(target.expressId, target.GlobalId);
    const entity = this.entities.get(target.expressId)!;
    if (entity.type.toUpperCase() !== 'IFCGROUP') throw new Error('Generic lifecycle requires exact IfcGroup, not a specialized group');
    const optional = (name: string): string | null => {
      const value = entity.attributes[entity.names.indexOf(name)];
      if (value !== null && value !== undefined && typeof value !== 'string') throw new Error(`IfcGroup.${name} is unreadable`);
      return value ?? null;
    };
    const memberships: GroupMembershipSnapshot[] = [];
    let totalMembers = 0;
    const registry = schemaRegistry(this.store.schemaVersion as 'IFC4' | 'IFC4X3', 'IfcGroup');
    for (const [id, row] of this.entities) {
      if (!conformsTo(registry, row.type, 'IfcRelAssignsToGroup', this.schemaNames)) continue;
      const relating = referenceId(row.attributes[row.names.indexOf('RelatingGroup')]);
      if (relating !== target.expressId) continue;
      if (row.type.toUpperCase() !== 'IFCRELASSIGNSTOGROUP') throw new Error('Group membership has specialized assignment semantics');
      const values = row.attributes[row.names.indexOf('RelatedObjects')];
      if (!Array.isArray(values) || !values.length || values.length > this.limits.members) {
        throw new Error('IfcRelAssignsToGroup.RelatedObjects is incomplete or exceeds its budget');
      }
      const ids = values.map(referenceId);
      if (ids.some(value => value === null) || new Set(ids).size !== ids.length) throw new Error('Group membership references are unreadable or duplicated');
      totalMembers += ids.length;
      if (totalMembers > this.limits.members) throw new Error('Complete group membership budget exceeded');
      for (const member of ids) {
        const type = this.entities.get(member!)?.type;
        if (member === target.expressId || !type || !conformsTo(registry, type, 'IfcObjectDefinition', this.schemaNames)) throw new Error('Current group membership has an invalid object definition');
      }
      memberships.push({ relationship: this.root(id), RelatedObjects: ids.map(value => this.root(value!)) });
    }
    return { ...identity, Name: optional('Name'), Description: optional('Description'), ObjectType: optional('ObjectType'), memberships };
  }
}

export function referenceId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^#[1-9][0-9]*$/.test(value)) {
    const id = Number(value.slice(1)); return Number.isSafeInteger(id) ? id : null;
  }
  return null;
}
