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
import { getAttributeNamesAcrossSchemas, getSchemaRegistryForVersion } from '@ifc-lite/parser';

/**
 * `ENTITIES_IFC4` (vendored from buildingSMART's C# `SchemaInfo` source) is
 * wrong for IFC4 in two ways (issue #5204): it gives `IfcCartesianPointList2D`/
 * `3D` a `TagList` attribute IFC4 has never had, and it misfiles 24 entities
 * from a draft alignment extension — `IfcAlignment2DHorizontal`,
 * `IfcLinearPlacement`, `IfcOffsetCurve`, … — that exist under NO name in
 * either the real IFC4 schema or (renamed) the finalized IFC4X3 one. Read
 * directly, `entityInfoInSchema('IfcCartesianPointList3D', 'IFC4')` answered
 * `TagList` as a real attribute, and `entityInfoInSchema('IfcAlignment2DHorizontal',
 * 'IFC4')` answered a full attribute list for an entity that is not IFC4-valid —
 * exactly the query this table exists to answer for an MCP client.
 *
 * `@ifc-lite/parser`'s `getSchemaRegistryForVersion('IFC4')` is generated from
 * the EXPRESS schema itself (the same oracle `packages/export/src/
 * schema-converter.ts`'s `attrNameTable` uses after #5204's fix), so it is
 * ground truth for "does IFC4 declare this entity, and with which attributes":
 * an `ENTITIES_IFC4` row only survives into `SCHEMA_TABLES` if the EXPRESS
 * registry also declares that name, and its attribute list is always the
 * EXPRESS-derived one, not the vendored one. `predefinedTypes`/`source`/
 * `typeEntity` are kept as `ENTITIES_IFC4` had them — the EXPRESS registry
 * does not carry those fields, and no consumer of this table reads them for
 * an IFC4 row. `ENTITIES_IFC2X3`/`ENTITIES_IFC4X3` are untouched — #5204
 * implicates only the IFC4 table.
 */
const IFC4_EXPRESS_ENTITIES = getSchemaRegistryForVersion('IFC4').entities;
const ENTITIES_IFC4_CORRECTED: readonly IfcEntityInfo[] = ENTITIES_IFC4
  .filter((entity) => entity.name in IFC4_EXPRESS_ENTITIES)
  .map((entity) => {
    const meta = IFC4_EXPRESS_ENTITIES[entity.name];
    const attrs = (meta?.allAttributes ?? meta?.attributes)?.map((a) => a.name);
    return attrs ? { ...entity, attributes: attrs } : entity;
  });

/** Bundled schemas, oldest first. */
const SCHEMA_TABLES: ReadonlyArray<readonly [string, readonly IfcEntityInfo[]]> = [
  ['IFC2X3', ENTITIES_IFC2X3],
  ['IFC4', ENTITIES_IFC4_CORRECTED],
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
