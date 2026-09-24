/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Options on `property` and `quantity` rules that change HOW the value is
 * read, not what it is compared with. Their own module because
 * `filter-rules.ts` sits at the module-size cap; `PropertyRule` and
 * `QuantityRule` extend this interface.
 *
 * A rule that sets any of these is matched through `readSubject` (see
 * `subject-match.ts`) in search and applicability as well as in validation,
 * so the option means the same thing in every context.
 */

export interface SubjectReadOptions {
  /**
   * `'si'`: the rule's numeric operand is in SI base units (metres, square
   * metres, cubic metres), the way IDS states measure values. Each value is
   * converted to SI with its own unit (an explicit `Unit` on the property or
   * quantity, else the project unit for its measure type) before comparing.
   * Values with no unit (labels, counts) are compared as stored. Absent:
   * the operand is in the model's own units (#5225).
   */
  valueUnit?: 'si';
  /**
   * Where a missing value may come from (#5433). `'type'`: a quantity also
   * reads its type's quantity sets (properties always read their type's
   * property sets). `'aggregation'`: an element with no value of its own
   * (its type's included, for quantities too) takes the nearest
   * `IfcRelAggregates` ancestor's. Never implicit: absent
   * means the element's own (and, for properties, its type's) values only.
   */
  inherit?: 'type' | 'aggregation';
}

/** Whether `rule` has to be matched through the subject reader. */
export function readsThroughSubject(rule: SubjectReadOptions): boolean {
  return rule.valueUnit !== undefined || rule.inherit !== undefined;
}
