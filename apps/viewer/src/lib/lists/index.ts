/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Re-export from the @ifc-lite/lists package for convenient viewer imports
export type {
  ListDataProvider,
  ListDefinition,
  ListResult,
  ListRow,
  CellValue,
  ColumnDefinition,
  PropertyCondition,
  ConditionOperator,
  DiscoveredColumns,
  EntityAttribute,
  ListGrouping,
} from '@ifc-lite/lists';
export {
  ENTITY_ATTRIBUTES,
  executeList,
  summariseListRows,
  groupingColumnIds,
  groupPathKey,
  listResultToCSV,
  discoverColumns,
  LIST_PRESETS,
} from '@ifc-lite/lists';

// Viewer-specific: persistence (browser APIs) and adapter
export { loadListDefinitions, saveListDefinitions, exportListDefinition, importListDefinition } from './persistence.js';
export { createListDataProvider } from './adapter.js';
