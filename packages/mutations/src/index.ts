/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/mutations - Mutation tracking for IFC data
 */

export * from './types.js';
export { MutablePropertyView, type PropertyExtractor, type QuantityExtractor } from './mutable-property-view.js';
export { StoreEditor, OVERLAY_BYTE_OFFSET } from './store-editor.js';
export { ChangeSetManager } from './change-set.js';
export {
  BulkQueryEngine,
  type SelectionCriteria,
  type BulkAction,
  type BulkQuery,
  type BulkQueryPreview,
  type BulkQueryResult,
  type PropertyFilter,
  type FilterOperator,
} from './bulk-query-engine.js';
export {
  CsvConnector,
  type CsvRow,
  type MatchStrategy,
  type PropertyMapping,
  type DataMapping,
  type MatchResult,
  type ImportStats,
  type ImportProgress,
  type CsvParseOptions,
} from './csv-connector.js';
