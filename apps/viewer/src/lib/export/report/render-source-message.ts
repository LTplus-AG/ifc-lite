/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { truncateToWidth, wrapText } from '../../document/compose-text.js';
import type { ReportDoc } from './generate-report-pdf.js';

/** Recorded-source notices fit the same chart frame in dashboard/document PDFs. */
export function drawChartSourceMessage(doc: ReportDoc, message: string, box: { x: number; y: number; w: number; h: number }, fontSize: number): void {
  doc.setFontSize(fontSize);
  const measure = (text: string, size: number) => doc.textWidth?.(text) ?? text.length * size * 0.52;
  const lines = wrapText(message, box.w, fontSize, false, measure);
  const lineHeight = fontSize * 1.5;
  const maxLines = Math.max(1, Math.floor((box.h - 14) / lineHeight));
  for (let index = 0; index < Math.min(lines.length, maxLines); index++) {
    const text = index === maxLines - 1 && lines.length > maxLines ? truncateToWidth(`${lines[index]}…`, box.w, fontSize, false, measure) : lines[index];
    doc.text(text, box.x, box.y + 14 + index * lineHeight);
  }
}
