/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { PdfFidelityReport, PdfOmissionSummary, PdfPageRect } from '@/lib/appearance/pdf/vector-types';
import { useTranslation, type TranslationKey, type TranslationParameters } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { hasActiveTranslation, resolveEnglish, selectPluralCategory } from '@/i18n/registry';

const ROW_KEYS: Readonly<Record<string, { simple: TranslationKey; region: TranslationKey }>> = {
  text: { simple: 'appearance.pdfFidelity.row.text', region: 'appearance.pdfFidelity.row.textRegion' },
  image: { simple: 'appearance.pdfFidelity.row.image', region: 'appearance.pdfFidelity.row.imageRegion' },
  clip: { simple: 'appearance.pdfFidelity.row.clip', region: 'appearance.pdfFidelity.row.clipRegion' },
  transparency: { simple: 'appearance.pdfFidelity.row.transparency', region: 'appearance.pdfFidelity.row.transparencyRegion' },
  pattern: { simple: 'appearance.pdfFidelity.row.pattern', region: 'appearance.pdfFidelity.row.patternRegion' },
  dash: { simple: 'appearance.pdfFidelity.row.dash', region: 'appearance.pdfFidelity.row.dashRegion' },
  roundCapJoin: { simple: 'appearance.pdfFidelity.row.roundCapJoin', region: 'appearance.pdfFidelity.row.roundCapJoinRegion' },
  curvedStroke: { simple: 'appearance.pdfFidelity.row.curvedStroke', region: 'appearance.pdfFidelity.row.curvedStrokeRegion' },
  hairline: { simple: 'appearance.pdfFidelity.row.hairline', region: 'appearance.pdfFidelity.row.hairlineRegion' },
  hidden: { simple: 'appearance.pdfFidelity.row.hidden', region: 'appearance.pdfFidelity.row.hiddenRegion' },
  annotation: { simple: 'appearance.pdfFidelity.row.annotation', region: 'appearance.pdfFidelity.row.annotationRegion' },
};
function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}
export function visibleOmissionCount(report: PdfFidelityReport): number {
  return report.summary.reduce((count, entry) => count + entry.visibleCount, 0);
}
const PARTIAL_SUMMARY_KEYS = {
  zero: 'appearance.pdfFidelity.partialSummaryZeroPaths',
  one: 'appearance.pdfFidelity.partialSummaryOnePath',
  two: 'appearance.pdfFidelity.partialSummaryTwoPaths',
  few: 'appearance.pdfFidelity.partialSummaryFewPaths',
  many: 'appearance.pdfFidelity.partialSummaryManyPaths',
  other: 'appearance.pdfFidelity.partialSummaryOtherPaths',
} as const satisfies Record<Intl.LDMLPluralRule, TranslationKey>;

function partialSummaryKey(locale: string, pathCount: number): TranslationKey {
  return PARTIAL_SUMMARY_KEYS[selectPluralCategory(locale, pathCount)];
}
/** Extent in unrotated PDF user space (CropBox coordinates) shown in points:
 * one user-space unit is `UserUnit` points (ISO 32000-1 §14.11.5), so a page
 * with `/UserUnit 2` reports twice the raw coordinate. */
export function omissionRegion(box: PdfPageRect, userUnit: number, t: (key: TranslationKey, params?: TranslationParameters) => string): string {
  const point = (value: number) => { const pt = value * userUnit; return Number.isInteger(pt) ? String(pt) : pt.toFixed(1); };
  return t('appearance.pdfFidelity.regionExtent', { x0: point(box[0]), x1: point(box[2]), y0: point(box[1]), y1: point(box[3]) });
}
function regionParameters(box: PdfPageRect, userUnit: number): TranslationParameters {
  const point = (value: number) => { const pt = value * userUnit; return Number.isInteger(pt) ? String(pt) : pt.toFixed(1); };
  return { x0: point(box[0]), x1: point(box[2]), y0: point(box[1]), y1: point(box[3]) };
}
function OmissionRow({ entry, userUnit }: { entry: PdfOmissionSummary; userUnit: number }) {
  const { t, locale } = useTranslation();
  const keys = ownValue(ROW_KEYS, entry.kind);
  const params = {
    count: entry.visibleCount,
    itemCount: formatLocaleNumber(locale, entry.visibleCount),
    ...(entry.bboxPdf ? regionParameters(entry.bboxPdf, userUnit) : {}),
  };
  if (keys) return <li>{t(entry.bboxPdf ? keys.region : keys.simple, params)}</li>;
  if (entry.kind.startsWith('unsupported:')) {
    return <li>{t(entry.bboxPdf ? 'appearance.pdfFidelity.row.unsupportedRegion' : 'appearance.pdfFidelity.row.unsupported', {
      ...params, operator: entry.kind.slice('unsupported:'.length),
    })}</li>;
  }
  return <li>{t(entry.bboxPdf ? 'appearance.pdfFidelity.row.unknownRegion' : 'appearance.pdfFidelity.row.unknown', {
    ...params, kind: entry.kind,
  })}</li>;
}
/** The canonical page verdict, shown before any geometry is prepared. `userUnit` is the page's /UserUnit. */
export function PdfFidelityReportView({ report, userUnit }: { report: PdfFidelityReport; userUnit: number }) {
  const { t, locale } = useTranslation();
  if (report.rasterOnly) {
    return <p role="alert" className="text-2xs text-destructive">{t('appearance.pdfFidelity.rasterOnlyNotice')}</p>;
  }
  if (report.exact) {
    return <output className="block text-2xs text-green-700 dark:text-green-400">{t('appearance.pdfFidelity.exactSummary', {
      count: report.convertiblePaths, pathCount: formatLocaleNumber(locale, report.convertiblePaths),
    })}</output>;
  }
  const visible = report.summary.filter(entry => entry.visibleCount > 0);
  const invisible = report.summary.reduce((count, entry) => count + entry.count - entry.visibleCount, 0);
  const omissions = visibleOmissionCount(report);
  const summaryParams = {
    count: omissions,
    omissionCount: formatLocaleNumber(locale, omissions),
    pathCount: formatLocaleNumber(locale, report.convertiblePaths),
  };
  const activeSummaryKey = partialSummaryKey(locale, report.convertiblePaths);
  const summary = hasActiveTranslation(activeSummaryKey)
    ? t(activeSummaryKey, summaryParams)
    : resolveEnglish(partialSummaryKey('en', report.convertiblePaths), {
        count: omissions,
        omissionCount: formatLocaleNumber('en', omissions),
        pathCount: formatLocaleNumber('en', report.convertiblePaths),
      });
  return <div aria-live="polite" aria-atomic="true" className="space-y-1 text-2xs">
    <p className="text-amber-700 dark:text-amber-400">{summary}</p>
    <ul className="list-disc pl-4" aria-label={t('appearance.pdfFidelity.omissionsAriaLabel')}>{visible.map(entry => <OmissionRow key={entry.kind} entry={entry} userUnit={userUnit} />)}</ul>
    {invisible > 0 && <p className="text-muted-foreground">{t('appearance.pdfFidelity.invisibleItemsNote', {
      count: invisible, itemCount: formatLocaleNumber(locale, invisible),
    })}</p>}
    {report.omissionsTruncated && <p className="text-muted-foreground">{t('appearance.pdfFidelity.truncatedNote')}</p>}
  </div>;
}
