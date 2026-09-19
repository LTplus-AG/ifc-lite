/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { PdfFidelityReport, PdfOmissionSummary, PdfPageRect } from '@/lib/appearance/pdf/vector-types';
import { useTranslation, type TranslationKey, type TranslationParameters } from '@/i18n';

/** Translation keys for the canonical omission kinds (#4406). Unknown kinds show verbatim. */
const LABEL_KEYS: Readonly<Record<string, TranslationKey>> = {
  text: 'appearance.pdfFidelity.omission.text',
  image: 'appearance.pdfFidelity.omission.image',
  clip: 'appearance.pdfFidelity.omission.clip',
  transparency: 'appearance.pdfFidelity.omission.transparency',
  pattern: 'appearance.pdfFidelity.omission.pattern',
  dash: 'appearance.pdfFidelity.omission.dash',
  roundCapJoin: 'appearance.pdfFidelity.omission.roundCapJoin',
  curvedStroke: 'appearance.pdfFidelity.omission.curvedStroke',
  hairline: 'appearance.pdfFidelity.omission.hairline',
  hidden: 'appearance.pdfFidelity.omission.hidden',
  annotation: 'appearance.pdfFidelity.omission.annotation',
};
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
/** `t` is threaded in explicitly: this is a plain (non-component) helper, so
 *  it cannot call the `useTranslation` hook itself. */
export function omissionLabel(kind: string, t: (key: TranslationKey, params?: TranslationParameters) => string): string {
  const key = ownValue(LABEL_KEYS, kind);
  if (key) return t(key);
  return kind.startsWith('unsupported:')
    ? t('appearance.pdfFidelity.unsupportedOperator', { operator: kind.slice('unsupported:'.length) })
    : kind;
}
export function visibleOmissionCount(report: PdfFidelityReport): number {
  return report.summary.reduce((count, entry) => count + entry.visibleCount, 0);
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
  const { t } = useTranslation();
  const keys = ownValue(ROW_KEYS, entry.kind);
  const params = { count: entry.visibleCount, ...(entry.bboxPdf ? regionParameters(entry.bboxPdf, userUnit) : {}) };
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
  const { t } = useTranslation();
  if (report.rasterOnly) {
    return <p role="alert" className="text-[11px] text-destructive">{t('appearance.pdfFidelity.rasterOnlyNotice')}</p>;
  }
  if (report.exact) {
    return <p role="status" className="text-[11px] text-green-700 dark:text-green-400">{t('appearance.pdfFidelity.exactSummary', { count: report.convertiblePaths })}</p>;
  }
  const visible = report.summary.filter(entry => entry.visibleCount > 0);
  const invisible = report.summary.reduce((count, entry) => count + entry.count - entry.visibleCount, 0);
  const omissions = visibleOmissionCount(report);
  return <div role="status" className="space-y-1 text-[11px]">
    <p className="text-amber-700 dark:text-amber-400">{t(omissions === 1
      ? report.convertiblePaths === 1 ? 'appearance.pdfFidelity.partialSummaryOneOmissionOnePath' : 'appearance.pdfFidelity.partialSummaryOneOmissionManyPaths'
      : report.convertiblePaths === 1 ? 'appearance.pdfFidelity.partialSummaryManyOmissionsOnePath' : 'appearance.pdfFidelity.partialSummaryManyOmissionsManyPaths', {
      omissionCount: omissions,
      pathCount: report.convertiblePaths,
    })}</p>
    <ul className="list-disc pl-4" aria-label={t('appearance.pdfFidelity.omissionsAriaLabel')}>{visible.map(entry => <OmissionRow key={entry.kind} entry={entry} userUnit={userUnit} />)}</ul>
    {invisible > 0 && <p className="text-muted-foreground">{t('appearance.pdfFidelity.invisibleItemsNote', { count: invisible })}</p>}
    {report.omissionsTruncated && <p className="text-muted-foreground">{t('appearance.pdfFidelity.truncatedNote')}</p>}
  </div>;
}
