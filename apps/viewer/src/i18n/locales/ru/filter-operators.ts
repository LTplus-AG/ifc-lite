/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const filterOperatorsRu = {
  "filterOperators.in": "является одним из",
  "filterOperators.notIn": "не является одним из",
  "filterOperators.eq": "=",
  "filterOperators.ne": "≠",
  "filterOperators.contains": "содержит",
  "filterOperators.notContains": "не содержит",
  "filterOperators.startsWith": "начинается с",
  "filterOperators.endsWith": "заканчивается на",
  "filterOperators.matches": "соответствует /regex/",
  "filterOperators.notMatches": "не соответствует /regex/",
  "filterOperators.gt": ">",
  "filterOperators.gte": "≥",
  "filterOperators.lt": "<",
  "filterOperators.lte": "≤",
  "filterOperators.isSet": "задано",
  "filterOperators.isNotSet": "не задано",
  "filterOperators.isNonEmpty": "не пуст",
  "filterOperators.isNull": "равно null",
  "filterOperators.isNotNull": "не равно null",
  "filterOperators.hasAny": "имеет какой-либо из",
  "filterOperators.hasAll": "имеет все",
  "filterOperators.hasNone": "не имеет ни одного из",
  "filterOperators.untagged": "не имеет меток",
} satisfies Catalogue;
