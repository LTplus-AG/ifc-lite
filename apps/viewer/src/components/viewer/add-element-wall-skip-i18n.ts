/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationKey } from '@/i18n';

const WALL_SKIP_REASON_KEYS = {
  'no-source-bytes': 'addElement.auto.skipReason.noSourceBytes',
  'wall-not-parsed': 'addElement.auto.skipReason.wallNotParsed',
  'no-placement': 'addElement.auto.skipReason.noPlacement',
  'no-representation': 'addElement.auto.skipReason.noRepresentation',
  'placement-not-resolvable': 'addElement.auto.skipReason.placementNotResolvable',
  'no-axis-or-rect-profile': 'addElement.auto.skipReason.noAxisOrRectProfile',
  'zero-length-axis': 'addElement.auto.skipReason.zeroLengthAxis',
  'sloped-axis': 'addElement.auto.skipReason.slopedAxis',
} as const satisfies Record<string, TranslationKey>;

type Translate = (key: TranslationKey, params?: Readonly<Record<string, string | number>>) => string;

export function formatWallSkipReasons(t: Translate, locale: string, reasons: Record<string, number>): string {
  const entries = Object.entries(reasons).map(([reason, count]) => {
    const key = Object.hasOwn(WALL_SKIP_REASON_KEYS, reason)
      ? WALL_SKIP_REASON_KEYS[reason as keyof typeof WALL_SKIP_REASON_KEYS]
      : null;
    const label = key ? t(key) : t('addElement.auto.skipReason.unknown', { reason });
    return t('addElement.auto.skipReasonCount', { count, reason: label });
  });
  try {
    return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(entries);
  } catch (error) {
    console.warn(`[i18n] Invalid locale "${locale}" for wall-skip list formatting; using English.`, error);
    return new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(entries);
  }
}
