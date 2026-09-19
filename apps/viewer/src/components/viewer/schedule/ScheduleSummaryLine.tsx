/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react';
import { useTranslation, type PluralCategory, type TranslationKey } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { hasActiveTranslation, resolveEnglish, selectPluralCategory } from '@/i18n/registry';

const MARKERS = {
  groups: '\uE000groups\uE001',
  products: '\uE000products\uE001',
  date: '\uE000date\uE001',
} as const;
const MARKER_PATTERN = /(\uE000(?:groups|products|date)\uE001)/;

interface ScheduleSummaryLineProps {
  groupCount: number;
  productCount: number;
  date: string;
}

const GROUP_SUMMARY_KEYS: Record<PluralCategory, TranslationKey> = {
  zero: 'schedule.generateDialog.summaryLineGroupsZero',
  one: 'schedule.generateDialog.summaryLineGroupsOne',
  two: 'schedule.generateDialog.summaryLineGroupsTwo',
  few: 'schedule.generateDialog.summaryLineGroupsFew',
  many: 'schedule.generateDialog.summaryLineGroupsMany',
  other: 'schedule.generateDialog.summaryLineGroupsOther',
};

/** Preserve translator-controlled word order while styling interpolated values. */
export function ScheduleSummaryLine({ groupCount, productCount, date }: ScheduleSummaryLineProps) {
  const { t, locale } = useTranslation();
  const localeCategory = selectPluralCategory(locale, groupCount);
  const localeKey = GROUP_SUMMARY_KEYS[localeCategory];
  const params = { ...MARKERS, count: productCount };
  const translated = hasActiveTranslation(localeKey)
    ? t(localeKey, params)
    : resolveEnglish(GROUP_SUMMARY_KEYS[selectPluralCategory('en', groupCount)], params);
  const values: Record<string, ReactNode> = {
    [MARKERS.groups]: <span className="font-semibold">{formatLocaleNumber(locale, groupCount)}</span>,
    [MARKERS.products]: <span className="font-semibold">{formatLocaleNumber(locale, productCount)}</span>,
    [MARKERS.date]: <span className="font-mono">{date}</span>,
  };
  return <p>{translated.split(MARKER_PATTERN).map((part, index) =>
    part in values ? <span key={index}>{values[part]}</span> : part)}</p>;
}
