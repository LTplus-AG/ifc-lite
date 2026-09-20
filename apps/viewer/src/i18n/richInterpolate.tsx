/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react';
import type { TranslationKey, TranslationParameters } from '@/i18n';

type TFunction = (key: TranslationKey, params?: TranslationParameters) => string;
type RichReplacement = readonly [parameter: string, styled: ReactNode];

/** Resolve one complete message while preserving exact placeholder boundaries. */
export function styleInterpolatedValues(
  t: TFunction,
  key: TranslationKey,
  replacements: readonly RichReplacement[],
  parameters: TranslationParameters = {},
): ReactNode[] {
  const markers = replacements.map((_, index) => `\uE000${index}\uE001`);
  const richParameters = Object.fromEntries(
    replacements.map(([parameter], index) => [parameter, markers[index]]),
  );
  const resolved = t(key, { ...parameters, ...richParameters });
  return resolved.split(/(\uE000\d+\uE001)/g).filter(Boolean).map((part) => {
    const index = markers.indexOf(part);
    return index === -1 ? part : replacements[index][1];
  });
}
