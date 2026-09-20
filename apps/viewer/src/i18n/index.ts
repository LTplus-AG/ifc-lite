/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export { useTranslation } from './useTranslation';
export type { UseTranslationResult } from './useTranslation';
export { registerLocale, setLocale, getLocale } from './registry';
export { formatLocaleNumber, localeCount, parseLocaleNumber } from './intlFormat';
export type { TranslationKey } from './en';
export type { Locale, Catalogue } from './registry';
export type { PluralCategory, PluralTranslation, TranslatableMessage, TranslationParameter, TranslationParameters, TranslationValue } from './types';
