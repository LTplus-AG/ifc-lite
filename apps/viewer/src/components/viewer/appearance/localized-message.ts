/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { TranslationKey, TranslationParameters } from '@/i18n';

export type LocalizedMessage =
  | { kind: 'translated'; key: TranslationKey; params?: TranslationParameters }
  | { kind: 'raw'; text: string };

export const translatedMessage = (key: TranslationKey, params?: TranslationParameters): LocalizedMessage =>
  ({ kind: 'translated', key, params });

export const rawMessage = (error: unknown): LocalizedMessage =>
  ({ kind: 'raw', text: error instanceof Error ? error.message : String(error) });

export function resolveLocalizedMessage(
  value: string | LocalizedMessage | undefined,
  t: (key: TranslationKey, params?: TranslationParameters) => string,
): string | undefined {
  if (!value || typeof value === 'string') return value;
  return value.kind === 'translated' ? t(value.key, value.params) : value.text;
}
