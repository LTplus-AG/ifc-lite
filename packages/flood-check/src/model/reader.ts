/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Read-only access to the entities of a parsed STEP store: decode on demand,
 * cache, and read attributes by their EXPRESS name for the store's schema.
 */

import {
  EntityExtractor,
  extractPropertiesOnDemand,
  extractTypePropertiesOnDemand,
  getAttributeNamesForSchema,
  type IfcDataStore,
} from '@ifc-lite/parser';
import { RelationshipType } from '@ifc-lite/data';

export type AttributeValue = unknown;

export interface DecodedEntity {
  expressId: number;
  /** UPPERCASE STEP type name. */
  type: string;
  attributes: readonly AttributeValue[];
}

/** The PascalCase IFC class of an UPPERCASE STEP name, for the classes this package reports. */
const PASCAL = new Map<string, string>();

export class ModelReader {
  private readonly extractor: EntityExtractor;
  private readonly cache = new Map<number, DecodedEntity | null>();
  private readonly names = new Map<string, readonly string[]>();

  constructor(readonly store: IfcDataStore) {
    this.extractor = new EntityExtractor(store.source);
  }

  get schema(): string {
    return this.store.schemaVersion;
  }

  entity(id: number | null | undefined): DecodedEntity | null {
    if (typeof id !== 'number') return null;
    const hit = this.cache.get(id);
    if (hit !== undefined) return hit;
    // @raw-entity-enumeration-ok The flood check reads a freshly parsed, immutable store (no live session or mutation overlay).
    const ref = this.store.entityIndex.byId.get(id) ?? this.store.deferredEntityIndex?.get(id);
    const decoded = ref ? this.extractor.extractEntity(ref) : null;
    const entity = decoded ? { expressId: id, type: decoded.type.toUpperCase(), attributes: decoded.attributes } : null;
    this.cache.set(id, entity);
    return entity;
  }

  idsOfType(upperType: string): readonly number[] {
    // @raw-entity-enumeration-ok The flood check reads a freshly parsed, immutable store (no live session or mutation overlay).
    return this.store.entityIndex.byType.get(upperType) ?? [];
  }

  private attributeNames(upperType: string): readonly string[] {
    let names = this.names.get(upperType);
    if (!names) {
      names = getAttributeNamesForSchema(upperType, this.schema);
      this.names.set(upperType, names);
    }
    return names;
  }

  /** An attribute by EXPRESS name; undefined when the class (in this schema) has no such attribute. */
  attr(entity: DecodedEntity | null, name: string): AttributeValue {
    if (!entity) return undefined;
    const index = this.attributeNames(entity.type).indexOf(name);
    return index < 0 ? undefined : entity.attributes[index];
  }

  /** `PascalCase` class name as the file declares it, for example `IfcDoor`. */
  className(entity: DecodedEntity): string {
    const cached = PASCAL.get(entity.type);
    if (cached) return cached;
    const name = this.store.entities?.getTypeName?.(entity.expressId) ?? '';
    const resolved = name && name.toUpperCase() === entity.type ? name : entity.type;
    PASCAL.set(entity.type, resolved);
    return resolved;
  }

  related(id: number, rel: RelationshipType, direction: 'forward' | 'inverse'): number[] {
    return this.store.relationships?.getRelated(id, rel, direction) ?? [];
  }

  /**
   * Every value of a property in the element's own sets of that name, else in
   * its type's (the occurrence overrides its type). Several sets of the same
   * name may disagree; a caller decides how (see `isExternal`).
   */
  propertyValues(id: number, psetName: string, propName: string): unknown[] {
    const collect = (sets: ReadonlyArray<{ name: string; properties: ReadonlyArray<{ name: string; value: unknown }> }>) => {
      const out: unknown[] = [];
      for (const set of sets) {
        if (set.name !== psetName) continue;
        for (const p of set.properties) if (p.name === propName) out.push(p.value);
      }
      return out;
    };
    const own = collect(extractPropertiesOnDemand(this.store, id));
    return own.length > 0 ? own : collect(extractTypePropertiesOnDemand(this.store, id)?.properties ?? []);
  }
}

export function asNumber(value: AttributeValue): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function asRef(value: AttributeValue): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

export function asString(value: AttributeValue): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** `.DOOR.` → `DOOR`. */
export function asEnum(value: AttributeValue): string | null {
  if (typeof value !== 'string') return null;
  const m = /^\.?([A-Z0-9_]+)\.?$/i.exec(value.trim());
  return m ? m[1].toUpperCase() : null;
}

export function asRefList(value: AttributeValue): number[] {
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number' && Number.isInteger(v)) : [];
}
