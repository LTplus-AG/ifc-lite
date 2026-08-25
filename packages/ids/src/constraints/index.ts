/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Constraint matching utilities for IDS validation
 */

import type { IDSConstraint } from '../types.js';

import { conjunctiveFacetsOf, matchOneFamily } from './match-family.js';

/** Options for constraint matching */
export interface MatchOptions {
  /**
   * If true, use case-insensitive comparison for string values.
   * Per IDS 1.0 spec, only entity type names and predefined types
   * should be compared case-insensitively. All other values
   * (property values, classification values, etc.) are case-sensitive.
   */
  caseInsensitive?: boolean;
}

/**
 * Check if a value matches a constraint
 */
export function matchConstraint(
  constraint: IDSConstraint,
  actualValue: string | number | boolean | null | undefined,
  options?: MatchOptions
): boolean {
  if (actualValue === null || actualValue === undefined) {
    return false;
  }

  const ci = options?.caseInsensitive ?? false;

  if (!matchOneFamily(constraint, actualValue, ci)) return false;

  // XSD facets declared in the same `<xs:restriction>` are conjunctive.
  // `parseRestriction` keeps the first family as the constraint itself
  // and hangs the others here; a value has to satisfy all of them. The
  // overwhelmingly common restriction declares one family and leaves
  // `and` undefined, so this costs one property read.
  const siblings = conjunctiveFacetsOf(constraint);
  if (siblings === undefined) return true;
  for (const sibling of siblings) {
    if (!matchOneFamily(sibling, actualValue, ci)) return false;
  }
  return true;
}


export {
  getConstraintMismatchReason,
  formatConstraint,
} from './describe.js';
