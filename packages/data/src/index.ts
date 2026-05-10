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

// Logging utilities
export { createLogger, logger, type LogLevel, type LogContext } from './logger.js';
