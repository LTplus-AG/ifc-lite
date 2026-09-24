/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The identifier a STEP writer declares in `FILE_SCHEMA` for a schema family.
 *
 * ifc-lite names schemas by family (`'IFC2X3' | 'IFC4' | 'IFC4X3' | 'IFC5'`),
 * and for three of them the family name is also the file identifier. IFC4X3
 * is the exception (#5351). The attribute layouts ifc-lite writes for IFC4X3
 * are those of IFC4X3_ADD2 (ISO 16739-1:2024), but IfcOpenShell 0.8.x (and so
 * the buildingSMART Validation Service built on it) resolves the bare
 * `IFC4X3` token to a later DEVELOPMENT schema whose layouts differ:
 * `IfcTriangulatedIrregularNetwork` puts `Closed` before `Normals`,
 * `IfcMapConversion` has 10 attributes instead of 8. Standard-conformant
 * output then fails `ifcopenshell.validate` purely because of the token.
 *
 * This is the one place the TypeScript writers get that token from; the Rust
 * twin is `rust/export/src/file_schema.rs`. Readers are unaffected: every
 * reader in the repo already resolves `IFC4X3_ADD2` to the IFC4X3 family.
 *
 * Only a writer that CHOOSES the token calls this. A re-export that preserves
 * the source file's own `FILE_SCHEMA` token (round-trip header fidelity) does
 * not: it cannot know which layouts a file declared as bare `IFC4X3` carries.
 */
export function fileSchemaIdentifier(schema: string): string {
  return schema === 'IFC4X3' ? 'IFC4X3_ADD2' : schema;
}
