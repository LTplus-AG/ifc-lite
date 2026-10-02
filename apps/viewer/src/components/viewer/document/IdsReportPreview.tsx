/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An IDS or information-validation report block on the preview sheet
 * (#5125, #6372): the same summary and check list the PDF prints
 * (`compose-ids-report.ts`), as HTML — mirrors `TablePreview.tsx`'s split
 * between "nothing to print" and rows.
 */
import { blockTitle } from '@/lib/document/block-title';
import { ValidationBenchmark } from '../validation/ValidationBenchmark';
import { passRateBand } from '@ifc-lite/ids';
import { reportStamp } from '@/lib/document/report-provenance';
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

const BAND_CLASS = { good: 'bg-green-500', warn: 'bg-yellow-500', bad: 'bg-red-500' } as const;

/** A coloured percent bar (#6470); `rate` null (partial report) draws the empty track only. */
function RateBar({ rate }: { rate: number | null }) {
  return (
    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-200" data-ids-report-bar={rate ?? 'unavailable'}>
      {rate !== null && <div className={`h-full rounded-full ${BAND_CLASS[passRateBand(rate)]}`} style={{ width: `${rate}%` }} />}
    </div>
  );
}

/** Compact row: name, bar and percent on one line, nothing else. `error` replaces the bar when a check could not be evaluated. */
function CompactRow({ name, passed, checked, rate, nested, error, warning }: { name: string; passed: number | null; checked: number; rate: number | null; nested?: boolean; error?: string; warning?: boolean }) {
  const { t, locale } = useTranslation();
  return (
    <li className={`flex items-center gap-2 ${nested ? 'text-2xs' : 'text-xs font-semibold'}`} data-ids-report-row>
      <span className="w-2/5 min-w-0 truncate" title={name}>
        {warning && <span className="mr-1 rounded bg-amber-100 px-1 font-semibold text-amber-900" data-ids-report-warning>{t('document.preview.idsReportWarningTag')}</span>}
        {name}
      </span>
      {error !== undefined ? (
        <span className="min-w-0 flex-1 truncate text-2xs text-red-700" title={error} data-ids-report-error>{t('document.preview.idsReportError', { error })}</span>
      ) : (
        <>
          <RateBar rate={rate} />
          <span className="w-24 shrink-0 text-right text-neutral-600">
            {rate === null ? t('document.preview.idsReportCountsUnavailableShort') : `${(passed ?? 0).toLocaleString(locale)}/${checked.toLocaleString(locale)} · ${rate}%`}
          </span>
        </>
      )}
    </li>
  );
}

function CompactChecks({ block }: { block: IdsReportBlock }) {
  return (
    <ul className="mt-1 flex flex-col gap-2.5" data-ids-report-checks={block.checks.length} data-ids-report-variant="compact">
      {/* A specification heads a group; its requirements sit indented under a rule, as the PDF indents them (#6550). */}
      {block.checks.map((check) => (
        <li key={check.id} className="list-none" data-ids-report-spec={check.id}>
          <ul className="flex flex-col gap-1">
            <CompactRow name={check.shortDescription || check.id} passed={check.passed} checked={check.checked} rate={check.passRate} error={check.error} warning={check.severity === 'warning'} />
            {!block.specificationsOnly && (check.rules.length > 0 || !!check.cardinality || (check.sets?.length ?? 0) > 0 || !!check.setsTruncated) && (
              <li className="ml-3 list-none border-l border-neutral-200 pl-2">
                <ul className="flex flex-col gap-1" data-ids-report-requirements={check.rules.length}>
                  {check.rules.map((rule) => (
                    <CompactRow key={rule.id} nested name={rule.name ?? (rule.shortDescription || rule.id)} passed={rule.passed} checked={rule.checked} rate={rule.passRate} />
                  ))}
                  <RuleDetailRows check={check} />
                </ul>
              </li>
            )}
          </ul>
        </li>
      ))}
    </ul>
  );
}

export interface IdsReportPreviewProps {
  block: IdsReportBlock;
}

export function IdsReportPreview({ block }: IdsReportPreviewProps) {
  const { t, locale } = useTranslation();
  const { checked, passed, failed, passRate, warnings } = block.summary;
  // Long keeps the classic structure but never cuts text (#6470); a document saved before variants existed keeps its truncated rows.
  const cut = block.variant === 'long' ? 'break-words' : 'truncate';
  const heading = blockTitle(block, reportBlockSourceKind(block) === 'rules'
    ? t('document.preview.rulesReportHeading', { name: block.sourceName })
    : t('document.preview.idsReportHeading', { name: block.sourceName }));

  const stamp = reportStamp(block);

  return (
    <div data-block-ids-report data-source-kind={reportBlockSourceKind(block)}>
      <div className="truncate text-sm font-semibold" title={heading}>{heading}</div>
      {stamp && <>
        <div className={`text-2xs ${DOCUMENT_PREVIEW_MUTED_TEXT_CLASS}`}>
          {t('document.preview.idsReportGeneratedAt', { timestamp: stamp.generatedAt })}
        </div>
        {stamp.models && <div className="text-2xs text-neutral-600" data-report-model-scope>{t('validationPanel.history.models', { models: stamp.models })}</div>}
      </>}
      {block.benchmarks && <ValidationBenchmark summary={block.summary} name={block.sourceName} paper />}
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
      ) : block.variant === 'compact' ? <CompactChecks block={block} /> : (
        <ul className="mt-1 flex flex-col gap-1" data-ids-report-checks={block.checks.length}>
          {block.checks.map((check) => {
            const hasChildren = check.rules.length > 0 || !!check.cardinality || (check.sets?.length ?? 0) > 0 || !!check.setsTruncated;
            return (
              <li key={check.id} className="rounded border border-neutral-200 px-2 py-1" data-ids-report-check={check.id}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className={`min-w-0 ${cut} text-xs font-semibold`} title={check.shortDescription}>{check.shortDescription}</span>
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
                {check.longDescription && <div className={`${cut} text-2xs text-neutral-500`} title={check.longDescription}>{check.longDescription}</div>}
                {hasChildren && (
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
