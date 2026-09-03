/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Read one entity's parsed STEP arguments and resolve a named attribute to
 * its positional slot — the two primitives `anonymize-placement.ts` and
 * `anonymize-scrub.ts` (#2934) need to walk a placement chain and locate a
 * `Name`/`LongName`/`GlobalId` slot by EXPRESS name rather than a hardcoded
 * index that would silently drift from the schema.
 *
 * Deliberately thin: this module owns none of the parsing rules itself. It
 * composes `decodeRange` (`source-ref-bounds.ts`, the same readability gate
 * every other byte-range read in this package uses — #2491) with
 * `splitTopLevelArgs` (`step-argument-parser.ts`, the same quote/paren-aware
 * splitter `filterHiddenRefsFromRelationshipLine` uses) so a second,
 * independent STEP-line parser cannot disagree with the ones the rest of the
 * exporter already relies on.
 */

import type { IfcSourceBytes } from '@ifc-lite/parser';
import { getAttributeNamesAcrossSchemas, resolveEntityNameAlias } from '@ifc-lite/parser';
import { ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3, type IfcEntityInfo } from '@ifc-lite/data';
import { createSourceRefReader, decodeRange } from './source-ref-bounds.js';
import { splitTopLevelArgs } from './step-argument-parser.js';

/** One entity's parsed STEP record: its type token and top-level arguments,
 *  in declaration order (still raw STEP tokens — `#N`, `'text'`, `$`, `.T.`,
 *  a nested `(...)` list — not decoded values). */
export interface SubsetEntityArgs {
  /** UPPERCASE STEP type token, e.g. `IFCLOCALPLACEMENT`. */
  readonly type: string;
  readonly args: readonly string[];
}

/** The slice of an entity index this module reads: a byte-range lookup, same
 *  shape `collectReferencedEntityIds` and `collectStyleEntities` already take. */
export interface EntityByteRangeIndex {
  get(id: number): { byteOffset: number; byteLength: number; type?: string } | undefined;
}

/**
 * Read entity `id`'s STEP record out of `store`'s source and split it into
 * its type token and top-level argument list. Returns `null` when the id has
 * no entry in `index`, or when `index`'s byte range cannot actually be read
 * out of `store.source` (`createSourceRefReader` — the same gate
 * `step-pass-builder.ts`'s `isReadableSourceRef` applies), or when the bytes
 * at that range do not parse as a single `#N=TYPE(...);` record.
 *
 * Only reads SOURCE-backed records. An overlay-created entity (no bytes to
 * decode) is out of scope for this module: `anonymize-placement.ts` and
 * `anonymize-scrub.ts` only ever walk/mutate the entities a freshly-parsed
 * source model contains, never ones the private `MutablePropertyView` they
 * build has itself just created.
 */
export function readEntityArgs(
  store: { readonly source: IfcSourceBytes },
  index: EntityByteRangeIndex,
  id: number,
): SubsetEntityArgs | null {
  const ref = index.get(id);
  if (!ref) return null;
  const isReadable = createSourceRefReader(store.source);
  if (!isReadable(ref)) return null;

  const line = decodeRange(store.source, ref.byteOffset, ref.byteOffset + ref.byteLength);
  const match = line.match(/^#\d+\s*=\s*(\w+)\(([\s\S]*)\)\s*;\s*$/);
  if (!match) return null;
  const [, type, argsText] = match;
  return { type: type.toUpperCase(), args: splitTopLevelArgs(argsText) };
}

/**
 * A STEP source schema `attrIndex` can resolve slots against DIRECTLY, one
 * per bundled EXPRESS table (`@ifc-lite/data`'s `ENTITIES_IFC2X3` /
 * `ENTITIES_IFC4` / `ENTITIES_IFC4X3`). `IFC5` (ifcx — JSON-native, no
 * positional STEP records at all) never reaches this module, so it has no
 * table and is deliberately not a member.
 */
export type SourceStepSchema = 'IFC2X3' | 'IFC4' | 'IFC4X3';

const ATTRIBUTE_NAMES_BY_SCHEMA: Readonly<Record<SourceStepSchema, ReadonlyMap<string, readonly string[]>>> = {
  IFC2X3: attributeTableByUpperName(ENTITIES_IFC2X3),
  IFC4: attributeTableByUpperName(ENTITIES_IFC4),
  IFC4X3: attributeTableByUpperName(ENTITIES_IFC4X3),
};

function attributeTableByUpperName(table: readonly IfcEntityInfo[]): Map<string, readonly string[]> {
  const map = new Map<string, readonly string[]>();
  for (const entity of table) map.set(entity.name.toUpperCase(), entity.attributes);
  return map;
}

/**
 * Narrow an `IfcDataStore.schemaVersion` to a {@link SourceStepSchema}
 * `attrIndex` can resolve against, or `undefined` for anything that isn't
 * one of the three bundled STEP schemas (`IFC5`, or an absent/unrecognized
 * value) — callers pass that straight through to `attrIndex`, which then
 * falls back to the pinned-first cross-schema union exactly as it always did.
 */
export function stepSourceSchema(schemaVersion: string | undefined): SourceStepSchema | undefined {
  return schemaVersion === 'IFC2X3' || schemaVersion === 'IFC4' || schemaVersion === 'IFC4X3'
    ? schemaVersion
    : undefined;
}

/**
 * Zero-based positional index of attribute `name` on `type`, or `-1` when
 * `type` declares no such attribute (an unknown type, or a genuine typo).
 *
 * When `schema` is given (the exported model's OWN schema, via
 * {@link stepSourceSchema}), resolves against THAT schema's table first: the
 * three bundled schemas do not always agree on a class's attribute order —
 * e.g. IFC2X3's `IfcApprovalRelationship` puts `Name` at slot 3, IFC4 puts it
 * at slot 0 — so a caller walking an arbitrary, non-fixed type (anything
 * `pseudonymizeAllNames` reaches in `anonymize-scrub.ts`) has to resolve
 * against the source model's actual schema or it silently reads/writes the
 * wrong slot on every class the schemas disagree about. Falls back to
 * `getAttributeNamesAcrossSchemas` — the pinned-IFC4-first cross-schema
 * union this function always used before schema-aware resolution existed —
 * when `schema` is omitted, or when `schema`'s own table doesn't know `type`
 * (e.g. an IFC4X3-only class read out of an `IFC4` store).
 *
 * A caller that resolves a slot declared on a FIXED, verified-stable type —
 * `IfcRoot.GlobalId` (slot 0 on every bundled schema), or a literal type
 * token whose declared order was checked directly against all three
 * `ENTITIES_*` tables — may omit `schema`: the union answers identically to
 * a schema-specific lookup for those, and several call sites in
 * `anonymize-placement.ts` and `anonymize-scrub.ts` do exactly that, each
 * noting at the call site why its type is fixed rather than caller-supplied.
 *
 * `MutablePropertyView.setAttribute(id, name, value)` re-resolves `name` to a
 * slot by its own lookup at STEP-serialize time
 * (`step-attribute-mutations.ts`'s `applyAttributeMutations`), which now
 * calls THIS function with the source entity's own `stepSourceSchema` too —
 * so a `setAttribute` edit resolves the same slot this function would report
 * for the same type/schema. `anonymize-scrub.ts` still writes through
 * `MutablePropertyView.setPositionalAttribute(id, index, value)` with an
 * `index` resolved here directly (#3309); that path needs no re-resolution
 * at serialize time at all, so it stays the more direct choice for a caller
 * that already has the index in hand.
 */
export function attrIndex(type: string, name: string, schema?: SourceStepSchema): number {
  if (schema) {
    const names = ATTRIBUTE_NAMES_BY_SCHEMA[schema].get(resolveEntityNameAlias(type).toUpperCase());
    if (names) return names.indexOf(name);
  }
  return getAttributeNamesAcrossSchemas(type).indexOf(name);
}
