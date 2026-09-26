/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The one vocabulary shown for filter comparisons across viewer editors (#5892). */
export const filterOperatorsEn = {
  'filterOperators.in': 'is one of',
  'filterOperators.notIn': 'is not one of',
  'filterOperators.eq': '=',
  'filterOperators.ne': '≠',
  'filterOperators.contains': 'contains',
  'filterOperators.notContains': 'does not contain',
  'filterOperators.startsWith': 'starts with',
  'filterOperators.endsWith': 'ends with',
  'filterOperators.matches': 'matches /regex/',
  'filterOperators.notMatches': 'does not match /regex/',
  'filterOperators.gt': '>',
  'filterOperators.gte': '≥',
  'filterOperators.lt': '<',
  'filterOperators.lte': '≤',
  'filterOperators.isSet': 'is set',
  'filterOperators.isNotSet': 'is not set',
  'filterOperators.isNonEmpty': 'is not empty',
  'filterOperators.isNull': 'is null',
  'filterOperators.isNotNull': 'is not null',
  'filterOperators.hasAny': 'has any of',
  'filterOperators.hasAll': 'has all of',
  'filterOperators.hasNone': 'has none of',
  'filterOperators.untagged': 'is untagged',
} as const;
