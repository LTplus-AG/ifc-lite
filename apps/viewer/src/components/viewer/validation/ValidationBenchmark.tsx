/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** IDS and information-report rings use the manual report's exact SVG
 * renderer, including its segment colours, order and gaps (#6552). */
import { useTranslation } from '@/i18n';
import { reportRingCounts, type ReportSummary } from '@/lib/validation/report-summary';
import { ringSvg } from '@/lib/validation/manual/ring';
import { ManualValidationLegend } from './ManualValidationRing';

export function ValidationBenchmark({ summary, name, paper = false }: { summary: ReportSummary; name: string; paper?: boolean }) {
  const { t } = useTranslation();
  const counts = reportRingCounts(summary);
  const label = counts.total === 0 ? t('manualValidation.ring.empty', { name })
    : t('manualValidation.ring.label', { name, pass: counts.pass, warning: counts.warning, fail: counts.fail, unanswered: counts.unanswered });
  const rate = t('document.preview.idsReportPassRate');
  return <div className="my-2 flex items-center gap-4" data-validation-benchmark>
    <div className="relative h-20 w-20 shrink-0">
      <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(ringSvg(counts, 80))}`} width={80} height={80}
        alt={`${label} · ${rate} ${summary.passRate}%`} />
      <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm font-semibold" aria-hidden="true">{summary.passRate}%</span>
    </div>
    <ManualValidationLegend counts={counts} mutedClassName={paper ? 'text-neutral-600' : undefined} />
  </div>;
}
