/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo } from 'react';
import type { ValidationReport } from '@ifc-lite/ids';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { idsCheckSummary } from '@/lib/validation/ids-check-summary';
import { PassRateBar } from './IDSPanelStatus';

export function IDSCheckSummary({ report }: { report: ValidationReport }) {
  const { t, locale } = useTranslation();
  const summary = useMemo(() => idsCheckSummary(report), [report]);
  if (!summary) return null;
  const number = (value: number) => formatLocaleNumber(locale, value);
  return <section className="mb-3 text-xs" aria-label={t('idsPanel.requirementChecks')}>
    <div className="font-medium mb-1">{t('idsPanel.requirementChecks')}</div>
    <p>{t('idsPanel.requirementsPassed', { passed: number(summary.passedRequirements), total: number(summary.requirements) })}</p>
    <p>{summary.checked > 0
      ? t('idsPanel.checksPassed', { passed: number(summary.passed), total: number(summary.checked),
        rate: formatLocaleNumber(locale, summary.passRate / 100, { style: 'percent' }) })
      : t('idsPanel.noRequirementChecks')}</p>
    {summary.checked > 0 && <div className="mt-1"><PassRateBar passRate={summary.passRate} /></div>}
  </section>;
}
