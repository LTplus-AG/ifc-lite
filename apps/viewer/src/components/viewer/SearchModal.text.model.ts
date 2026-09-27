/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SearchResult } from '@/lib/search/tier0-scan';
import type { SearchFieldFilter } from '@/store/slices/searchSlice';
import type { TranslationKey } from '@/i18n';

export const ROW_HEIGHT = 36;

export const FIELD_FILTERS: { value: SearchFieldFilter; labelKey: TranslationKey }[] = [
  { value: 'all', labelKey: 'searchModal.text.fieldAll' },
  { value: 'name', labelKey: 'searchModal.text.fieldName' },
  { value: 'type', labelKey: 'searchModal.text.fieldType' },
  { value: 'globalId', labelKey: 'searchModal.text.fieldGuid' },
  { value: 'description', labelKey: 'searchModal.text.fieldDescription' },
  { value: 'objectType', labelKey: 'searchModal.text.fieldObjectType' },
];

export interface SearchModalTextProps {
  /** Full result pool from the parent modal (before filter chips). */
  results: SearchResult[];
  /** All modelIds currently loaded (for the model-filter chips). */
  availableModelIds: readonly string[];
  /** Close the parent modal — invoked on Enter-commit from a row. */
  onClose: () => void;
}

export const resultOptionId = (result: SearchResult): string => `search-result-${result.modelId}-${result.expressId}`;
