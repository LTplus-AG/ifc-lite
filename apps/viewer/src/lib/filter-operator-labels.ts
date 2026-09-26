/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ConditionOperator } from '@ifc-lite/lists';
import type { FilterOperator } from '@ifc-lite/mutations';
import type { ClassificationOp, ModelTagOp, NumericOp, SetOp, StringOp, ValueOp } from '@ifc-lite/rules';
import type { TranslationKey } from '@/i18n';

type CanonicalOperator = SetOp | StringOp | NumericOp | ValueOp | ClassificationOp | ModelTagOp;

/** A single label key for each filter-rule operator, including tag membership. */
export const FILTER_OPERATOR_LABEL_KEYS = {
  in: 'filterOperators.in',
  notIn: 'filterOperators.notIn',
  eq: 'filterOperators.eq',
  ne: 'filterOperators.ne',
  contains: 'filterOperators.contains',
  notContains: 'filterOperators.notContains',
  startsWith: 'filterOperators.startsWith',
  endsWith: 'filterOperators.endsWith',
  matches: 'filterOperators.matches',
  notMatches: 'filterOperators.notMatches',
  gt: 'filterOperators.gt',
  gte: 'filterOperators.gte',
  lt: 'filterOperators.lt',
  lte: 'filterOperators.lte',
  isSet: 'filterOperators.isSet',
  isNotSet: 'filterOperators.isNotSet',
  isNonEmpty: 'filterOperators.isNonEmpty',
  isNull: 'filterOperators.isNull',
  isNotNull: 'filterOperators.isNotNull',
  hasAny: 'filterOperators.hasAny',
  hasAll: 'filterOperators.hasAll',
  hasNone: 'filterOperators.hasNone',
  untagged: 'filterOperators.untagged',
} as const satisfies Record<CanonicalOperator, TranslationKey>;

export const LIST_OPERATOR_LABEL_KEYS = {
  exists: FILTER_OPERATOR_LABEL_KEYS.isSet,
  equals: FILTER_OPERATOR_LABEL_KEYS.eq,
  notEquals: FILTER_OPERATOR_LABEL_KEYS.ne,
  contains: FILTER_OPERATOR_LABEL_KEYS.contains,
  gt: FILTER_OPERATOR_LABEL_KEYS.gt,
  gte: FILTER_OPERATOR_LABEL_KEYS.gte,
  lt: FILTER_OPERATOR_LABEL_KEYS.lt,
  lte: FILTER_OPERATOR_LABEL_KEYS.lte,
} as const satisfies Record<ConditionOperator, TranslationKey>;

export const BULK_OPERATOR_LABEL_KEYS = {
  '=': FILTER_OPERATOR_LABEL_KEYS.eq,
  '!=': FILTER_OPERATOR_LABEL_KEYS.ne,
  '>': FILTER_OPERATOR_LABEL_KEYS.gt,
  '>=': FILTER_OPERATOR_LABEL_KEYS.gte,
  '<': FILTER_OPERATOR_LABEL_KEYS.lt,
  '<=': FILTER_OPERATOR_LABEL_KEYS.lte,
  CONTAINS: FILTER_OPERATOR_LABEL_KEYS.contains,
  STARTS_WITH: FILTER_OPERATOR_LABEL_KEYS.startsWith,
  ENDS_WITH: 'filterOperators.endsWith',
  IS_NULL: 'filterOperators.isNull',
  IS_NOT_NULL: 'filterOperators.isNotNull',
} as const satisfies Record<FilterOperator, TranslationKey>;
