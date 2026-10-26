/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Schema-driven auto-qualification of SELECT-typed STEP attribute slots.
 *
 * ISO 10303-21 requires a SELECT member that is a defined type (not an entity
 * instance) to be TYPE-QUALIFIED: a boolean in an `IfcTranslationalStiffnessSelect`
 * slot must serialize as `IFCBOOLEAN(.T.)`, not a bare `.T.`; a length in an
 * `IfcSizeSelect` slot as `IFCLENGTHMEASURE(3.)`. A bare token is non-conformant
 * — strict validators reject it and even ifc-lite's own reader loses the member
 * type on round-trip. See the follow-up on LTplus-AG/ifc-lite#1839.
 *
 * The declared type of each slot is statically known from the schema registry.
 * When a bare JS value maps UNAMBIGUOUSLY to exactly one defined-type member of
 * the slot's SELECT (a boolean → the sole BOOLEAN member; a number → the sole
 * REAL member), we emit the qualified token automatically — no caller change.
 * A genuinely ambiguous slot (a number in `IfcValue`, which has 100+ REAL
 * members) is left for the caller's explicit `{ typed }` marker to resolve.
 *
 * Registry coverage is IFC4 (`SCHEMA_REGISTRY` is the parser's IFC4 pin); SELECT
 * definitions are highly stable across schema versions, and the `{ typed }`
 * marker is the version-independent escape hatch, so this is best-effort: an
 * entity the registry doesn't know simply isn't auto-qualified.
 */

import { SCHEMA_REGISTRY, getAllAttributesForEntity } from '@ifc-lite/parser';
import type { IfcAttributeValue, SchemaRegistry } from '@ifc-lite/parser';
import { resolveExpressBase, serializeTypedMarker } from './step-serialization.js';

function isSelectType(type: string, registry: SchemaRegistry = SCHEMA_REGISTRY): boolean {
  return Object.prototype.hasOwnProperty.call(registry.selects, type);
}

function isDefinedType(type: string, registry: SchemaRegistry = SCHEMA_REGISTRY): boolean {
  return Object.prototype.hasOwnProperty.call(registry.types, type);
}

/**
 * Every member of `selectName` that is not itself a select (nested selects
 * flattened), in `registry`'s order: defined types and entities alike.
 */
export function getSelectMembers(selectName: string, registry: SchemaRegistry = SCHEMA_REGISTRY): string[] {
  const members: string[] = [];
  const seen = new Set<string>();
  const walk = (sel: string): void => {
    if (seen.has(sel)) return;
    seen.add(sel);
    for (const member of registry.selects[sel] ?? []) {
      if (isSelectType(member, registry)) walk(member);
      else members.push(member);
    }
  };
  walk(selectName);
  return members;
}

// Memoized, per registry, `selectName` → Map<memberTypeName, expressBase> over
// the select's DEFINED-TYPE leaves (recursing nested selects; entity members
// are skipped — they serialize as `#ref`, never qualified).
const selectLeafCache = new WeakMap<SchemaRegistry, Map<string, Map<string, string>>>();

/**
 * `selectName` → its DEFINED-TYPE leaves, mapped to the EXPRESS primitive each
 * bottoms out in (`IfcText` → `STRING`, `IfcLengthMeasure` → `REAL`). Nested
 * selects are flattened; entity members are skipped (they serialize as `#ref`
 * and are never type-qualified).
 *
 * Exported for `declared-property-type.ts`, which asks the same question of
 * `IfcValue` for a different reason: not "which member does this bare value
 * imply" but "is this token a member at all, and does it agree with the value".
 * One walk, one cache, one definition of what a qualifiable member is.
 */
export function getSelectDefinedLeaves(selectName: string, registry: SchemaRegistry = SCHEMA_REGISTRY): Map<string, string> {
  let cache = selectLeafCache.get(registry);
  if (!cache) selectLeafCache.set(registry, (cache = new Map()));
  const cached = cache.get(selectName);
  if (cached) return cached;
  const leaves = new Map<string, string>();
  for (const member of getSelectMembers(selectName, registry)) {
    // An entity member is not qualifiable; an aggregate-typed one has no base.
    if (!isDefinedType(member, registry)) continue;
    const base = resolveExpressBase(member, registry);
    if (base) leaves.set(member, base);
  }
  cache.set(selectName, leaves);
  return leaves;
}

// Memoized `ENTITY` → Map<slotIndex, selectName> for scalar (non-aggregate)
// slots whose declared type is a SELECT.
const selectSlotCache = new Map<string, Map<number, string>>();

function getSelectSlots(entityType: string): Map<number, string> {
  const key = entityType.toUpperCase();
  const cached = selectSlotCache.get(key);
  if (cached) return cached;
  const slots = new Map<number, string>();
  const attrs = getAllAttributesForEntity(entityType);
  attrs.forEach((attr, i) => {
    // Only scalar SELECT slots — an aggregate of a select carries a list value
    // and is left to the default serializer.
    if (!attr.isArray && !attr.isList && !attr.isSet && isSelectType(attr.type)) {
      slots.set(i, attr.type);
    }
  });
  selectSlotCache.set(key, slots);
  return slots;
}

/**
 * A value that could stand in for a defined-type SELECT member: a bare boolean,
 * finite number, or plain string. Entity references (`#5`), null/derived
 * markers (`$`/`*`), and enum tokens (`.X.`) are entity/other members and are
 * never qualified.
 */
function isQualifiableScalar(value: IfcAttributeValue): value is boolean | number | string {
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') {
    const t = value.trim();
    if (t === '$' || t === '*') return false;
    if (/^#\d+$/.test(t)) return false;
    if (/^\.[A-Za-z0-9_]+\.$/.test(t)) return false;
    return true;
  }
  return false;
}

// Ordered EXPRESS-primitive preference for each JS value class. A boolean is an
// IfcBoolean before an IfcLogical; a number is a REAL measure before an integer.
function preferredBases(value: boolean | number | string): string[] {
  if (typeof value === 'boolean') return ['BOOLEAN', 'LOGICAL'];
  if (typeof value === 'number') return ['REAL', 'NUMBER', 'INTEGER'];
  return ['STRING', 'BINARY'];
}

/**
 * The single defined-type member of `selectName` that `value` unambiguously maps
 * to (e.g. `IfcBoolean` for a boolean in `IfcTranslationalStiffnessSelect`), or
 * `null` when zero or more-than-one members match — the ambiguous case the
 * `{ typed }` marker exists for.
 */
function qualifyingMember(selectName: string, value: boolean | number | string): string | null {
  const leaves = getSelectDefinedLeaves(selectName);
  if (leaves.size === 0) return null;
  for (const family of preferredBases(value)) {
    const matches: string[] = [];
    for (const [type, base] of leaves) {
      if (base === family) matches.push(type);
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return null; // ambiguous within the preferred family
  }
  return null;
}

/**
 * Emit the type-qualified STEP token for a SELECT slot when it can be resolved
 * unambiguously from the schema, else `null` (the caller falls back to the
 * default / REAL-forcing serializer). `entityType` may be PascalCase or the
 * upper STEP form; `index` is the zero-based positional slot.
 */
export function serializeQualifiedSelectSlot(
  entityType: string,
  index: number,
  value: IfcAttributeValue,
): string | null {
  const selectName = getSelectSlots(entityType).get(index);
  if (selectName === undefined) return null;
  if (!isQualifiableScalar(value)) return null;
  const member = qualifyingMember(selectName, value);
  if (member === null) return null;
  return serializeTypedMarker(member, value);
}
