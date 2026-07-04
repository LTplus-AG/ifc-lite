/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Types
export type {
  ListDataProvider,
  ListDefinition,
  ListResult,
  ListRow,
  CellValue,
  ColumnDefinition,
  PropertyCondition,
  ConditionOperator,
  ListClassificationRef,
  ListGrouping,
  ListGroup,
  ListSummary,
  DiscoveredColumns,
  EntityAttribute,
} from './types.js';
export { ENTITY_ATTRIBUTES } from './types.js';

// Engine
export { executeList, listResultToCSV, summariseListRows } from './engine.js';

// Name pattern matching (Bonsai-style `/regex/` set/property names)
export { compileNameMatcher, isNamePattern } from './name-pattern.js';

// Column discovery
export { discoverColumns } from './discovery.js';

// Presets
export { LIST_PRESETS } from './presets.js';
