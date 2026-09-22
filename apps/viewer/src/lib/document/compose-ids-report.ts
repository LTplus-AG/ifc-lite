/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Laying out an IDS report block (#5125) on the document's page model:
 * title, a one-line summary, then one row per check — each row moves to
 * the next page with its own three lines rather than splitting mid-check.
 * Pure like `compose-table.ts`, and reuses its `LayoutCursor`/text item
 * shape, since every line printed here is plain text (no grid columns).
 */
import type { IdsReportBlock } from './types.js';
import type { LayoutCursor } from './compose-table.js';

export const IDS_REPORT_TITLE_HEIGHT = 18;
const SUMMARY_HEIGHT = 14;
const CHECK_ROW_HEIGHT = 26;

/** What the composer needs of a resolved IDS report block. */
export type IdsReportLayoutBlock = IdsReportBlock;

/** `n%` for a pass rate that is always an integer 0-100 (matches `SpecificationSummary.passRate`'s own rounding). */
const pct = (n: number): string => `${n}%`;

export function layoutIdsReport(block: IdsReportLayoutBlock, cursor: LayoutCursor, contentW: number, blockGap: number): void {
  const title = `IDS report: ${block.sourceName || 'Untitled'}`;
  const lead = IDS_REPORT_TITLE_HEIGHT + SUMMARY_HEIGHT + (block.checks.length > 0 ? CHECK_ROW_HEIGHT : 0);
  cursor.ensure(lead);
  cursor.push({ kind: 'text', x: cursor.x, y: cursor.y + 11, size: 11, bold: true, gray: 0, text: cursor.truncate(title, contentW, 11, true) });
  cursor.y += IDS_REPORT_TITLE_HEIGHT;

  const { checked, passed, failed, passRate } = block.summary;
  cursor.push({
    kind: 'text', x: cursor.x, y: cursor.y + 10, size: 9, bold: false, gray: 60,
    text: cursor.truncate(`Checked ${checked} · Passed ${passed} · Failed ${failed} · ${pct(passRate)} passed`, contentW, 9, false),
  });
  cursor.y += SUMMARY_HEIGHT;

  for (const check of block.checks) {
    cursor.ensure(CHECK_ROW_HEIGHT);
    const name = check.shortDescription || check.id;
    cursor.push({ kind: 'text', x: cursor.x, y: cursor.y + 10, size: 9.5, bold: true, gray: 0, text: cursor.truncate(name, contentW, 9.5, true) });
    if (check.longDescription) {
      cursor.push({ kind: 'text', x: cursor.x, y: cursor.y + 21, size: 8, bold: false, gray: 130, text: cursor.truncate(check.longDescription, contentW, 8, false) });
    }
    const countsY = check.longDescription ? cursor.y + 21 : cursor.y + 10;
    cursor.push({
      kind: 'text', x: cursor.x + Math.max(0, contentW - 220), y: countsY, size: 8, bold: false, gray: 60,
      text: `Checked ${check.checked} · Passed ${check.passed} · Failed ${check.failed} · ${pct(check.passRate)}`,
    });
    cursor.y += CHECK_ROW_HEIGHT;
  }

  if (block.checks.length === 0) {
    cursor.push({ kind: 'text', x: cursor.x, y: cursor.y + 10, size: 9, bold: false, gray: 130, text: 'No checks in this report.' });
    cursor.y += CHECK_ROW_HEIGHT;
  }

  cursor.y += blockGap;
}
