/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The bundled IFC schema tables, kept per schema rather than merged.
 *
 * The parser's `getAttributeNamesAcrossSchemas` answers from the IFC4 codegen
 * pin whenever the pin knows the class, and from a merged union otherwise —
 * which is the right default for a reader that does not know which schema it is
 * looking at. Two callers here do know: `schema_describe` is told the class, and
 * the query backend is told the model. For them a merged answer can be the wrong
 * schema's answer:
 *
 * - `IfcControl` has five attributes in IFC2X3 and six in IFC4 (which added
 *   `Identification`), so subtracting the merged count from an IFC2X3 leaf like
 *   `IfcScheduleTimeControl` ate one of the leaf's own attributes.
 * - `IfcRelCoversSpaces` names slot 4 `RelatedSpace` in IFC2X3 and
 *   `RelatingSpace` in IFC4, so reading a created one back in an IFC2X3 model
 *   reported an attribute name the file will not serialise.
 *
 * Later schemas still win when no schema is named, matching the parser's union.
 */

import { ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3, type IfcEntityInfo } from '@ifc-lite/data';
import { getAttributeNamesAcrossSchemas } from '@ifc-lite/parser';

/** Bundled schemas, oldest first. */
const SCHEMA_TABLES: ReadonlyArray<readonly [string, readonly IfcEntityInfo[]]> = [
  ['IFC2X3', ENTITIES_IFC2X3],
  ['IFC4', ENTITIES_IFC4],
  ['IFC4X3', ENTITIES_IFC4X3],
];

let bySchema: Map<string, Map<string, IfcEntityInfo>> | null = null;
function tables(): Map<string, Map<string, IfcEntityInfo>> {
  if (!bySchema) {
    bySchema = new Map(SCHEMA_TABLES.map(([schema, list]) => [
      schema,
      new Map(list.map((entity) => [entity.name.toUpperCase(), entity])),
    ]));
  }
  return bySchema;
}

/** One schema's row for a class, or undefined. `schema` is matched case- and
 *  punctuation-insensitively, so `Ifc4x3` and `IFC4X3` both resolve. */
export function entityInfoInSchema(type: string, schema: string | undefined): IfcEntityInfo | undefined {
  if (!schema) return undefined;
  return tables().get(schema.toUpperCase().replace(/[^A-Z0-9]/g, ''))?.get(type.toUpperCase());
}

/**
 * A class's row and the bundled schema that answered for it, later schemas
 * winning — the same precedence the parser's union map applies.
 */
export function entityInfoAcrossSchemas(type: string): { info: IfcEntityInfo; schema: string } | undefined {
  const upper = type.toUpperCase();
  for (let i = SCHEMA_TABLES.length - 1; i >= 0; i--) {
    const schema = SCHEMA_TABLES[i][0];
    const info = tables().get(schema)?.get(upper);
    if (info) return { info, schema };
  }
  return undefined;
}

/**
 * Attribute names in STEP positional order, preferring the named schema's
 * spelling.
 *
 * Falls back to the parser's cross-schema answer when the model's schema does
 * not declare the class — a vendor extension, or a class the file's declared
 * schema does not have. That fallback is the pre-existing behaviour and is
 * strictly better than nothing.
 */
export function attributeNamesForSchema(type: string, schema: string | undefined): readonly string[] {
  const info = entityInfoInSchema(type, schema);
  return info ? info.attributes : getAttributeNamesAcrossSchemas(type);
}
