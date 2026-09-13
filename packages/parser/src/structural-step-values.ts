/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * STEP value coercions and schema-derived attribute lookup shared by the
 * structural extractor and its load/boundary-condition reader.
 *
 * Shared rather than duplicated per module on purpose: the two readers walk
 * the same `EntityExtractor` output, so a coercion that disagreed between them
 * — one accepting `.T.` as a boolean, the other not — would be invisible until
 * a file exercised both paths over one value.
 */

import type { EntityExtractor } from './entity-extractor.js';
import type { IfcDataStore } from './columnar-parser.js';
import { getAttributeNames, normalizeIfcTypeName } from './ifc-schema.js';

/**
 * Unwrap a STEP typed value. `EntityExtractor` returns `IFCFORCEMEASURE(-100.)`
 * as `['IFCFORCEMEASURE', -100]`, so every coercion below has to look through
 * that wrapper before testing the value.
 */
export function unwrapTyped(value: unknown): unknown {
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string') {
    return value[1];
  }
  return value;
}

export function asString(value: unknown): string | undefined {
  const inner = unwrapTyped(value);
  return typeof inner === 'string' && inner.length > 0 ? inner : undefined;
}

export function asNumber(value: unknown): number | undefined {
  const inner = unwrapTyped(value);
  return typeof inner === 'number' && Number.isFinite(inner) ? inner : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  const inner = unwrapTyped(value);
  if (typeof inner === 'boolean') return inner;
  if (inner === '.T.' || inner === 'T') return true;
  if (inner === '.F.' || inner === 'F') return false;
  return undefined;
}

/** A STEP enum reaches us as `.GLOBAL_COORDS.`; return the bare label. */
export function asEnum(value: unknown): string | undefined {
  const s = asString(value);
  if (!s) return undefined;
  const m = s.match(/^\.([A-Za-z0-9_]+)\.$/);
  return m ? m[1] : undefined;
}

export function asRef(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function asRefList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const v of value) {
    const id = asRef(v);
    if (id !== undefined) out.push(id);
  }
  return out;
}

export function asNumberList(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: number[] = [];
  for (const v of value) {
    const n = asNumber(v);
    if (n !== undefined) out.push(n);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Resolve an attribute's STEP position from the generated registry by its
 * EXPRESS name, rather than writing the index literally. A type whose registry
 * entry does not carry the name answers -1, and {@link readAttr} reports the
 * attribute as absent instead of reading whatever sits at a guessed offset.
 */
export function attrIndex(type: string, attrName: string): number {
  return getAttributeNames(type).indexOf(attrName);
}

export function readAttr(type: string, attrs: unknown[], attrName: string): unknown {
  const i = attrIndex(type, attrName);
  return i >= 0 ? attrs[i] : undefined;
}

/** Push `value` onto `key`'s list without duplicating it. */
export function addUnique(map: Map<number, string[]>, key: number, value: string): void {
  let list = map.get(key);
  if (!list) {
    list = [];
    map.set(key, list);
  }
  if (!list.includes(value)) list.push(value);
}

/** One extracted STEP record, reduced to what the structural readers need. */
export interface RawEntity {
  expressId: number;
  /**
   * Canonical EXPRESS PascalCase. STEP stores type names uppercase, and the
   * house rule is that a user-facing surface carries the exact EXPRESS name,
   * so the raw `IFCSTRUCTURALCURVEMEMBER` is normalized once here rather than
   * at each of the six places that build a public record from it.
   */
  type: string;
  attrs: unknown[];
  /** Attribute 0 for an IfcRoot descendant; '' when absent or unreadable. */
  globalId: string;
}

export function readEntities(
  extractor: EntityExtractor,
  store: IfcDataStore,
  expressIds: readonly number[],
): RawEntity[] {
  const out: RawEntity[] = [];
  for (const expressId of expressIds) {
    const ref = store.entityIndex.byId.get(expressId);
    if (!ref) continue;
    const entity = extractor.extractEntity(ref);
    if (!entity) continue;
    const attrs = entity.attributes || [];
    out.push({
      expressId,
      type: normalizeIfcTypeName(entity.type),
      attrs,
      globalId: asString(attrs[0]) ?? '',
    });
  }
  return out;
}
