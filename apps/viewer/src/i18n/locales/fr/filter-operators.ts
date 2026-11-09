/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const filterOperatorsFr = {
  "filterOperators.in": "fait partie de",
  "filterOperators.notIn": "ne fait pas partie de",
  "filterOperators.eq": "=",
  "filterOperators.ne": "≠",
  "filterOperators.contains": "contient",
  "filterOperators.notContains": "ne contient pas",
  "filterOperators.startsWith": "commence par",
  "filterOperators.endsWith": "se termine par",
  "filterOperators.matches": "correspond à /regex/",
  "filterOperators.notMatches": "ne correspond pas à /regex/",
  "filterOperators.gt": ">",
  "filterOperators.gte": "≥",
  "filterOperators.lt": "<",
  "filterOperators.lte": "≤",
  "filterOperators.isSet": "est défini",
  "filterOperators.isNotSet": "n’est pas défini",
  "filterOperators.isNonEmpty": "n’est pas vide",
  "filterOperators.isNull": "est nul",
  "filterOperators.isNotNull": "n’est pas nul",
  "filterOperators.hasAny": "possède au moins un de",
  "filterOperators.hasAll": "possède tous les éléments de",
  "filterOperators.hasNone": "ne possède aucun de",
  "filterOperators.untagged": "est sans étiquette",
} satisfies Catalogue;
