/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An IDS or information-validation report block on the preview sheet
 * (#5125, #6372): the same summary and check list the PDF prints
 * (`compose-ids-report.ts`), as HTML — mirrors `TablePreview.tsx`'s split
 * between "nothing to print" and rows.
 */
import { useTranslation } from '@/i18n';
import { localeCount } from '@/i18n/intlFormat';
import { reportBlockSourceKind, type IdsReportBlock, type IdsReportCardinality, type IdsReportCheckSummary } from '@/lib/document/types';
import { DOCUMENT_PREVIEW_MUTED_TEXT_CLASS } from './preview-theme';

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-start">
      <span className={`text-2xs uppercase tracking-wide ${DOCUMENT_PREVIEW_MUTED_TEXT_CLASS}`}>{label}</span>
      <span className="text-sm font-semibold">{value}</span>
    </div>
  );
}

type Translate = ReturnType<typeof useTranslation>['t'];

function cardinalityText(t: Translate, locale: string, cardinality: IdsReportCardinality): string {
  const fmt = (n: number) => n.toLocaleString(locale);
  const { min, max } = cardinality;
  const expected = min !== undefined && max !== undefined
    ? (min === max ? t('document.preview.idsReportCardinalityExactly', { min: fmt(min) }) : t('document.preview.idsReportCardinalityRange', { min: fmt(min), max: fmt(max) }))
    : min !== undefined ? t('document.preview.idsReportCardinalityAtLeast', { min: fmt(min) })
      : max !== undefined ? t('document.preview.idsReportCardinalityAtMost', { max: fmt(max) }) : '';
  const verdict = cardinality.passed ? t('document.preview.idsReportCardinalityMet') : t('document.preview.idsReportCardinalityNotMet');
  return [t('document.preview.idsReportCardinalityFound', { actual: fmt(cardinality.actual) }), expected, verdict].filter(Boolean).join(' · ');
}

/** A rule's cardinality and set rows (#6372), indented like IDS requirement rows. */
function RuleDetailRows({ check }: { check: IdsReportCheckSummary }) {
  const { t, locale } = useTranslation();
  const failedWord = check.severity === 'warning' ? t('document.preview.idsReportWarningTag') : t('document.preview.idsReportFailed');
  return (
    <>
      {check.cardinality && (
        <li className="text-2xs" data-ids-report-cardinality>
          <div className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 truncate font-medium">{t('document.preview.idsReportCardinality')}</span>
            <span className="shrink-0 text-neutral-600">{cardinalityText(t, locale, check.cardinality)}</span>
          </div>
        </li>
      )}
      {check.sets?.map((set, i) => {
        const name = set.groupKey === undefined ? set.label : `${set.label} · ${set.groupKey || t('document.preview.idsReportBlankGroup')}`;
        return (
          <li key={i} className="text-2xs" data-ids-report-set>
            <div className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate font-medium" title={name}>{name}</span>
              <span className="shrink-0 text-neutral-600">
                {t('document.preview.idsReportSetCounts', { actual: set.actual, expected: set.expected })} · {set.passed ? t('document.preview.idsReportPassed') : failedWord}
              </span>
            </div>
          </li>
        );
      })}
      {check.setsTruncated && <li className="text-2xs text-neutral-500">{t('document.preview.idsReportSetsTruncated')}</li>}
    </>
  );
}

export interface IdsReportPreviewProps {
  block: IdsReportBlock;
}

export function IdsReportPreview({ block }: IdsReportPreviewProps) {
  const { t, locale } = useTranslation();
  const { checked, passed, failed, passRate, warnings } = block.summary;
  const heading = reportBlockSourceKind(block) === 'rules'
    ? t('document.preview.rulesReportHeading', { name: block.sourceName })
    : t('document.preview.idsReportHeading', { name: block.sourceName });

  return (
    <div data-block-ids-report data-source-kind={reportBlockSourceKind(block)}>
      <div className="truncate text-sm font-semibold" title={heading}>{heading}</div>
      <div className={`text-2xs ${DOCUMENT_PREVIEW_MUTED_TEXT_CLASS}`}>
        {t('document.preview.idsReportGeneratedAt', { timestamp: block.generatedAt })}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 rounded border border-neutral-200 bg-neutral-50 px-2 py-1.5">
        <Stat label={t('document.preview.idsReportChecked')} value={checked.toLocaleString(locale)} />
        <Stat label={t('document.preview.idsReportPassed')} value={passed.toLocaleString(locale)} />
        <Stat label={t('document.preview.idsReportFailed')} value={failed.toLocaleString(locale)} />
        {warnings !== undefined && <Stat label={t('document.preview.idsReportWarnings')} value={warnings.toLocaleString(locale)} />}
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
        <ul className="mt-1 flex flex-col gap-1" data-ids-report-checks={block.checks.length}>
          {block.checks.map((check) => {
            const hasChildren = check.rules.length > 0 || !!check.cardinality || (check.sets?.length ?? 0) > 0 || !!check.setsTruncated;
            return (
              <li key={check.id} className="rounded border border-neutral-200 px-2 py-1" data-ids-report-check={check.id}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-xs font-semibold" title={check.shortDescription}>{check.shortDescription}</span>
                  {check.error !== undefined ? (
                    <span className="min-w-0 truncate text-2xs text-red-700" title={check.error} data-ids-report-error>
                      {t('document.preview.idsReportError', { error: check.error })}
                    </span>
                  ) : (
                    <span className="shrink-0 text-2xs text-neutral-600">
                      {check.severity === 'warning' && (
                        <span className="mr-1 rounded bg-amber-100 px-1 font-semibold text-amber-900" data-ids-report-warning>{t('document.preview.idsReportWarningTag')}</span>
                      )}
                      {check.checked.toLocaleString(locale)} · {check.passed.toLocaleString(locale)} / {check.failed.toLocaleString(locale)} · {check.passRate}%
                    </span>
                  )}
                </div>
                {check.longDescription && <div className="truncate text-2xs text-neutral-500" title={check.longDescription}>{check.longDescription}</div>}
                {hasChildren && (
                  <ul className="mt-1 ml-3 space-y-1 border-l border-neutral-200 pl-2" data-ids-report-rules={check.rules.length}>
                    {check.rules.map((rule) => (
                      <li key={rule.id} className="text-2xs">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="min-w-0 truncate font-medium" title={rule.shortDescription}>{rule.shortDescription}</span>
                          <span className="shrink-0 text-neutral-600">
                            {rule.checked.toLocaleString(locale)} · {rule.passRate === null
                              ? t('document.preview.idsReportCountsUnavailable')
                              : `${rule.passed?.toLocaleString(locale)} / ${rule.failed?.toLocaleString(locale)} · ${rule.passRate}%`}
                          </span>
                        </div>
                        {rule.longDescription && <div className="truncate text-neutral-500" title={rule.longDescription}>{rule.longDescription}</div>}
                      </li>
                    ))}
                    <RuleDetailRows check={check} />
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
