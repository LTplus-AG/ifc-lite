/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Public schema metadata and canonical-name exports. */
// Generated IFC4 schema (100% coverage - 776 entities, 397 types, 207 enums)
export { SCHEMA_REGISTRY, getEntityMetadata, getAllAttributesForEntity, getInheritanceChainForEntity, isKnownEntity } from './generated/schema-registry.js';
export {
  getSchemaRegistryForVersion,
  type SchemaVersionWithRegistry,
  type SchemaRegistry,
} from './generated/schema-registry-by-version.js';
export { getCanonicalEntityName, createSchemaEntityNameSnapshot, type SchemaEntityNameSnapshot } from './schema-entity-name.js';
export type * from './generated/entities.js';
export * from './generated/enums.js';

