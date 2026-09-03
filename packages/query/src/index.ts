/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/query - Query system
 */

export { PropertyTable } from './property-table.js';
export { EntityTable } from './entity-table.js';
export { QueryBuilder, QueryInterface } from './fluent-api.js';
export { IfcQuery } from './ifc-query.js';
export { EntityQuery, type ComparisonOperator } from './entity-query.js';
export { EntityNode } from './entity-node.js';
export { QueryResultEntity } from './query-result-entity.js';
export { DuckDBIntegration, type SQLResult } from './duckdb-integration.js';
export { findPropertyInSets, findQuantityInSets, findAllPropertiesInSets, findAllQuantitiesInSets } from './pset-lookup.js';
export { normalizeBooleanValue, compareFilterValue, type FilterComparisonOp } from './filter-predicate.js';
