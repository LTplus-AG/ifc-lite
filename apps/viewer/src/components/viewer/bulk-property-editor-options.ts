/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationKey } from '@/i18n';
import { selectPluralCategory } from '@/i18n/registry';

const PLURAL_SUFFIX = {
  zero: 'Zero',
  one: 'One',
  two: 'Two',
  few: 'Few',
  many: 'Many',
  other: 'Other',
} as const;

type AppliedResultKey = Extract<TranslationKey, `bulkPropertyEditor.applied${string}`>;

export function appliedResultKey(locale: string, mutations: number, entities: number): AppliedResultKey {
  const mutationCategory = PLURAL_SUFFIX[selectPluralCategory(locale, mutations)];
  const entityCategory = PLURAL_SUFFIX[selectPluralCategory(locale, entities)];
  return `bulkPropertyEditor.applied${mutationCategory}${entityCategory}` as AppliedResultKey;
}
