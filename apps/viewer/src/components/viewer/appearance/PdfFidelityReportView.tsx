/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { PdfFidelityReport, PdfOmissionSummary, PdfPageRect } from '@/lib/appearance/pdf/vector-types';

/** Human labels for the canonical omission kinds (#4406). Unknown kinds show verbatim. */
const LABELS: Readonly<Record<string, string>> = {
  text: 'Text runs', image: 'Images', clip: 'Clipped content', transparency: 'Transparent content',
  pattern: 'Patterns and shadings', dash: 'Dashed strokes', roundCapJoin: 'Round caps or joins',
  curvedStroke: 'Curved strokes', hairline: 'Hairline strokes', hidden: 'Hidden optional content',
  annotation: 'Annotation appearances',
};
export function omissionLabel(kind: string): string {
  return LABELS[kind] ?? (kind.startsWith('unsupported:') ? `Unsupported operator ${kind.slice('unsupported:'.length)}` : kind);
}
export function visibleOmissionCount(report: PdfFidelityReport): number {
  return report.summary.reduce((count, entry) => count + entry.visibleCount, 0);
}
/** Extent in unrotated PDF user space (CropBox coordinates, points). */
function region(box: PdfPageRect): string {
  const point = (value: number) => Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `x ${point(box[0])}–${point(box[2])}, y ${point(box[1])}–${point(box[3])} pt`;
}
function OmissionRow({ entry }: { entry: PdfOmissionSummary }) {
  return <li>{entry.visibleCount} × {omissionLabel(entry.kind)}{entry.bboxPdf ? ` — region ${region(entry.bboxPdf)}` : ''}</li>;
}
/** The canonical page verdict, shown before any geometry is prepared. */
export function PdfFidelityReportView({ report }: { report: PdfFidelityReport }) {
  if (report.rasterOnly) {
    return <p role="alert" className="text-[11px] text-destructive">This page has no vector drawing content — raster reference only. Use the Image representation; it is not presented as editable vectors.</p>;
  }
  if (report.exact) {
    return <p role="status" className="text-[11px] text-green-700 dark:text-green-400">Exact conversion: {report.convertiblePaths} convertible {report.convertiblePaths === 1 ? 'path' : 'paths'}; nothing visible is omitted.</p>;
  }
  const visible = report.summary.filter(entry => entry.visibleCount > 0);
  const invisible = report.summary.reduce((count, entry) => count + entry.count - entry.visibleCount, 0);
  return <div role="status" className="space-y-1 text-[11px]">
    <p className="text-amber-700 dark:text-amber-400">Partial conversion: {visibleOmissionCount(report)} visible {visibleOmissionCount(report) === 1 ? 'omission' : 'omissions'} would be left out; {report.convertiblePaths} {report.convertiblePaths === 1 ? 'path converts' : 'paths convert'}.</p>
    <ul className="list-disc pl-4" aria-label="PDF omissions">{visible.map(entry => <OmissionRow key={entry.kind} entry={entry} />)}</ul>
    {invisible > 0 && <p className="text-muted-foreground">{invisible} further {invisible === 1 ? 'item is' : 'items are'} not visible on the page and do not affect the conversion.</p>}
    {report.omissionsTruncated && <p className="text-muted-foreground">The detailed list is truncated; these counts are complete.</p>}
  </div>;
}
