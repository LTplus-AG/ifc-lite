/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { LayoutCursor } from './compose-table.js';

/** Canonical composer wrapping, bound to its actual text measurement. */
export type WrapLines = (text: string, width: number, size: number, bold: boolean) => string[];
export const REPORT_PROVENANCE_LINE_HEIGHT = 14;

/** Evidence must remain complete even when a filename exceeds one line. */
export function wrappedReportProvenance(text: string, width: number, wrap: WrapLines): string[] {
  return text ? wrap(text, width, 8, false) : [];
}

/** Callers reserve their heading + these lines + following content when
 * that group fits on a page. Larger scopes continue line by line; the final
 * provenance line stays with the first row/ring instead of being orphaned. */
export function layoutReportProvenance(lines: readonly string[], cursor: LayoutCursor, keepAfter: number): void {
  const height = REPORT_PROVENANCE_LINE_HEIGHT;
  const following = Math.min(keepAfter, Math.max(0, cursor.bottom - cursor.top - height));
  lines.forEach((line, index) => {
    cursor.ensure(height + (index === lines.length - 1 ? following : 0));
    cursor.push({ kind: 'text', x: cursor.x, y: cursor.y + 9, size: 8, bold: false, gray: 60, text: line });
    cursor.y += height;
  });
}
