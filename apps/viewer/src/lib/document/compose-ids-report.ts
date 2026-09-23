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
const DATE_HEIGHT = 14;
const CHECK_ROW_HEIGHT = 26;
const DESCRIBED_CHECK_ROW_HEIGHT = 38;

/** What the composer needs of a resolved IDS report block. */
export type IdsReportLayoutBlock = IdsReportBlock;

/** `n%` for a pass rate that is always an integer 0-100 (matches `SpecificationSummary.passRate`'s own rounding). */
const pct = (n: number): string => `${n}%`;

export function layoutIdsReport(block: IdsReportLayoutBlock, cursor: LayoutCursor, contentW: number, blockGap: number): void {
  const title = `IDS report: ${block.sourceName}`;
  const firstRowHeight = block.checks[0]?.longDescription ? DESCRIBED_CHECK_ROW_HEIGHT : CHECK_ROW_HEIGHT;
  const lead = IDS_REPORT_TITLE_HEIGHT + SUMMARY_HEIGHT + DATE_HEIGHT + firstRowHeight;
  cursor.ensure(lead);
  cursor.push({ kind: 'text', x: cursor.x, y: cursor.y + 11, size: 11, bold: true, gray: 0, text: cursor.truncate(title, contentW, 11, true) });
  cursor.y += IDS_REPORT_TITLE_HEIGHT;

  const { checked, passed, failed, passRate } = block.summary;
  cursor.push({
    kind: 'text', x: cursor.x, y: cursor.y + 10, size: 9, bold: false, gray: 60,
    text: cursor.truncate(`Checked ${checked} · Passed ${passed} · Failed ${failed} · ${pct(passRate)} passed`, contentW, 9, false),
  });
  cursor.y += SUMMARY_HEIGHT;
  cursor.push({ kind: 'text', x: cursor.x, y: cursor.y + 10, size: 8, bold: false, gray: 130,
    text: cursor.truncate(`Validation run: ${block.generatedAt}`, contentW, 8, false) });
  cursor.y += DATE_HEIGHT;

  for (const check of block.checks) {
    const rowHeight = check.longDescription ? DESCRIBED_CHECK_ROW_HEIGHT : CHECK_ROW_HEIGHT;
    const firstRuleHeight = check.rules[0]?.longDescription ? DESCRIBED_CHECK_ROW_HEIGHT : CHECK_ROW_HEIGHT;
    cursor.ensure(rowHeight + (check.rules.length > 0 ? firstRuleHeight : 0));
    const name = check.shortDescription || check.id;
    cursor.push({ kind: 'text', x: cursor.x, y: cursor.y + 10, size: 9.5, bold: true, gray: 0, text: cursor.truncate(name, contentW, 9.5, true) });
    if (check.longDescription) {
      cursor.push({ kind: 'text', x: cursor.x, y: cursor.y + 21, size: 8, bold: false, gray: 130, text: cursor.truncate(check.longDescription, contentW, 8, false) });
    }
    // Counts occupy their own line so a long description cannot print over them.
    const countsY = check.longDescription ? cursor.y + 32 : cursor.y + 21;
    cursor.push({
      kind: 'text', x: cursor.x, y: countsY, size: 8, bold: false, gray: 60,
      text: cursor.truncate(`Checked ${check.checked} · Passed ${check.passed} · Failed ${check.failed} · ${pct(check.passRate)}`, contentW, 8, false),
    });
    cursor.y += rowHeight;

    for (const rule of check.rules) {
      const ruleHeight = rule.longDescription ? DESCRIBED_CHECK_ROW_HEIGHT : CHECK_ROW_HEIGHT;
      cursor.ensure(ruleHeight);
      const ruleX = cursor.x + 10;
      const ruleW = contentW - 10;
      cursor.push({ kind: 'text', x: ruleX, y: cursor.y + 10, size: 8.5, bold: true, gray: 45,
        text: cursor.truncate(rule.shortDescription || rule.id, ruleW, 8.5, true) });
      if (rule.longDescription) {
        cursor.push({ kind: 'text', x: ruleX, y: cursor.y + 21, size: 8, bold: false, gray: 130,
          text: cursor.truncate(rule.longDescription, ruleW, 8, false) });
      }
      const counts = rule.passRate === null
        ? `Checked ${rule.checked} · Passed/failed unavailable (partial report)`
        : `Checked ${rule.checked} · Passed ${rule.passed} · Failed ${rule.failed} · ${pct(rule.passRate)}`;
      cursor.push({ kind: 'text', x: ruleX, y: cursor.y + (rule.longDescription ? 32 : 21), size: 8, bold: false, gray: 60,
        text: cursor.truncate(counts, ruleW, 8, false) });
      cursor.y += ruleHeight;
    }
  }

  if (block.checks.length === 0) {
    cursor.push({ kind: 'text', x: cursor.x, y: cursor.y + 10, size: 9, bold: false, gray: 130, text: 'No checks in this report.' });
    cursor.y += CHECK_ROW_HEIGHT;
  }

  cursor.y += blockGap;
}
