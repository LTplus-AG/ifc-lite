/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS data-store bridge.
 *
 * Builds an `IFCDataAccessor` (the abstract interface the IDS validator
 * consumes) from an `IfcDataStore` produced by `@ifc-lite/parser`. This
 * is the single canonical translation — viewer, MCP server, and the
 * corpus-parity harness all consume it instead of re-implementing the
 * same projection.
 *
 * Mirrors upstream `IfcOpenShell/ifctester` semantics: classification
 * sub-reference walking, IfcExternalReferenceRelationship for
 * non-rooted resources, length unit conversion, predefined property-set
 * unwrapping, schema-driven attribute XSD types, etc.
 */

export { createDataAccessor } from './data-accessor.js';
export { narrowSchemaVersion } from './schema-version.js';
