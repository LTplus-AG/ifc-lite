/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/** Exact-record labels added to the existing relationships properties card. */
export const relationshipCardEn = {
  'relationshipCard.exactRecords': 'Relationship Records ({count})',
  'relationshipCard.showMore': 'Show {count} more',
} as const satisfies Record<string, TranslationValue>;
