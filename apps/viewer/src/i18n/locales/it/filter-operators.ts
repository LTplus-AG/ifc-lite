/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const filterOperatorsIt = {
  "filterOperators.in": "è uno di",
  "filterOperators.notIn": "non è uno di",
  "filterOperators.eq": "=",
  "filterOperators.ne": "≠",
  "filterOperators.contains": "contiene",
  "filterOperators.notContains": "non contiene",
  "filterOperators.startsWith": "inizia con",
  "filterOperators.endsWith": "termina con",
  "filterOperators.matches": "corrisponde a /regex/",
  "filterOperators.notMatches": "non corrisponde a /regex/",
  "filterOperators.gt": ">",
  "filterOperators.gte": "≥",
  "filterOperators.lt": "<",
  "filterOperators.lte": "≤",
  "filterOperators.isSet": "è impostato",
  "filterOperators.isNotSet": "non è impostato",
  "filterOperators.isNonEmpty": "non è vuoto",
  "filterOperators.isNull": "è null",
  "filterOperators.isNotNull": "non è null",
  "filterOperators.hasAny": "contiene almeno uno di",
  "filterOperators.hasAll": "contiene tutti i valori di",
  "filterOperators.hasNone": "non contiene alcuno di",
  "filterOperators.untagged": "è senza etichetta"
} satisfies Catalogue;
