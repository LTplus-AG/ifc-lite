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

/** Read options only a `property` rule or subject takes. */
export interface PropertyReadOptions extends SubjectReadOptions {
  /**
   * The member of an `IfcComplexProperty` to read, by `Name`, one entry per
   * nesting level: `['Width']`, or `['Frame', 'Width']` for a member of a
   * nested complex property (#5475). Names compare case-insensitively, like
   * property names. A property that is not complex, or has no such member,
   * reads as absent. Absent: a complex property reads as its members'
   * joined text.
   */
  memberPath?: string[];
}

/** Whether `rule` has to be matched through the subject reader. */
export function readsThroughSubject(rule: PropertyReadOptions): boolean {
  return rule.valueUnit !== undefined || rule.inherit !== undefined || rule.memberPath !== undefined;
}

/** A `memberPath` a rule or subject may carry: a non-empty list of non-empty names. */
export function isMemberPath(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((s) => typeof s === 'string' && s.length > 0);
}

/** How a `memberPath` reads in a label: ` › Frame › Width`, or `''` without one. */
export function memberPathLabel(memberPath: readonly string[] | undefined): string {
  return (memberPath ?? []).map((name) => ` › ${name}`).join('');
}
