/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `useTranslation` (#4785): the hook components call to read catalogue
 * strings. Subscribes to the locale registry via `useSyncExternalStore`
 * so a `setLocale` call re-renders every mounted consumer.
 */
import { useSyncExternalStore } from 'react';
import { getLocale, getLocaleSnapshot, resolve, subscribeLocale } from './registry';
import type { TranslationKey } from './en';
import type { TranslationParameters } from './types';

export interface UseTranslationResult {
  t: (key: TranslationKey, params?: TranslationParameters) => string;
  locale: string;
  localeSnapshot: string;
}

export function useTranslation(): UseTranslationResult {
  const localeSnapshot = useSyncExternalStore(subscribeLocale, getLocaleSnapshot, getLocaleSnapshot);
  return { t: resolve, locale: getLocale(), localeSnapshot };
}
