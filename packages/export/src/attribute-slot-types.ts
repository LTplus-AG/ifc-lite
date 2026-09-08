/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Schema-aware detection of ENUMERATION- and STRING-typed STEP attribute slots.
 *
 * `serializeAttributeValue` infers a named attribute's STEP form from the token
 * it is replacing. That works while there IS a token to read — a current
 * `.ELEMENT.` says "this slot is an enum", a current `'Wall A'` says "this slot
 * is text and the new value must be quoted" — and fails silently when the slot
 * holds `$`, where there is nothing to read. Two ways it fails:
 *
 *   - an enum came out quoted (`'USERDEFINED'`, not `.USERDEFINED.`);
 *   - a value that merely LOOKS like a token is emitted as one, so a `Tag` or
 *     `Name` of `#12` became an entity reference and `.FOO.` an enumeration.
 *     A room or tag literally named `#12` is ordinary on a real project.
 *
 * Both write a schema-invalid record rather than a wrong value, and the second
 * got wider when overlay-created records started padding missing slots with `$`
 * (#2006 review).
 *
 * A slot's declared type is statically known, so resolve it from the schema
 * instead of guessing from the previous value. Indices come from exactly the
 * resolution {@link getAttributeNamesAcrossSchemas} uses — the pinned IFC4
 * registry first, the bundled 2X3+4+4X3 union only when the pin knows the class
 * not at all — so an index from one is always an index into the other.
 * `attribute-slot-types.test.ts` asserts that alignment over every class in the
 * registry rather than trusting it.
 *
 * Deliberately NOT version-parameterized: both sources are version-invariant
 * here (the pin is IFC4, the union merges every bundled schema), so adding a
 * version would suggest a precision this data cannot deliver.
 *
 * The one remaining gap is a leaf-declared, non-PredefinedType enum on a class
 * the pin does not carry. `IfcEntityInfo` records attribute NAMES only —
 * "types/optional flags are out of scope for the auditor (and not exposed by
 * the upstream SchemaInfo data)" — so those types do not exist in this repo to
 * be read, in the generated tables or anywhere else; closing that would take a
 * codegen change to `@ifc-lite/data`. Everything reachable without one is
 * covered: inherited slots via the nearest pinned ancestor, PredefinedType via
 * the declared domain.
 */

import {
  SCHEMA_REGISTRY,
  getAllAttributesForEntity,
  getAttributeNamesAcrossSchemas,
  resolveEntityNameAlias,
} from '@ifc-lite/parser';
import { ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3, type IfcEntityInfo } from '@ifc-lite/data';
import { escapeStepString, resolveExpressBase } from './step-serialization.js';

/** Union of every bundled schema, later schemas winning — mirrors the fallback
 *  inside `getAttributeNamesAcrossSchemas` so the two agree on indices. */
const UNION_BY_UPPER: Map<string, IfcEntityInfo> = (() => {
  const map = new Map<string, IfcEntityInfo>();
  for (const list of [ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3]) {
    for (const entity of list) map.set(entity.name.toUpperCase(), entity);
  }
  return map;
})();

/** The declared-type classification of one class's positional slots. */
interface SlotTypes {
  /** Slots whose declared type is an EXPRESS ENUMERATION. */
  readonly enums: ReadonlySet<number>;
  /** Slots whose declared type bottoms out in EXPRESS STRING. */
  readonly strings: ReadonlySet<number>;
}

const slotTypeCache = new Map<string, SlotTypes>();

/**
 * Declared attribute types of the nearest ancestor the pinned registry DOES
 * carry, as a name → EXPRESS type map, for a class it does not.
 *
 * The union data set records attribute names but no per-attribute type, so the
 * types of a leaf's INHERITED attributes have to come from an ancestor. Walks
 * the union's `parent` chain because the pin cannot see the intermediate
 * classes either (IfcRoad → IfcFacility → IfcSpatialStructureElement: only the
 * last is pinned).
 */
function pinnedAncestorAttributeTypes(info: IfcEntityInfo): Map<string, string> | null {
  const seen = new Set<string>();
  let cursor: IfcEntityInfo | undefined = info.parent
    ? UNION_BY_UPPER.get(info.parent.toUpperCase())
    : undefined;
  while (cursor && !seen.has(cursor.name)) {
    seen.add(cursor.name);
    const attributes = getAllAttributesForEntity(cursor.name);
    if (attributes.length > 0) {
      return new Map(attributes.map((a) => [a.name, a.type]));
    }
    cursor = cursor.parent ? UNION_BY_UPPER.get(cursor.parent.toUpperCase()) : undefined;
  }
  return null;
}

/** Classify one slot by its declared EXPRESS type. */
function classify(declaredType: string, index: number, enums: Set<number>, strings: Set<number>): void {
  if (SCHEMA_REGISTRY.enums[declaredType]) {
    enums.add(index);
  } else if (resolveExpressBase(declaredType) === 'STRING') {
    strings.add(index);
  }
}

/**
 * Declared-type classification of `entityType`'s positional slots.
 *
 * Returns empty sets for classes neither source knows (vendor extensions),
 * which leaves those slots on the previous-token inference exactly as before.
 * Empty sets can never MISPLACE a value, so degrading to them is always safe.
 */
function getSlotTypes(entityType: string): SlotTypes {
  // Canonicalize FIRST, and cache on the canonical name: `getAttributeNames-
  // AcrossSchemas` resolves stratum aliases (IFCSOLIDSTRATUM →
  // IfcGeotechnicalStratum) before indexing the union, so a lookup that did not
  // would answer about a different attribute list than the one these indices
  // index into — and every alias of one class would get its own cache entry.
  const canonical = resolveEntityNameAlias(entityType);
  const upper = canonical.toUpperCase();
  const cached = slotTypeCache.get(upper);
  if (cached) return cached;

  const enums = new Set<number>();
  const strings = new Set<number>();
  const pinned = getAllAttributesForEntity(canonical);
  if (pinned.length > 0) {
    for (let i = 0; i < pinned.length; i++) classify(pinned[i].type, i, enums, strings);
  } else {
    const info = UNION_BY_UPPER.get(upper);
    if (info) {
      // Inherited slots: take the declared type from the nearest pinned
      // ancestor, matched BY NAME against this class's own attribute list.
      //
      // Not by index. The ancestor's list is not always a prefix of the leaf's
      // (measured: 30 of the 169 classes with a pinned ancestor), and reusing
      // its indices would classify the wrong slot — e.g. on
      // IfcStructuralLinearActionVarying index 10 is `ProjectedOrTrue` in the
      // ancestor and `CausedBy` in the leaf, so an edit to a reference slot
      // would be written as `.SOMETHING.`. Name matching places
      // `ProjectedOrTrue` at the leaf's index 11, where it belongs.
      const names = getAttributeNamesAcrossSchemas(canonical);
      const ancestorTypes = pinnedAncestorAttributeTypes(info);
      if (ancestorTypes) {
        for (let i = 0; i < names.length; i++) {
          const declared = ancestorTypes.get(names[i]);
          if (declared) classify(declared, i, enums, strings);
        }
      }
      // Leaf-declared PredefinedType: no ancestor declares it, and its enum
      // type name is not in the union data — but a non-empty domain says the
      // slot is an enumeration, which is all this needs to know.
      if (info.predefinedTypes.length > 0) {
        const index = names.indexOf('PredefinedType');
        if (index >= 0) enums.add(index);
      }
    }
  }

  const resolved: SlotTypes = { enums, strings };
  slotTypeCache.set(upper, resolved);
  return resolved;
}

/**
 * Zero-based positional slots on `entityType` whose declared type is an EXPRESS
 * ENUMERATION.
 */
export function getEnumTypedSlots(entityType: string): ReadonlySet<number> {
  return getSlotTypes(entityType).enums;
}

/**
 * Zero-based positional slots on `entityType` whose declared type bottoms out in
 * EXPRESS STRING (`IfcLabel`, `IfcText`, `IfcIdentifier`, …).
 *
 * These are the slots where a value must be QUOTED regardless of what it looks
 * like. Entity-reference and SELECT slots deliberately stay out: a bare `#12`
 * is the correct token there, and it is only in a text slot that emitting one
 * is a corruption.
 */
export function getStringTypedSlots(entityType: string): ReadonlySet<number> {
  return getSlotTypes(entityType).strings;
}

/**
 * ISO 10303-21 enumeration token body: a letter, then letters, digits or
 * underscores. Anything else is not an enumeration token at all.
 */
const ENUM_SYMBOL = /^[A-Z][A-Z0-9_]*$/;

/**
 * Serialize a value destined for an ENUM slot as a STEP enumeration token:
 * `.USERDEFINED.`, never `'USERDEFINED'`. Accepts the bare symbol or the
 * already-dotted form.
 *
 * Two different questions, answered differently:
 *
 * DOMAIN validity — "is `.FOO.` a legal value of IfcWallTypeEnum" — is NOT
 * checked. That is a schema question; the domain check with its `USERDEFINED` +
 * `ObjectType` fallback lives in `retype.ts`, where a carried-over value has to
 * survive a class change. Here the caller named this attribute explicitly, and
 * `.FOO.` is at least a well-formed token in the right lexical category.
 *
 * LEXICAL validity — "is this a token at all" — IS checked, because this
 * function owns the token form and nothing downstream can recover from getting
 * it wrong. `.A,B.` re-parses as TWO arguments and shifts every following slot;
 * `.O'BRIEN.` opens a string literal that swallows the rest of the record. The
 * damage is silent and spans the whole entity, not one attribute.
 *
 * An invalid symbol falls back to a quoted string rather than throwing or
 * dropping. Dropping is the bug class this whole change exists to fix. Throwing
 * would turn one odd attribute value into a failed save of the entire model —
 * strictly worse than one wrongly-typed slot in a file that still parses, still
 * has correct arity, and still shows the user the text they typed. A quoted
 * string is also exactly what this slot got before enum detection existed.
 */
export function serializeEnumToken(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '*') return '*';
  const symbol = trimmed.replace(/^\./, '').replace(/\.$/, '').trim().toUpperCase();
  if (symbol === '' || symbol === '$') return '$';
  if (!ENUM_SYMBOL.test(symbol)) {
    console.warn(
      `[StepExporter] "${value}" is not a valid STEP enumeration symbol; writing it as a quoted string. `
      + 'The record stays parseable, but the slot now holds text where the schema declares an enumeration.',
    );
    return serializeStringSlot(trimmed);
  }
  return `.${symbol}.`;
}

/**
 * Serialize a value destined for a STRING slot.
 *
 * Always quotes, never infers. `serializeAttributeValue` reads the token being
 * replaced to decide the form, so over a `$` slot it takes a value that merely
 * LOOKS like a token at face value: a `Tag` of `#12` became an entity
 * reference, `.FOO.` an enumeration. In a slot the schema declares as text, the
 * only legal tokens are a quoted string and the null/derived markers, so there
 * is nothing to infer.
 *
 * `''`, `$` and `*` keep their existing meaning as those markers — that is
 * unchanged behaviour, and `''` is already the caller's way to clear a value.
 */
export function serializeStringSlot(value: string): string {
  const trimmed = value.trim();
  if (value === '' || trimmed === '$' || trimmed === '*') {
    return trimmed === '*' ? '*' : '$';
  }
  return `'${escapeStepString(value)}'`;
}
