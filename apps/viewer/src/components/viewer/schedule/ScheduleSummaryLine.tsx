/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react';
import { useTranslation } from '@/i18n';

const MARKERS = {
  groups: '\uE000groups\uE001',
  products: '\uE000products\uE001',
  date: '\uE000date\uE001',
} as const;
const MARKER_PATTERN = /(\uE000(?:groups|products|date)\uE001)/;

interface ScheduleSummaryLineProps {
  groups: string;
  products: string;
  date: string;
}

/** Preserve translator-controlled word order while styling interpolated values. */
export function ScheduleSummaryLine({ groups, products, date }: ScheduleSummaryLineProps) {
  const { t } = useTranslation();
  const translated = t('schedule.generateDialog.summaryLine', MARKERS);
  const values: Record<string, ReactNode> = {
    [MARKERS.groups]: <span className="font-semibold">{groups}</span>,
    [MARKERS.products]: <span className="font-semibold">{products}</span>,
    [MARKERS.date]: <span className="font-mono">{date}</span>,
  };
  return <p>{translated.split(MARKER_PATTERN).map((part, index) =>
    part in values ? <span key={index}>{values[part]}</span> : part)}</p>;
}
