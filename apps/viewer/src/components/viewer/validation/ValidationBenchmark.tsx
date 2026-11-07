/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** IDS and information-report rings use the manual report's exact SVG
 * renderer, including its segment colours, order and gaps (#6552). */
import { useTranslation } from '@/i18n';
import { reportRingCounts, requirementRingCounts, type ReportSummary } from '@/lib/validation/report-summary';
import type { ManualCounts } from '@/lib/validation/manual/checklist-summary';
import { RING_BUCKETS, ringSvg } from '@/lib/validation/manual/ring';
import { ManualValidationLegend } from './ManualValidationRing';

function BenchmarkRing({ counts, passRate, name, caption }: { counts: ManualCounts; passRate: number; name: string; caption?: string }) {
  const { t } = useTranslation();
  const label = counts.total === 0 ? t('manualValidation.ring.empty', { name })
    : t('manualValidation.ring.label', { name, pass: counts.pass, warning: counts.warning, fail: counts.fail, unanswered: counts.unanswered });
  return <figure className="m-0 flex w-20 shrink-0 flex-col items-center gap-1">
    <div className="relative h-20 w-20">
      <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(ringSvg(counts, 80))}`} width={80} height={80}
        alt={`${caption ? `${caption}: ` : ''}${label} · ${t('document.preview.idsReportPassRate')} ${passRate}%`} />
      <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm font-semibold" aria-hidden="true">{passRate}%</span>
    </div>
    {caption && <figcaption className="text-center text-2xs leading-tight">{caption}</figcaption>}
  </figure>;
}

export function ValidationBenchmark({ summary, name, paper = false, notCheckedSpecifications = 0, requirementChecks }: { summary: ReportSummary; name: string; paper?: boolean; notCheckedSpecifications?: number;
  /** An IDS report adds a requirement-check ring beside the entity ring (#8417). */
  requirementChecks?: { passed: number; total: number; rate: number } }) {
  const { t, locale } = useTranslation();
  const counts = reportRingCounts(summary);
  return <div className="my-2 flex flex-wrap items-center gap-4" data-validation-benchmark>
    <BenchmarkRing counts={counts} passRate={summary.passRate} name={name} caption={requirementChecks && t('idsPanel.entityResults')} />
    {requirementChecks && <BenchmarkRing counts={requirementRingCounts(requirementChecks)} passRate={requirementChecks.rate} name={name} caption={t('idsPanel.requirementChecks')} />}
    <div>
      {/* An engine report evaluates every applicable entity, so an empty
          "Not checked" entity row only contradicts the specification line (#8204). */}
      <ManualValidationLegend counts={counts} mutedClassName={paper ? 'text-neutral-600' : undefined}
        buckets={counts.unanswered === 0 ? RING_BUCKETS.filter((bucket) => bucket !== 'unanswered') : undefined} />
      {/* Zero-match specifications have no entities to put in the ring.
          Keep their unit explicit instead of inventing an unchecked entity. */}
      {notCheckedSpecifications > 0 && <p className="mt-1 text-xs text-muted-foreground">
        {t('idsPanel.unmatchedSpecifications', {
          count: notCheckedSpecifications, countDisplay: notCheckedSpecifications.toLocaleString(locale),
        })}
      </p>}
    </div>
  </div>;
}
