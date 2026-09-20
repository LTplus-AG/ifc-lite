/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationKey } from './en';

export type TranslationParameter = string | number;
export type TranslationParameters = Readonly<Record<string, TranslationParameter>>;

/**
 * A stable, catalogued message carried through plain data — a resolver
 * result, store state — and translated only where it is rendered, via
 * `t(message.labelKey, message.params)`. Never call `t()` inside a data
 * module (per the i18n brief). First producer: `resolveValidationTarget.ts`'s
 * error branch; first (and so far only) consumer: `IDSPanel.tsx`'s error
 * banner via `useIDS.ts`'s `idsError` (#5030, thread PRRT_kwDOQ3UF-86kFTqB).
 */
export interface TranslatableMessage {
  labelKey: TranslationKey;
  params?: TranslationParameters;
}

export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';
export type PluralTranslation = Readonly<
  { other: string } & Partial<Record<PluralCategory, string>>
>;
export type TranslationValue = string | PluralTranslation;
