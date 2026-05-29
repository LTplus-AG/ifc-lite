/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/data - Columnar data structures
 */

export { StringTable } from './string-table.js';
export { EntityTableBuilder, entityTableFromColumns, entityTableToColumns } from './entity-table.js';
export type { EntityTable, EntityTableColumns } from './entity-table.js';
export { PropertyTableBuilder, propertyTableFromColumns, propertyTableToColumns } from './property-table.js';
export type { PropertyTable, PropertyTableColumns, PropertySet, Property, PropertyValue } from './property-table.js';
export { QuantityTableBuilder, quantityTableFromColumns, quantityTableToColumns } from './quantity-table.js';
export type { QuantityTable, QuantityTableColumns, QuantitySet, Quantity } from './quantity-table.js';
export {
  RelationshipGraphBuilder,
  buildCSR,
  relationshipEdgesFromColumns,
  relationshipGraphFromEdges,
  relationshipGraphFromColumns,
  relationshipGraphToColumns,
} from './relationship-graph.js';
export type {
  RelationshipGraph,
  RelationshipEdges,
  RelationshipEdgesColumns,
  RelationshipGraphColumns,
  Edge,
  RelationshipInfo,
} from './relationship-graph.js';
export * from './types.js';
// Explicitly export const enums for runtime use
export { IfcTypeEnum, PropertyValueType, QuantityType, RelationshipType, EntityFlags } from './types.js';
export type { SpatialNode, SpatialHierarchy } from './types.js';
export * from './spatial-types.js';
export * from './epsg-types.js';
export {
  loadEpsgIndex,
  loadEpsgIndexByCode,
  loadEpsgIndexDatasetVersion,
  lookupEpsgByCode,
  lookupProj4,
  searchEpsgIndex,
} from './epsg-index.js';

// Entity name mapping (UPPERCASE → PascalCase)
export { IFC_ENTITY_NAMES } from './ifc-entity-names.js';

// Per-version IFC schema lookup (used by `@ifc-lite/ids` audit)
export {
  getEntities,
  getPropertySets,
  getPartOfRelations,
  getDataTypes,
  getAttributes,
  findEntity,
  findPropertySet,
  findDataType,
  findAttribute,
  getAttributeXsdTypes,
  getInheritanceChain,
  isEntitySubtypeOf,
  RESERVED_PSET_PREFIXES,
} from './ifc-schema/index.js';

// Raw bundled entity tables — exposed so synchronous consumers (parser
// categorizer, geometry routers) can walk the inheritance chain across
// every IFC version in one map without the async wrappers above. Treat
// as read-only.
export { ENTITIES_IFC2X3 } from './ifc-schema/generated/entities-ifc2x3.js';
export { ENTITIES_IFC4 } from './ifc-schema/generated/entities-ifc4.js';
export { ENTITIES_IFC4X3 } from './ifc-schema/generated/entities-ifc4x3.js';
export type {
  IfcAttributeInfo,
  IfcDataTypeInfo,
  IfcEntityInfo,
  IfcPropertyInfo,
  IfcPropertySetInfo,
  IfcSchemaVersion,
  PartOfRelationInfo,
} from './ifc-schema/index.js';

// Logging utilities
export { createLogger, logger, type LogLevel, type LogContext } from './logger.js';

// SAB-safe TextDecoder helper. Both Firefox and Chromium reject
// `TextDecoder.decode()` on SharedArrayBuffer-backed views as a
// Spectre-class timing-attack mitigation; this helper transparently
// routes those calls through a thread-local scratch buffer.
export { safeUtf8Decode, textDecoderAcceptsSab } from './utf8-decode.js';
