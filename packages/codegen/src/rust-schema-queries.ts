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

import type { ExpressSchema } from './express-parser.js';
import { getAllAttributes } from './express-parser.js';

/** Emitted inside `impl IfcType { … }`, closing the impl block. */
export function generateSchemaQueries(schema: ExpressSchema): string {
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
${schema.entities.map((e) => `            Self::${e.name} => &[${getAllAttributes(e, schema).map((a) => `"${a.name}"`).join(', ')}],`).join('\n')}
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
pub static ALL: &[IfcType] = &[
${schema.entities.map((e) => `    IfcType::${e.name},`).join('\n')}\n];

`;
}
