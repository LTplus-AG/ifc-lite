/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Laying out an IDS / information-validation report block (#5125, #6372) on
 * the document's page model: title, a one-line summary, then one row per
 * check with its indented child rows (IDS requirements, or a rule's
 * cardinality and set results) — each row moves to the next page with its
 * own lines rather than splitting mid-row.
 * Pure like `compose-table.ts`, and reuses its `LayoutCursor`/text item
 * shape, since every line printed here is plain text (no grid columns).
 *
 * Three layouts (#6470): no `variant` is the original one-line-per-field
 * layout (truncated), `long` is the same rows with every line wrapped
 * rather than cut, `compact` is one row per check / requirement with a
 * coloured percent bar.
 */
import { blockTitle, blockTitleStyle } from './block-title.js';
import { blockTitleItems } from './compose-block-title.js';
import { reportRingCounts } from '../validation/report-summary.js';
import type { RingDrawnItem } from './compose-manual-report.js';
import { passRateBand } from '@ifc-lite/ids';
import { reportScopeText } from './report-provenance.js';
import { layoutReportProvenance, REPORT_PROVENANCE_LINE_HEIGHT, wrappedReportProvenance } from './compose-report-provenance.js';
import { reportBlockSourceKind, type IdsReportBlock, type IdsReportCardinality, type IdsReportCheckSummary } from './ids-report-types.js';
import type { LayoutCursor } from './compose-table.js';

export const IDS_REPORT_TITLE_HEIGHT = 18;
const SUMMARY_HEIGHT = 14;
const DATE_HEIGHT = 14;
const CHECK_ROW_HEIGHT = 26;
const DESCRIBED_CHECK_ROW_HEIGHT = 38;
const LINE_PITCH = 11;
const COMPACT_ROW_HEIGHT = 20;
const COMPACT_GROUP_GAP = 6;
const BAR_HEIGHT = 5;
const BAR_TRACK_COLOR = '#e1e1e1';
const BAND_COLOR = { good: '#22c55e', warn: '#eab308', bad: '#ef4444' } as const;

/** Wraps `text` to `width`; supplied by the composer so the long layout never cuts text (#6470). */
export type IdsReportWrap = (text: string, width: number, size: number, bold: boolean) => string[];

/** What the composer needs of a resolved IDS report block. */
export type IdsReportLayoutBlock = IdsReportBlock;

/** `n%` for a pass rate that is always an integer 0-100 (matches `SpecificationSummary.passRate`'s own rounding). */
const pct = (n: number): string => `${n}%`;

/**
 * The block heading (#6372): the report's own kind, never "IDS" for an
 * information-validation run. PDF text is plain English, like every other
 * line the document composer prints (see `TABLE_PDF_LABELS`).
 */
function idsReportTitle(block: Pick<IdsReportBlock, 'sourceKind' | 'sourceName' | 'title'>): string {
  return blockTitle(block, `${reportBlockSourceKind(block) === 'rules' ? 'Information validation report' : 'IDS report'}: ${block.sourceName}`);
}

function summaryLine({ checked, passed, failed, passRate, warnings }: IdsReportBlock['summary']): string {
  const warned = warnings === undefined ? '' : ` · Warnings ${warnings}`;
  return `Checked ${checked} · Passed ${passed} · Failed ${failed}${warned} · ${pct(passRate)} passed`;
}

function checkCountsLine(check: IdsReportCheckSummary): string {
  if (check.error !== undefined) return `Could not be evaluated: ${check.error}`;
  if (check.severity === 'warning') return `Warning · Checked ${check.checked} · Passed ${check.passed} · Warnings ${check.failed} · ${pct(check.passRate)}`;
  return `Checked ${check.checked} · Passed ${check.passed} · Failed ${check.failed} · ${pct(check.passRate)}`;
}

function cardinalityExpected({ min, max }: IdsReportCardinality): string {
  if (min !== undefined && max !== undefined) return min === max ? `exactly ${min}` : `${min} to ${max}`;
  if (min !== undefined) return `at least ${min}`;
  return max !== undefined ? `at most ${max}` : '';
}

/** `compactName` and `bar` feed the compact layout (#6470); rows without a `bar` (cardinality, sets) print text only. */
interface ChildRow { name: string; compactName?: string; description?: string; detail: string; bar?: { passed: number | null; checked: number; rate: number | null } }

/** Everything printed indented under a check: IDS requirements, then a rule's cardinality and set rows (#6372). */
function childRows(check: IdsReportCheckSummary): ChildRow[] {
  const rows: ChildRow[] = check.rules.map((rule) => ({
    name: rule.shortDescription || rule.id,
    compactName: rule.name || rule.shortDescription || rule.id,
    bar: { passed: rule.passed, checked: rule.checked, rate: rule.passRate },
    description: rule.longDescription,
    detail: rule.passRate === null
      ? `Checked ${rule.checked} · Passed/failed unavailable (partial report)`
      : `Checked ${rule.checked} · Passed ${rule.passed} · Failed ${rule.failed} · ${pct(rule.passRate)}`,
  }));
  const { cardinality } = check;
  if (cardinality) {
    const expected = cardinalityExpected(cardinality);
    rows.push({ name: 'Applicable elements', detail: `Found ${cardinality.actual}${expected ? ` · Expected ${expected}` : ''} · ${cardinality.passed ? 'Met' : 'Not met'}` });
  }
  const failedWord = check.severity === 'warning' ? 'Warning' : 'Failed';
  for (const set of check.sets ?? []) {
    rows.push({
      name: set.groupKey === undefined ? set.label : `${set.label} · ${set.groupKey || '(blank)'}`,
      detail: `Actual ${set.actual} · Expected ${set.expected} · ${set.passed ? 'Passed' : failedWord}`,
    });
  }
  if (check.setsTruncated) rows.push({ name: 'More sets not shown', detail: 'The validation run capped its set results' });
  return rows;
}


type Line = { text: string; size: number; bold: boolean; gray: number };

/** Height of a row of `n` lines: 26 for two, 38 for three, as the original layout had it. */
const rowHeight = (n: number): number => n * (LINE_PITCH + 1) + 2;

/** Draws `lines` from the cursor at a fixed pitch and advances past them, moving to a new page for each page-sized chunk of a very long row. */
function emitLines(cursor: LayoutCursor, x: number, lines: Line[]): void {
  const perPage = Math.max(1, Math.floor((cursor.bottom - cursor.top - 2) / (LINE_PITCH + 1)));
  for (let start = 0; start < lines.length; start += perPage) {
    const chunk = lines.slice(start, start + perPage);
    cursor.ensure(rowHeight(chunk.length));
    chunk.forEach((line, i) => {
      cursor.push({ kind: 'text', x, y: cursor.y + 10 + i * LINE_PITCH, size: line.size, bold: line.bold, gray: line.gray, text: line.text });
    });
    cursor.y += rowHeight(chunk.length);
  }
}

export function layoutIdsReport(block: IdsReportLayoutBlock, cursor: LayoutCursor, contentW: number, blockGap: number, wrap: IdsReportWrap | undefined, pushRing: (item: RingDrawnItem) => void): void {
  const compact = block.variant === 'compact';
  const specificationsOnly = compact && block.specificationsOnly === true;
  const wrapLines = block.variant === 'long' && wrap !== undefined;
  /** A field's lines: cut to one line (original layout) or wrapped (long). */
  const fit = (text: string, width: number, size: number, bold: boolean, gray: number): Line[] =>
    (wrapLines ? wrap(text, width, size, bold) : [cursor.truncate(text, width, size, bold)]).map((line) => ({ text: line, size, bold, gray }));
  const classicHeight = (described: string | undefined): number => (described ? DESCRIBED_CHECK_ROW_HEIGHT : CHECK_ROW_HEIGHT);

  const title = idsReportTitle(block);
  const first = block.checks[0];
  const firstChild = first && !specificationsOnly ? childRows(first)[0] : undefined;
  const firstRowHeight = compact ? COMPACT_ROW_HEIGHT : classicHeight(first?.longDescription);
  const firstChildHeight = firstChild ? (compact ? COMPACT_ROW_HEIGHT : classicHeight(firstChild.description)) : 0;
  const scope = reportScopeText(block);
  const scopeLines = wrappedReportProvenance(scope ? `Models: ${scope}` : '', contentW, wrap ?? ((text) => [text]));
  const keepAfter = firstRowHeight + firstChildHeight;
  const ringSize = 44;
  const summaryWidth = block.benchmarks ? contentW - ringSize - 12 : contentW;
  const summaryLines = block.benchmarks && wrap ? wrap(summaryLine(block.summary), summaryWidth, 9, false) : [cursor.truncate(summaryLine(block.summary), summaryWidth, 9, false)];
  const summaryHeight = block.benchmarks ? Math.max(ringSize + 6, summaryLines.length * 12 + 2) : SUMMARY_HEIGHT;
  const titleHeight = IDS_REPORT_TITLE_HEIGHT + blockTitleStyle(block).extra;
  const lead = titleHeight + summaryHeight + DATE_HEIGHT + scopeLines.length * REPORT_PROVENANCE_LINE_HEIGHT + keepAfter;
  cursor.ensure(Math.min(lead, cursor.bottom - cursor.top));
  cursor.push(...blockTitleItems(block, title, cursor.x, cursor.y, contentW, cursor.truncate));
  cursor.y += titleHeight;

  if (block.benchmarks) pushRing({ kind: 'ring', x: cursor.x, y: cursor.y, size: ringSize, counts: reportRingCounts(block.summary) });
  summaryLines.forEach((text, i) => cursor.push({
    kind: 'text', x: cursor.x + (block.benchmarks ? ringSize + 12 : 0), y: cursor.y + 10 + i * 12, size: 9, bold: false, gray: 60, text,
  }));
  cursor.y += summaryHeight;
  cursor.push({ kind: 'text', x: cursor.x, y: cursor.y + 10, size: 8, bold: false, gray: 130,
    text: cursor.truncate(`Validation run: ${block.generatedAt}`, contentW, 8, false) });
  cursor.y += DATE_HEIGHT;
  layoutReportProvenance(scopeLines, cursor, keepAfter);

  /** Compact row: name on the left, then the bar and `passed/checked · n%` (or plain detail text when there is no bar). */
  const compactRow = (x: number, w: number, name: string, size: number, bold: boolean, gray: number, bar: ChildRow['bar'] | undefined, detail?: string): void => {
    cursor.ensure(COMPACT_ROW_HEIGHT);
    const labelW = 78;
    const nameW = Math.floor(w * 0.4);
    const barX = x + nameW + 6;
    const barW = Math.max(20, w - nameW - labelW - 12);
    cursor.push({ kind: 'text', x, y: cursor.y + 10, size, bold, gray, text: cursor.truncate(name, nameW, size, bold) });
    if (bar) {
      cursor.push({ kind: 'rect', x: barX, y: cursor.y + 4, w: barW, h: BAR_HEIGHT, color: BAR_TRACK_COLOR });
      if (bar.rate !== null && bar.rate > 0) {
        cursor.push({ kind: 'rect', x: barX, y: cursor.y + 4, w: (barW * bar.rate) / 100, h: BAR_HEIGHT, color: BAND_COLOR[passRateBand(bar.rate)] });
      }
      // Large counts would run past the right margin: keep the percent (the part that matters) and drop the counts.
      const counts = bar.rate === null ? 'n/a' : `${bar.passed ?? 0}/${bar.checked} · ${pct(bar.rate)}`;
      const label = bar.rate !== null && cursor.truncate(counts, labelW, 8, false) !== counts ? pct(bar.rate) : counts;
      cursor.push({ kind: 'text', x: x + w - labelW, y: cursor.y + 10, size: 8, bold: false, gray: 60, text: label });
    } else if (detail) {
      cursor.push({ kind: 'text', x: barX, y: cursor.y + 10, size: 8, bold: false, gray: 60, text: cursor.truncate(detail, w - nameW - 6, 8, false) });
    }
    cursor.y += COMPACT_ROW_HEIGHT;
  };

  block.checks.forEach((check, index) => {
    const children = childRows(check);
    if (compact) {
      // A specification starts a new group: air above it (not the first) so it does not read as one more requirement (#6550).
      if (index > 0) cursor.y += COMPACT_GROUP_GAP;
      // A check that could not be evaluated has no meaningful rate: print its error instead of a bar.
      const bar = check.error === undefined ? { passed: check.passed, checked: check.checked, rate: check.passRate } : undefined;
      compactRow(cursor.x, contentW, `${check.severity === 'warning' ? '(Warning) ' : ''}${check.shortDescription || check.id}`, 9, true, 0, bar, check.error === undefined ? undefined : checkCountsLine(check));
      if (!specificationsOnly) for (const row of children) compactRow(cursor.x + 10, contentW - 10, row.compactName ?? row.name, 8, false, 45, row.bar, row.detail);
      return;
    }
    const lines = fit(check.shortDescription || check.id, contentW, 9.5, true, 0);
    if (check.longDescription) lines.push(...fit(check.longDescription, contentW, 8, false, 130));
    // Counts occupy their own line so a long description cannot print over them.
    lines.push(...fit(checkCountsLine(check), contentW, 8, false, 60));
    cursor.ensure(rowHeight(lines.length) + (children.length > 0 ? classicHeight(children[0].description) : 0));
    emitLines(cursor, cursor.x, lines);

    for (const row of children) {
      const childW = contentW - 10;
      const childLines = fit(row.name, childW, 8.5, true, 45);
      if (row.description) childLines.push(...fit(row.description, childW, 8, false, 130));
      childLines.push(...fit(row.detail, childW, 8, false, 60));
      cursor.ensure(rowHeight(childLines.length));
      emitLines(cursor, cursor.x + 10, childLines);
    }
  });

  if (block.checks.length === 0) {
    cursor.push({ kind: 'text', x: cursor.x, y: cursor.y + 10, size: 9, bold: false, gray: 130, text: 'No checks in this report.' });
    cursor.y += CHECK_ROW_HEIGHT;
  }

  cursor.y += blockGap;
}
