/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const filterOperatorsDe = {
  "filterOperators.in": "ist eines von",
  "filterOperators.notIn": "ist keines von",
  "filterOperators.eq": "=",
  "filterOperators.ne": "≠",
  "filterOperators.contains": "enthält",
  "filterOperators.notContains": "enthält nicht",
  "filterOperators.startsWith": "beginnt mit",
  "filterOperators.endsWith": "endet mit",
  "filterOperators.matches": "entspricht /regex/",
  "filterOperators.notMatches": "entspricht nicht /regex/",
  "filterOperators.gt": ">",
  "filterOperators.gte": "≥",
  "filterOperators.lt": "<",
  "filterOperators.lte": "≤",
  "filterOperators.isSet": "ist gesetzt",
  "filterOperators.isNotSet": "ist nicht gesetzt",
  "filterOperators.isNonEmpty": "ist nicht leer",
  "filterOperators.isNull": "ist null",
  "filterOperators.isNotNull": "ist nicht null",
  "filterOperators.hasAny": "hat eines von",
  "filterOperators.hasAll": "hat alle von",
  "filterOperators.hasNone": "hat keines von",
  "filterOperators.untagged": "hat keine Tags"
} satisfies Catalogue;
