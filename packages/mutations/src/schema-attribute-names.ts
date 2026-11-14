/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-schema attribute names of every IFC class, from the bundled
 * `@ifc-lite/data` tables, indexed once. The one lookup this package reads
 * class layouts from (created-entity reads, bulk attribute writes).
 */

import { getEntitiesIfc2x3, getEntitiesIfc4Express, getEntitiesIfc4x3, type IfcEntityInfo, type IfcStoreBase } from '@ifc-lite/data';

/** The schemas a loaded model can declare (`IfcDataStore.schemaVersion`). */
export type ModelSchema = IfcStoreBase['schemaVersion'];

/** Newest first. IFC5 models are laid out as IFC4X3 (see the exporter's retype map).
 *  Getters, so loading this module decodes no table. */
const TABLES: ReadonlyArray<readonly [ModelSchema, () => readonly IfcEntityInfo[]]> = [
  ['IFC4X3', getEntitiesIfc4x3],
  ['IFC4', getEntitiesIfc4Express],
  ['IFC2X3', getEntitiesIfc2x3],
];

let index: Map<ModelSchema, Map<string, readonly string[]>> | null = null;

function bySchema(): Map<ModelSchema, Map<string, readonly string[]>> {
  if (!index) {
    index = new Map(TABLES.map(([schema, table]) => [schema, new Map(table().map((e) => [e.name.toUpperCase(), e.attributes]))]));
  }
  return index;
}

/**
 * Attribute names (inherited included, in declaration order) of `type` in
 * `schema`, or `undefined` when that schema has no such class.
 */
export function schemaAttributeNames(schema: ModelSchema, type: string): readonly string[] | undefined {
  return bySchema().get(schema === 'IFC5' ? 'IFC4X3' : schema)?.get(type.toUpperCase());
}

/** Every bundled schema's attribute names for `type`, newest schema first. */
export function allSchemaAttributeNames(type: string): Array<readonly string[]> {
  const found: Array<readonly string[]> = [];
  for (const [schema] of TABLES) {
    const names = schemaAttributeNames(schema, type);
    if (names) found.push(names);
  }
  return found;
}
