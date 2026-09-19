/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcEntityInfo } from '@ifc-lite/data';
import type { EntityDefinition, ExpressSchema } from './express-parser.js';

/**
 * Adapt the class-shaped rows in the IFC data catalog for Rust name generation.
 *
 * The IFC4 catalog also carries defined types, enums, and selects because IDS
 * audits need their names. Subtracting the data package's authoritative type
 * list keeps `IfcType` an entity enum while retaining IFC4X1 entities absent
 * from the bundled IFC4 ADD2 EXPRESS file.
 */
export function entityCatalogSchema(
  name: string,
  catalog: readonly IfcEntityInfo[],
  excludedTypes: readonly { readonly name: string }[],
): ExpressSchema {
  const excludedNames = new Set(excludedTypes.map((type) => type.name.toUpperCase()));
  const entities: EntityDefinition[] = catalog
    .filter((entity) => !excludedNames.has(entity.name.toUpperCase()))
    .map((entity) => ({
      name: entity.name,
      isAbstract: entity.abstract,
      supertype: entity.parent,
      attributes: [],
    }));
  return { name, entities, types: [], enums: [], selects: [] };
}

/**
 * Keep the newest schema authoritative for shared names, then append entities
 * removed from it but present in another supported schema. This extends the
 * stable Rust discriminant universe without pretending one release's
 * positional attributes are valid for another release.
 */
export function mergeTypeUniverse(
  canonical: ExpressSchema,
  supplemental: readonly ExpressSchema[]
): ExpressSchema {
  const entities = [...canonical.entities];
  const names = new Set(entities.map((entity) => entity.name.toUpperCase()));
  for (const schema of supplemental) {
    for (const entity of schema.entities) {
      if (!names.has(entity.name.toUpperCase())) {
        entities.push(entity);
        names.add(entity.name.toUpperCase());
      }
    }
  }
  return {
    ...canonical,
    name: [canonical, ...supplemental].map((item) => item.name).join(' + '),
    entities,
  };
}
