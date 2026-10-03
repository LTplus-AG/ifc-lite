/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Repeated page furniture is measured before the body, then receives its
 * truthful total after the existing document paginator finishes (#6610). */
import { HEADER_HEIGHT, FOOTER_HEIGHT } from './compose-scale.js';
import { REPORT_MARGIN } from '../export/report/compose.js';
import type { ComposeDocumentInput, DrawnItem } from './compose.js';
import { TABLE_ROW_HEIGHT } from './compose-table.js';
import type { PageBand } from './page-band.js';
import { pageHeadingStyle, resolvePageHeading } from './page-heading.js';
import { wrapText, truncateToWidth } from './compose-text.js';
import type { TextFont } from './types.js';

export type PageFrameItem = {
  kind: 'text'; band: 'heading' | 'footer'; role: 'text' | 'date' | 'counter';
  x: number; y: number; size: number; font: TextFont; gray: number; color?: string; text: string;
} | { kind: 'image'; band: 'heading' | 'footer'; dataUrl: string; x: number; y: number; w: number; h: number };

export function composePageFrame(input: ComposeDocumentInput, size: { w: number; h: number },
  labels: NonNullable<ComposeDocumentInput['labels']>) {
  const width = size.w - REPORT_MARGIN * 2;
  const heading = input.pageHeading ? resolvePageHeading(input.name, input.pageHeading, width, input.measure) : undefined;
  const footer = labels('document.print.footer', { timestamp: input.generatedAt });
  const defaults: PageFrameItem[] = [];
  const text = (band: 'heading' | 'footer', role: 'text' | 'date' | 'counter', value: string,
    x: number, y: number, size = 8, font: TextFont = 'helvetica', color?: string): PageFrameItem =>
    ({ kind: 'text', band, role, x, y, size, font, gray: 150, color, text: value });
  let top = REPORT_MARGIN + HEADER_HEIGHT + (heading?.extraHeight ?? 0);
  let bottom = size.h - REPORT_MARGIN - FOOTER_HEIGHT;
  const pendingCounters: { item: Extract<PageFrameItem, { kind: 'text' }>; width: number }[] = [];
  const items: PageFrameItem[] = [];
  const bandLayout = (band: 'heading' | 'footer', spec: PageBand, fallback: string) => {
    const style = pageHeadingStyle(spec);
    const lineH = style.fontSize * 1.25;
    const showCounter = spec.showPageNumbers ?? band === 'footer';
    const logoH = spec.logo?.height ?? 0;
    const aspect = spec.logo ? input.logoAspects?.get(spec.logo.dataUrl) ?? 1 : 1;
    const logoW = Math.min(width / 3, logoH * aspect);
    const actualLogoH = aspect > 0 ? logoW / aspect : logoH;
    const x = REPORT_MARGIN + (logoW ? logoW + 10 : 0);
    const available = width - (x - REPORT_MARGIN);
    const counterW = Math.min(available, Math.max(60, input.measure(labels('document.print.pageCounter', { page: 999999, total: 999999 }), style.fontSize, false, style.font)));
    const date = input.stampedDate ?? input.generatedAt;
    const dateWidth = input.measure(date, style.fontSize, false, style.font);
    const separateDate = !!spec.showDate && showCounter && dateWidth + counterW + 10 > available;
    const extraRow = (spec.showDate || showCounter ? lineH : 0) + (separateDate ? lineH : 0);
    // Imported text cannot consume the whole paper. The bounded frame still
    // leaves room for body content; its complete text remains in the editor.
    const maxRows = Math.max(1, Math.floor((size.h / 5 - extraRow) / lineH));
    const fullRows = wrapText(spec.text ?? fallback, available, style.fontSize, false, input.measure, style.font);
    const rows = fullRows.slice(0, maxRows);
    if (fullRows.length > maxRows) rows[maxRows - 1] = truncateToWidth(`${rows[maxRows - 1]}…`, available, style.fontSize, false,
      (value, fontSize, bold) => input.measure(value, fontSize, bold, style.font));
    const textH = rows.length * lineH + extraRow;
    const height = Math.max(actualLogoH, textH);
    const start = band === 'heading' ? REPORT_MARGIN - 16 : size.h - REPORT_MARGIN + 12 - height;
    const textStart = band === 'footer' ? start + height - textH : start;
    for (const [index, row] of rows.entries()) items.push(text(band, 'text', row, x, textStart + style.fontSize + index * lineH, style.fontSize, style.font, spec.textColor));
    const lastBaseline = start + height;
    const dateAvailable = separateDate ? available : available - (showCounter ? counterW + 10 : 0);
    if (spec.showDate) items.push(text(band, 'date', truncateToWidth(date, dateAvailable, style.fontSize, false,
      (value, fontSize, bold) => input.measure(value, fontSize, bold, style.font)), x, lastBaseline - (separateDate ? lineH : 0),
      style.fontSize, style.font, spec.textColor));
    if (showCounter) {
      const item = text(band, 'counter', '', size.w - REPORT_MARGIN - counterW, lastBaseline, style.fontSize, style.font, spec.textColor);
      if (item.kind === 'text') { items.push(item); pendingCounters.push({ item, width: counterW }); }
    }
    if (spec.logo) items.push({ kind: 'image', band, dataUrl: spec.logo.dataUrl, x: REPORT_MARGIN, y: start, w: logoW, h: actualLogoH });
    if (band === 'heading') top = Math.max(top, start + height + 10);
    else bottom = Math.min(bottom, start - 10);
  };
  const authoredHeading = input.pageHeading && (input.pageHeading.logo || input.pageHeading.showDate || input.pageHeading.showPageNumbers);
  if (authoredHeading && input.pageHeading) bandLayout('heading', input.pageHeading, input.name);
  else defaults.push(text('heading', 'text', heading?.text ?? input.name, REPORT_MARGIN, heading?.y ?? REPORT_MARGIN - 8,
    heading?.fontSize, heading?.font, input.pageHeading?.textColor));
  if (input.pageFooter) bandLayout('footer', input.pageFooter, '');
  else {
    defaults.push(text('footer', 'text', footer, REPORT_MARGIN, size.h - REPORT_MARGIN + 12));
    const counter = text('footer', 'counter', '', size.w - REPORT_MARGIN - 60, size.h - REPORT_MARGIN + 12);
    if (counter.kind === 'text') { defaults.push(counter); pendingCounters.push({ item: counter, width: Infinity }); }
  }
  const authoredBands = Boolean(authoredHeading || input.pageFooter);
  const assertBody = (body: readonly DrawnItem[]): void => {
    // Preserve the existing no-band document acceptance contract. This refusal
    // protects space reserved by authored bands; changing oversized legacy
    // graphic handling would be a separate compatibility change (#6733).
    if (!authoredBands) return;
    // Some blocks contain indivisible graphics (topic snapshots, report rings).
    // The paginator cannot split those; refuse instead of painting over a band.
    for (const item of body) {
      const start = item.kind === 'text' ? item.y - item.size : item.y;
      const end = item.kind === 'text' ? item.y : item.kind === 'ring' ? item.y + item.size
        : item.kind === 'table' ? item.y + (item.rows.length + 1) * TABLE_ROW_HEIGHT * (item.scale ?? 1) : item.y + item.h;
      if (start < top - 1e-6 || end > bottom + 1e-6) throw new Error(labels('document.print.bandFrameTooShort'));
    }
  };
  return { top, bottom, heading, footer, authoredBands, assertBody, pages: (total: number): PageFrameItem[][] => Array.from({ length: total }, (_, index) => {
    const counters = new Map(pendingCounters.map(({ item, width }) => [item,
      truncateToWidth(labels('document.print.pageCounter', { page: index + 1, total }), width, item.size, false,
        (value, fontSize, bold) => input.measure(value, fontSize, bold, item.font))]));
    return [...defaults, ...items].map(item => item.kind === 'text' && item.role === 'counter' ? { ...item, text: counters.get(item) ?? '' } : item);
  }) };
}
