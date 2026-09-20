/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The queryable surface of the generated IfcType: per-entity attribute names
 * and the whole-schema catalog.
 *
 * Split from rust-generator.ts so the enum emission and the metadata that
 * answers questions ABOUT the enum stay separable.
 */

import type { IfcEntityInfo } from '@ifc-lite/data';
import type { EntityDefinition, ExpressSchema } from './express-parser.js';
import { getAllAttributes } from './express-parser.js';

/** Adapt class-shaped IFC catalog rows into a name-only EXPRESS supplement. */
export function entityCatalogSchema(
  name: string,
  catalog: readonly IfcEntityInfo[],
  excludedTypes: readonly { readonly name: string }[],
): ExpressSchema {
  const excludedNames = new Set(excludedTypes.map((type) => type.name.toUpperCase()));
  const entities: EntityDefinition[] = catalog
    .filter(
      (entity) =>
        !excludedNames.has(entity.name.toUpperCase()) &&
        (entity.parent !== undefined || entity.abstract || entity.attributes.length > 0),
    )
    .map((entity) => ({
      name: entity.name,
      isAbstract: entity.abstract,
      supertype: entity.parent,
      attributes: [],
    }));
  return { name, entities, types: [], enums: [], selects: [] };
}

/** Merge exact names while preserving canonical positional metadata. */
export function mergeTypeUniverse(
  canonical: ExpressSchema,
  supplemental: readonly ExpressSchema[],
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

/** Emitted inside `impl IfcType { … }`, closing the impl block. */
export function generateSchemaQueries(
  schema: ExpressSchema,
  typeUniverse: readonly EntityDefinition[] = schema.entities,
  visibility = 'pub',
): string {
  const canonicalNames = new Set(schema.entities.map((entity) => entity.name));
  return `    /// This entity's attributes, in STEP declaration order.
    ///
    /// Supertype attributes come FIRST, which is what makes the position here
    /// the same position DecodedEntity::get indexes. An entity's own
    /// attribute list alone would be wrong about every index on every subtype.
    ///
    /// These names are this schema's (${schema.name}). An entity whose
    /// attribute list grew between IFC releases has a different length, and
    /// therefore possibly different indices, in a file that declares an older
    /// schema. Check the file's FILE_SCHEMA before treating an index from here
    /// as authoritative for it.
    pub fn attribute_names(&self) -> &'static [&'static str] {
        match self {
${typeUniverse.map((e) => canonicalNames.has(e.name)
    ? `            Self::${e.name} => &[${getAllAttributes(e, schema).map((a) => `"${a.name}"`).join(', ')}],`
    : `            Self::${e.name} => &[],`).join('\n')}
            Self::Unknown(_) => &[],
        }
    }

    /// The position of a named attribute, for DecodedEntity::get.
    ///
    /// Case-sensitive: EXPRESS attribute names are PascalCase and the schema's
    /// spelling is the only one that resolves.
    pub fn attribute_index(&self, name: &str) -> Option<usize> {
        self.attribute_names().iter().position(|n| *n == name)
    }
}

/// Every entity type this schema defines, in declaration order.
///
/// A slice and not an array: the length is a property of the schema, and
/// baking it into the type would make the next IFC release a breaking
/// change for anyone who names it.
///
/// The enum is exhaustive but not enumerable: the Unknown(u32) variant
/// makes it open, and the CRC32 ids are sparse, so neither from_id nor a
/// range gives a caller the catalog. A consumer that has to reason about the
/// WHOLE schema — mapping every class to some other vocabulary, auditing
/// which ones it covers, generating a table — otherwise has to re-parse
/// the EXPRESS file or scrape this one.
${visibility} static ALL: &[IfcType] = &[
${schema.entities.map((e) => `    IfcType::${e.name},`).join('\n')}\n];

`;
}
