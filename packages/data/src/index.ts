/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/data - Columnar data structures
 */

export { StringTable } from './string-table.js';
export { EntityTableBuilder } from './entity-table.js';
export type { EntityTable } from './entity-table.js';
export { PropertyTableBuilder } from './property-table.js';
export type { PropertyTable, PropertySet, Property, PropertyValue } from './property-table.js';
export { QuantityTableBuilder } from './quantity-table.js';
export type { QuantityTable, QuantitySet, Quantity } from './quantity-table.js';
export { RelationshipGraphBuilder } from './relationship-graph.js';
export type { RelationshipGraph, Edge, RelationshipInfo } from './relationship-graph.js';
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
