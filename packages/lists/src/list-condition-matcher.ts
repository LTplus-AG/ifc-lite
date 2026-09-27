/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The reader behind Rules' `listCondition` adapter (#6190): the Lists
 * engine's own predicate, so a condition inside a Rules group keeps exactly
 * the rows it keeps as a list scope. Attach one per model to the evaluator
 * model (`EvaluatorModel.listConditions`). */
import type { ListConditionMatcher } from '@ifc-lite/rules';
import { matchesCondition } from './engine.js';
import type { ListDataProvider } from './types.js';

export function listConditionMatcher(provider: ListDataProvider): ListConditionMatcher {
  return (expressId, rule) => matchesCondition(expressId, rule, provider);
}
