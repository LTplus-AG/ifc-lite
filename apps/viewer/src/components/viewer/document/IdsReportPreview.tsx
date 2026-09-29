/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An IDS report block on the preview sheet (#5125): the same summary and
 * top-level check list the PDF prints (`compose-ids-report.ts`), as HTML —
 * mirrors `TablePreview.tsx`'s split between "nothing to print" and rows.
 */
import { passRateBand } from '@ifc-lite/ids';
import { useTranslation } from '@/i18n';
import { localeCount } from '@/i18n/intlFormat';
import type { IdsReportBlock } from '@/lib/document/types';
import { DOCUMENT_PREVIEW_MUTED_TEXT_CLASS } from './preview-theme';

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-start">
      <span className={`text-2xs uppercase tracking-wide ${DOCUMENT_PREVIEW_MUTED_TEXT_CLASS}`}>{label}</span>
      <span className="text-sm font-semibold">{value}</span>
    </div>
  );
}

const BAND_CLASS = { good: 'bg-green-500', warn: 'bg-yellow-500', bad: 'bg-red-500' } as const;

/** A coloured percent bar (#6470); `rate` null (partial report) draws the empty track only. */
function RateBar({ rate }: { rate: number | null }) {
  return (
    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-200" data-ids-report-bar={rate ?? 'unavailable'}>
      {rate !== null && <div className={`h-full rounded-full ${BAND_CLASS[passRateBand(rate)]}`} style={{ width: `${rate}%` }} />}
    </div>
  );
}

/** Compact row: name, bar and percent on one line, nothing else. */
function CompactRow({ name, passed, checked, rate, nested }: { name: string; passed: number | null; checked: number; rate: number | null; nested?: boolean }) {
  const { t, locale } = useTranslation();
  return (
    <li className={`flex items-center gap-2 ${nested ? 'text-2xs' : 'text-xs font-medium'}`} data-ids-report-row>
      <span className="w-2/5 min-w-0 truncate" title={name}>{name}</span>
      <RateBar rate={rate} />
      <span className="w-24 shrink-0 text-right text-neutral-600">
        {rate === null ? t('document.preview.idsReportCountsUnavailableShort') : `${(passed ?? 0).toLocaleString(locale)}/${checked.toLocaleString(locale)} · ${rate}%`}
      </span>
    </li>
  );
}

function CompactChecks({ block }: { block: IdsReportBlock }) {
  return (
    <ul className="mt-1 flex flex-col gap-1" data-ids-report-checks={block.checks.length} data-ids-report-variant="compact">
      {block.checks.flatMap((check) => [
        <CompactRow key={check.id} name={check.shortDescription || check.id} passed={check.passed} checked={check.checked} rate={check.passRate} />,
        ...check.rules.map((rule) => (
          <CompactRow key={`${check.id}/${rule.id}`} nested name={rule.name ?? (rule.shortDescription || rule.id)} passed={rule.passed} checked={rule.checked} rate={rule.passRate} />
        )),
      ])}
    </ul>
  );
}

export interface IdsReportPreviewProps {
  block: IdsReportBlock;
}

export function IdsReportPreview({ block }: IdsReportPreviewProps) {
  const { t, locale } = useTranslation();
  const { checked, passed, failed, passRate } = block.summary;
  // Long keeps the classic structure but never cuts text (#6470); a document saved before variants existed keeps its truncated rows.
  const cut = block.variant === 'long' ? 'break-words' : 'truncate';

  return (
    <div data-block-ids-report>
      <div className="truncate text-sm font-semibold" title={block.sourceName}>{block.sourceName}</div>
      <div className={`text-2xs ${DOCUMENT_PREVIEW_MUTED_TEXT_CLASS}`}>
        {t('document.preview.idsReportGeneratedAt', { timestamp: block.generatedAt })}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 rounded border border-neutral-200 bg-neutral-50 px-2 py-1.5">
        <Stat label={t('document.preview.idsReportChecked')} value={checked.toLocaleString(locale)} />
        <Stat label={t('document.preview.idsReportPassed')} value={passed.toLocaleString(locale)} />
        <Stat label={t('document.preview.idsReportFailed')} value={failed.toLocaleString(locale)} />
        <Stat label={t('document.preview.idsReportPassRate')} value={`${passRate}%`} />
      </div>
      <div className={`mt-1.5 text-2xs ${DOCUMENT_PREVIEW_MUTED_TEXT_CLASS}`}>
        {t('document.preview.idsReportChecksCount', localeCount(locale, block.checks.length))}
      </div>
      {block.checks.length === 0 ? (
        <div className="mt-1 rounded border border-dashed border-neutral-300 px-3 py-2 text-xs text-neutral-500">
          {t('document.preview.idsReportNoChecks')}
        </div>
      ) : (
        block.variant === 'compact' ? <CompactChecks block={block} /> : <ul className="mt-1 flex flex-col gap-1" data-ids-report-checks={block.checks.length}>
          {block.checks.map((check) => (
            <li key={check.id} className="rounded border border-neutral-200 px-2 py-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className={`min-w-0 ${cut} text-xs font-semibold`} title={check.shortDescription}>{check.shortDescription}</span>
                <span className="shrink-0 text-2xs text-neutral-600">
                  {check.checked.toLocaleString(locale)} · {check.passed.toLocaleString(locale)} / {check.failed.toLocaleString(locale)} · {check.passRate}%
                </span>
              </div>
              {check.longDescription && <div className={`${cut} text-2xs text-neutral-500`} title={check.longDescription}>{check.longDescription}</div>}
              {check.rules.length > 0 && (
                <ul className="mt-1 ml-3 space-y-1 border-l border-neutral-200 pl-2" data-ids-report-rules={check.rules.length}>
                  {check.rules.map((rule) => (
                    <li key={rule.id} className="text-2xs">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className={`min-w-0 ${cut} font-medium`} title={rule.shortDescription}>{rule.shortDescription}</span>
                        <span className="shrink-0 text-neutral-600">
                          {rule.checked.toLocaleString(locale)} · {rule.passRate === null
                            ? t('document.preview.idsReportCountsUnavailable')
                            : `${rule.passed?.toLocaleString(locale)} / ${rule.failed?.toLocaleString(locale)} · ${rule.passRate}%`}
                        </span>
                      </div>
                      {rule.longDescription && <div className={`${cut} text-neutral-500`} title={rule.longDescription}>{rule.longDescription}</div>}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
