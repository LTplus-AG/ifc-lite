/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Laying out a manual-validation report block (#6401) on the document's
 * page model: a heading, an overall ring with the four counts in words,
 * then each group (its own ring, name and counts) followed by its checks.
 *
 * PDF text is grey only, so every verdict is printed as a word ("PASS",
 * "WARNING", …); colour appears only in the rings, which the PDF draws
 * through the same svg2pdf path charts use, and which always sit next to
 * their counts in words. A check does not split across pages (its verdict,
 * text, guidance and comment move together) unless it is taller than a page.
 */

import { reportScopeText } from './report-provenance.js';
import { layoutReportProvenance, REPORT_PROVENANCE_LINE_HEIGHT, wrappedReportProvenance, type WrapLines } from './compose-report-provenance.js';
import type { LayoutCursor, TextDrawnItem } from './compose-table.js';
import type { ManualReportBlock, ManualReportCounts, ManualReportItem } from './manual-report-types.js';

/** A ring chart on the page; the PDF renders `ringSvg(counts, size)` into it. */
export interface RingDrawnItem { kind: 'ring'; x: number; y: number; size: number; counts: ManualReportCounts }

export type ManualReportLayoutBlock = ManualReportBlock;

const TITLE_HEIGHT = 18;
const META_HEIGHT = 14;
const OVERALL_RING = 44;
const GROUP_RING = 16;
const GROUP_HEADER_HEIGHT = 24;
const LINE = 11;
const VERDICT_COLUMN = 76;

const VERDICT_WORD: Record<'pass' | 'fail' | 'warning' | 'unanswered', string> = {
  pass: 'PASS',
  fail: 'FAIL',
  warning: 'WARNING',
  unanswered: 'NOT CHECKED',
};

export const countsLine = (c: ManualReportCounts): string =>
  `Pass ${c.pass} · Warning ${c.warning} · Fail ${c.fail} · Not checked ${c.unanswered}`;

const passedLine = (c: ManualReportCounts): string =>
  `${c.total > 0 ? Math.floor((c.pass / c.total) * 100) : 0}% passed (${c.pass} of ${c.total} checks)`;

interface ItemLines { text: string[]; description: string[]; comment: string[]; height: number }

function itemLines(item: ManualReportItem, width: number, wrap: WrapLines): ItemLines {
  const text = wrap(item.text.trim() || 'Untitled check', width, 9, false);
  const description = item.description ? wrap(item.description, width, 8, false) : [];
  const comment = item.comment ? wrap(`Comment: ${item.comment}`, width, 8, false) : [];
  return { text, description, comment, height: (text.length + description.length + comment.length) * LINE + 5 };
}

export function layoutManualReport(
  block: ManualReportLayoutBlock,
  cursor: LayoutCursor,
  contentW: number,
  blockGap: number,
  wrap: WrapLines,
  pushRing: (item: RingDrawnItem) => void,
): void {
  const text = (item: Omit<TextDrawnItem, 'kind'>): void => cursor.push({ kind: 'text', ...item });
  const itemX = cursor.x + VERDICT_COLUMN;
  const itemW = contentW - VERDICT_COLUMN;

  // Heading, meta line and the overall ring move together.
  const scope = reportScopeText(block);
  const scopeLines = wrappedReportProvenance(scope ? `Models: ${scope}` : '', contentW, wrap);
  const keepAfter = OVERALL_RING + 10 + (block.groups.length === 0 ? META_HEIGHT : 0);
  cursor.ensure(Math.min(TITLE_HEIGHT + META_HEIGHT + scopeLines.length * REPORT_PROVENANCE_LINE_HEIGHT + keepAfter, cursor.bottom - cursor.top));
  const title = `Manual validation: ${block.checklistName.trim() || 'Untitled checklist'}`;
  text({ x: cursor.x, y: cursor.y + 11, size: 11, bold: true, gray: 0, text: cursor.truncate(title, contentW, 11, true) });
  cursor.y += TITLE_HEIGHT;
  const meta = block.modelName ? `Model: ${block.modelName} · Recorded: ${block.generatedAt}` : `Recorded: ${block.generatedAt}`;
  text({ x: cursor.x, y: cursor.y + 10, size: 8, bold: false, gray: 130, text: cursor.truncate(meta, contentW, 8, false) });
  cursor.y += META_HEIGHT;
  layoutReportProvenance(scopeLines, cursor, keepAfter);

  cursor.y += 4;
  pushRing({ kind: 'ring', x: cursor.x, y: cursor.y, size: OVERALL_RING, counts: block.summary });
  const besideX = cursor.x + OVERALL_RING + 12;
  const besideW = contentW - OVERALL_RING - 12;
  text({ x: besideX, y: cursor.y + 16, size: 9.5, bold: true, gray: 0, text: cursor.truncate(passedLine(block.summary), besideW, 9.5, true) });
  text({ x: besideX, y: cursor.y + 30, size: 8.5, bold: false, gray: 60, text: cursor.truncate(countsLine(block.summary), besideW, 8.5, false) });
  cursor.y += OVERALL_RING + 6;

  if (block.groups.length === 0) {
    text({ x: cursor.x, y: cursor.y + 10, size: 9, bold: false, gray: 130, text: 'No checks in this checklist.' });
    cursor.y += META_HEIGHT;
  }

  for (const group of block.groups) {
    const lines = group.items.map((item) => itemLines(item, itemW, wrap));
    // A group heading is never left alone at the bottom of a page.
    cursor.ensure(GROUP_HEADER_HEIGHT + (lines[0]?.height ?? 0));
    pushRing({ kind: 'ring', x: cursor.x, y: cursor.y + 2, size: GROUP_RING, counts: group.counts });
    const nameX = cursor.x + GROUP_RING + 8;
    text({ x: nameX, y: cursor.y + 10, size: 10, bold: true, gray: 0, text: cursor.truncate(group.name.trim() || 'Untitled group', contentW - GROUP_RING - 8, 10, true) });
    text({ x: nameX, y: cursor.y + 20, size: 8, bold: false, gray: 60, text: cursor.truncate(countsLine(group.counts), contentW - GROUP_RING - 8, 8, false) });
    cursor.y += GROUP_HEADER_HEIGHT;

    group.items.forEach((item, i) => {
      const l = lines[i];
      cursor.ensure(Math.min(l.height, cursor.bottom - cursor.top));
      text({ x: cursor.x + 8, y: cursor.y + 9, size: 7.5, bold: true, gray: item.status === null ? 130 : 0, text: VERDICT_WORD[item.status ?? 'unanswered'] });
      const rows: Array<[string, number, number]> = [
        ...l.text.map((line): [string, number, number] => [line, 9, 0]),
        ...l.description.map((line): [string, number, number] => [line, 8, 130]),
        ...l.comment.map((line): [string, number, number] => [line, 8, 60]),
      ];
      // Only a check taller than a whole page continues onto the next one, line by line.
      for (const [line, size, gray] of rows) {
        if (cursor.y + LINE > cursor.bottom) cursor.newPage();
        text({ x: itemX, y: cursor.y + 9, size, bold: false, gray, text: line });
        cursor.y += LINE;
      }
      cursor.y += 5;
    });
    if (group.items.length === 0) {
      text({ x: itemX, y: cursor.y + 9, size: 8, bold: false, gray: 130, text: 'No checks in this group.' });
      cursor.y += LINE + 5;
    }
    cursor.y += 4;
  }

  cursor.y += blockGap;
}
