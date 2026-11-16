/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A finished flood check in the panel: the count per outcome (the same colours
 * as the viewport), the height-reference verdict, and everything the package
 * says the result must not be shown without: its warnings, the residual risk,
 * the publisher's disclaimer and limits, the source and the dataset date.
 * Those sit in disclosures, closed, but always present.
 */

import { BAFU_ATTRIBUTION, BAFU_DATASET_DATE, BAFU_DISCLAIMER, BAFU_LIMITS } from '@ifc-lite/flood-check';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { useViewerStore } from '@/store';
import { Checkbox } from '@/components/ui/checkbox';
import { formatFileSize } from '@/lib/recent-files';
import type { FloodCheckOutcomeData } from '@/store/slices/floodCheckSlice';
import { localized, OUTCOME_LABEL_KEY, OUTCOME_ORDER, outcomeCss } from '@/lib/flood-check/flood-verdicts';

function Disclosure({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <details className="text-2xs text-muted-foreground" data-testid={testId}>
      <summary className="cursor-pointer text-xs text-foreground">{title}</summary>
      <div className="mt-1 space-y-1">{children}</div>
    </details>
  );
}

export function FloodCheckSummary({ data }: { data: FloodCheckOutcomeData }) {
  const { t, locale } = useTranslation();
  const shown = useViewerStore((s) => s.floodColoursShown);
  const { result } = data;
  const total = result.results.length;
  const reference = result.heightReference;
  return (
    <div className="space-y-2" data-testid="flood-check-summary">
      <p className="text-xs text-foreground">{t('floodCheck.summary.checked', { count: formatLocaleNumber(locale, total) })}</p>
      <ul className="space-y-0.5">
        {OUTCOME_ORDER.map((outcome) => (
          <li key={outcome} className="flex items-center gap-2 text-xs" data-outcome={outcome}>
            <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: outcomeCss(outcome) }} />
            <span className={result.summary[outcome] === 0 ? 'text-muted-foreground' : 'text-foreground'}>{t(OUTCOME_LABEL_KEY[outcome])}</span>
            <span className="ml-auto font-mono">{formatLocaleNumber(locale, result.summary[outcome])}</span>
          </li>
        ))}
      </ul>
      {result.summary['no-runoff-mapped'] > 0 && <p className="text-2xs text-warn">{t('floodCheck.summary.noRunoffNotSafe')}</p>}
      <Checkbox checked={shown} onCheckedChange={(on) => useViewerStore.getState().setFloodColoursShown(on)} label={t('floodCheck.summary.showColours')} />
      <p className="text-2xs text-muted-foreground">{t('floodCheck.summary.selectHint')}</p>

      <p className={reference.status === 'confirmed' ? 'text-xs text-muted-foreground' : 'text-xs text-warn'} data-testid="flood-check-height-reference">
        {reference.status === 'confirmed'
          ? t('floodCheck.summary.heightConfirmed')
          : t('floodCheck.summary.heightUnconfirmed', { reasons: reference.unconfirmedBecause.join('; ') })}
      </p>

      <Disclosure title={t('floodCheck.summary.notes', { count: result.warnings.length + 1 })} testId="flood-check-notes">
        <p>{localized(result.caveat, locale)}</p>
        <p>{localized(reference.residualRisk, locale)}</p>
        <p className="font-mono">{result.margin.statement}</p>
        <ul className="list-disc pl-4 space-y-0.5">
          {result.warnings.map((warning, i) => <li key={i}>{warning}</li>)}
        </ul>
      </Disclosure>
      <Disclosure title={t('floodCheck.summary.disclaimer')} testId="flood-check-disclaimer">
        <p>{localized(BAFU_DISCLAIMER, locale)}</p>
        <ul className="list-disc pl-4 space-y-0.5">
          {BAFU_LIMITS.map((limit, i) => <li key={i}>{localized(limit, locale)}</li>)}
        </ul>
      </Disclosure>
      <p className="text-2xs text-muted-foreground" data-testid="flood-check-source">
        {t('floodCheck.summary.source', { source: BAFU_ATTRIBUTION, date: BAFU_DATASET_DATE })}
      </p>
      <p className="text-2xs text-muted-foreground">
        {t('floodCheck.summary.requests', { requests: formatLocaleNumber(locale, data.requests), size: formatFileSize(data.bytes) })}
      </p>
    </div>
  );
}
