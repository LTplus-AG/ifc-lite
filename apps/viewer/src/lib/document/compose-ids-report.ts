/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Laying out an IDS report block (#5125) on the document's page model:
 * title, a one-line summary, then one row per check — each row moves to
 * the next page with its own lines rather than splitting mid-check.
 * Pure like `compose-table.ts`, and reuses its `LayoutCursor`/text item
 * shape, since every line printed here is plain text (no grid columns).
 *
 * Three layouts (#6470): no `variant` is the original one-line-per-field
 * layout (truncated), `long` is the same rows with every line wrapped
 * rather than cut, `compact` is one row per check/requirement with a
 * coloured percent bar.
 */
import { passRateBand } from '@ifc-lite/ids';
import type { IdsReportBlock } from './types.js';
import type { LayoutCursor } from './compose-table.js';

export const IDS_REPORT_TITLE_HEIGHT = 18;
const SUMMARY_HEIGHT = 14;
const DATE_HEIGHT = 14;
const CHECK_ROW_HEIGHT = 26;
const DESCRIBED_CHECK_ROW_HEIGHT = 38;
const LINE_PITCH = 11;
const COMPACT_ROW_HEIGHT = 20;
const BAR_HEIGHT = 5;
const BAR_TRACK_RGB = [225, 225, 225] as const;
const BAND_RGB = { good: [34, 197, 94], warn: [234, 179, 8], bad: [239, 68, 68] } as const;

/** What the composer needs of a resolved IDS report block. */
export type IdsReportLayoutBlock = IdsReportBlock;

/** Wraps `text` to `width`; supplied by the composer so the long layout never cuts text (#6470). */
export type IdsReportWrap = (text: string, width: number, size: number, bold: boolean) => string[];

/** `n%` for a pass rate that is always an integer 0-100 (matches `SpecificationSummary.passRate`'s own rounding). */
const pct = (n: number): string => `${n}%`;

type Line = { text: string; size: number; bold: boolean; gray: number };

/** Height of a row of `n` lines: 26 for two, 38 for three, as the original layout had it. */
const rowHeight = (n: number): number => n * (LINE_PITCH + 1) + 2;

/** Draws `lines` from the cursor at a fixed pitch and advances past them. */
function emitLines(cursor: LayoutCursor, x: number, lines: Line[]): void {
  lines.forEach((line, i) => {
    cursor.push({ kind: 'text', x, y: cursor.y + 10 + i * LINE_PITCH, size: line.size, bold: line.bold, gray: line.gray, text: line.text });
  });
  cursor.y += rowHeight(lines.length);
}

export function layoutIdsReport(block: IdsReportLayoutBlock, cursor: LayoutCursor, contentW: number, blockGap: number, wrap?: IdsReportWrap): void {
  const compact = block.variant === 'compact';
  const wrapLines = block.variant === 'long' && wrap !== undefined;
  /** A field's lines: cut to one line (original layout) or wrapped (long). */
  const fit = (text: string, width: number, size: number, bold: boolean, gray: number): Line[] =>
    (wrapLines ? wrap(text, width, size, bold) : [cursor.truncate(text, width, size, bold)]).map((line) => ({ text: line, size, bold, gray }));

  const title = `IDS report: ${block.sourceName}`;
  const first = block.checks[0];
  const firstRule = first?.rules[0];
  const classicRowHeight = (described: boolean | string | undefined): number => (described ? DESCRIBED_CHECK_ROW_HEIGHT : CHECK_ROW_HEIGHT);
  const firstRowHeight = compact ? COMPACT_ROW_HEIGHT : classicRowHeight(first?.longDescription);
  const firstRuleHeight = firstRule ? (compact ? COMPACT_ROW_HEIGHT : classicRowHeight(firstRule.longDescription)) : 0;
  const lead = IDS_REPORT_TITLE_HEIGHT + SUMMARY_HEIGHT + DATE_HEIGHT + firstRowHeight + firstRuleHeight;
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

  /** Compact row: name on the left, then the bar and `passed/checked · n%`. */
  const compactRow = (x: number, w: number, name: string, size: number, bold: boolean, gray: number, passedCount: number | null, checkedCount: number, rate: number | null): void => {
    cursor.ensure(COMPACT_ROW_HEIGHT);
    const labelW = 78;
    const nameW = Math.floor(w * 0.4);
    const barX = x + nameW + 6;
    const barW = Math.max(20, w - nameW - labelW - 12);
    cursor.push({ kind: 'text', x, y: cursor.y + 10, size, bold, gray, text: cursor.truncate(name, nameW, size, bold) });
    cursor.push({ kind: 'rect', x: barX, y: cursor.y + 4, w: barW, h: BAR_HEIGHT, rgb: BAR_TRACK_RGB });
    if (rate !== null && rate > 0) {
      cursor.push({ kind: 'rect', x: barX, y: cursor.y + 4, w: (barW * rate) / 100, h: BAR_HEIGHT, rgb: BAND_RGB[passRateBand(rate)] });
    }
    const label = rate === null ? 'n/a' : `${passedCount ?? 0}/${checkedCount} · ${pct(rate)}`;
    cursor.push({ kind: 'text', x: x + w - labelW, y: cursor.y + 10, size: 8, bold: false, gray: 60, text: label });
    cursor.y += COMPACT_ROW_HEIGHT;
  };

  for (const check of block.checks) {
    if (compact) {
      compactRow(cursor.x, contentW, check.shortDescription || check.id, 9, true, 0, check.passed, check.checked, check.passRate);
      for (const rule of check.rules) {
        compactRow(cursor.x + 10, contentW - 10, rule.name ?? (rule.shortDescription || rule.id), 8, false, 45, rule.passed, rule.checked, rule.passRate);
      }
      continue;
    }
    const lines = fit(check.shortDescription || check.id, contentW, 9.5, true, 0);
    if (check.longDescription) lines.push(...fit(check.longDescription, contentW, 8, false, 130));
    // Counts occupy their own line so a long description cannot print over them.
    lines.push({ text: cursor.truncate(`Checked ${check.checked} · Passed ${check.passed} · Failed ${check.failed} · ${pct(check.passRate)}`, contentW, 8, false), size: 8, bold: false, gray: 60 });
    cursor.ensure(rowHeight(lines.length) + (check.rules.length > 0 ? classicRowHeight(check.rules[0].longDescription) : 0));
    emitLines(cursor, cursor.x, lines);

    for (const rule of check.rules) {
      const ruleW = contentW - 10;
      const ruleLines = fit(rule.shortDescription || rule.id, ruleW, 8.5, true, 45);
      if (rule.longDescription) ruleLines.push(...fit(rule.longDescription, ruleW, 8, false, 130));
      const counts = rule.passRate === null
        ? `Checked ${rule.checked} · Passed/failed unavailable (partial report)`
        : `Checked ${rule.checked} · Passed ${rule.passed} · Failed ${rule.failed} · ${pct(rule.passRate)}`;
      ruleLines.push({ text: cursor.truncate(counts, ruleW, 8, false), size: 8, bold: false, gray: 60 });
      cursor.ensure(rowHeight(ruleLines.length));
      emitLines(cursor, cursor.x + 10, ruleLines);
    }
  }

  if (block.checks.length === 0) {
    cursor.push({ kind: 'text', x: cursor.x, y: cursor.y + 10, size: 9, bold: false, gray: 130, text: 'No checks in this report.' });
    cursor.y += CHECK_ROW_HEIGHT;
  }

  cursor.y += blockGap;
}
