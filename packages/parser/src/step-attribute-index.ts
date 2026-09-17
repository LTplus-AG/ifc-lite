/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * THE name -> positional-slot resolver for a STEP record's attributes.
 *
 * This used to live in `@ifc-lite/export`'s `subset-entity-reader.ts`, which
 * re-exports it unchanged. It moved down into the parser when a second reader
 * needed it: the cost overlay (`cost-overlay.ts`) writes a pending attribute
 * edit into the slot the READ model picks it up from, and the STEP exporter
 * writes the same edit into the slot the FILE carries it in. Those two slots
 * have to be the same slot, for the same type, under the same schema — a
 * model whose read model and exported bytes disagree about which attribute an
 * edit landed on is the exact failure this repo has been bitten by before.
 * One function, resolved from one set of tables, makes the divergence
 * impossible rather than merely unlikely.
 */

import { ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3, type IfcEntityInfo } from '@ifc-lite/data';
import { getAttributeNamesAcrossSchemas, resolveEntityNameAlias } from './ifc-schema.js';

/**
 * A STEP source schema `attrIndex` can resolve slots against DIRECTLY, one
 * per bundled EXPRESS table (`@ifc-lite/data`'s `ENTITIES_IFC2X3` /
 * `ENTITIES_IFC4` / `ENTITIES_IFC4X3`). `IFC5` (ifcx — JSON-native, no
 * positional STEP records at all) has no table and is deliberately not a
 * member.
 */
export type SourceStepSchema = 'IFC2X3' | 'IFC4' | 'IFC4X3';

function attributeTableByUpperName(table: readonly IfcEntityInfo[]): Map<string, readonly string[]> {
  const map = new Map<string, readonly string[]>();
  for (const entity of table) map.set(entity.name.toUpperCase(), entity.attributes);
  return map;
}

const ATTRIBUTE_NAMES_BY_SCHEMA: Readonly<Record<SourceStepSchema, ReadonlyMap<string, readonly string[]>>> = {
  IFC2X3: attributeTableByUpperName(ENTITIES_IFC2X3),
  IFC4: attributeTableByUpperName(ENTITIES_IFC4),
  IFC4X3: attributeTableByUpperName(ENTITIES_IFC4X3),
};

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
 * When `schema` is given (the model's OWN schema, via
 * {@link stepSourceSchema}), resolves against THAT schema's table first: the
 * three bundled schemas do not always agree on a class's attribute order —
 * e.g. IFC2X3's `IfcApprovalRelationship` puts `Name` at slot 3, IFC4 puts it
 * at slot 0 — so a caller walking an arbitrary, non-fixed type has to resolve
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
 * a schema-specific lookup for those.
 *
 * `MutablePropertyView.setAttribute(id, name, value)` re-resolves `name` to a
 * slot by its own lookup at STEP-serialize time
 * (`step-attribute-mutations.ts`'s `applyAttributeMutations`), which calls
 * THIS function with the source entity's own `stepSourceSchema` — so a
 * `setAttribute` edit resolves the same slot this function would report for
 * the same type/schema, whether it is being written into the exported bytes
 * or being observed by the cost read model.
 */
export function attrIndex(type: string, name: string, schema?: SourceStepSchema): number {
  if (schema) {
    const names = ATTRIBUTE_NAMES_BY_SCHEMA[schema].get(resolveEntityNameAlias(type).toUpperCase());
    if (names) return names.indexOf(name);
  }
  return getAttributeNamesAcrossSchemas(type).indexOf(name);
}
