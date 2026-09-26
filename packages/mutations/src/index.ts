/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/mutations - Mutation tracking for IFC data
 */

export * from './types.js';
export {
  MutablePropertyView,
  type PropertyExtractor,
  type QuantityExtractor,
  type AttributeExtractor,
} from './mutable-property-view.js';
export {
  StoreEditor,
  OVERLAY_BYTE_OFFSET,
  setEntityTypeNormalizer,
  type EntityTypeNormalizer,
} from './store-editor.js';
export { ChangeSetManager } from './change-set.js';
export { storeHasSourceEntity } from './source-entity-index.js';
export {
  iterateEffectiveEntityIds,
  type EntityEnumerationSource,
  type EffectiveEntityId,
} from './effective-entity-enumeration.js';
export { MutationGuardError, type MutationGuard } from './mutation-guard.js';
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
export { BULK_WRITABLE_ATTRIBUTES } from './bulk-attribute-action.js';
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
export { buildMatchContext, matchRowAgainstContext } from './csv-match.js';
export { parseValue, PARSE_INVALID } from './csv-parse-value.js';
export {
  changeSetToOps,
  deriveEntityIdentity,
  type ChangeSetOp,
  type ChangeSetOpsResult,
  type DerivedIdentityEntry,
  type EntityIdentityResolver,
} from './change-set-to-ops.js';

export type { EntityOperation, EntityOperationEffect, EntityPreparationOptions, PreparedEntityOperations } from './cooperative-operation-types.js';
