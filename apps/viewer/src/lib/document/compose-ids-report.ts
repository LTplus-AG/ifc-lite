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
 */
import { reportBlockSourceKind, type IdsReportBlock, type IdsReportCardinality, type IdsReportCheckSummary } from './ids-report-types.js';
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

/**
 * The block heading (#6372): the report's own kind, never "IDS" for an
 * information-validation run. PDF text is plain English, like every other
 * line the document composer prints (see `TABLE_PDF_LABELS`).
 */
function idsReportTitle(block: Pick<IdsReportBlock, 'sourceKind' | 'sourceName'>): string {
  return `${reportBlockSourceKind(block) === 'rules' ? 'Information validation report' : 'IDS report'}: ${block.sourceName}`;
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

interface ChildRow { name: string; description?: string; detail: string }

/** Everything printed indented under a check: IDS requirements, then a rule's cardinality and set rows (#6372). */
function childRows(check: IdsReportCheckSummary): ChildRow[] {
  const rows: ChildRow[] = check.rules.map((rule) => ({
    name: rule.shortDescription || rule.id,
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
      name: set.groupKey ? `${set.label} · ${set.groupKey}` : set.label,
      detail: `Actual ${set.actual} · Expected ${set.expected} · ${set.passed ? 'Passed' : failedWord}`,
    });
  }
  if (check.setsTruncated) rows.push({ name: 'More sets not shown', detail: 'The validation run capped its set results' });
  return rows;
}

const rowHeightOf = (row: { description?: string } | undefined): number => (row?.description ? DESCRIBED_CHECK_ROW_HEIGHT : CHECK_ROW_HEIGHT);

export function layoutIdsReport(block: IdsReportLayoutBlock, cursor: LayoutCursor, contentW: number, blockGap: number): void {
  const title = idsReportTitle(block);
  const first = block.checks[0];
  const firstRowHeight = first?.longDescription ? DESCRIBED_CHECK_ROW_HEIGHT : CHECK_ROW_HEIGHT;
  const firstChild = first ? childRows(first)[0] : undefined;
  const firstChildHeight = firstChild ? rowHeightOf(firstChild) : 0;
  const lead = IDS_REPORT_TITLE_HEIGHT + SUMMARY_HEIGHT + DATE_HEIGHT + firstRowHeight + firstChildHeight;
  cursor.ensure(lead);
  cursor.push({ kind: 'text', x: cursor.x, y: cursor.y + 11, size: 11, bold: true, gray: 0, text: cursor.truncate(title, contentW, 11, true) });
  cursor.y += IDS_REPORT_TITLE_HEIGHT;

  cursor.push({
    kind: 'text', x: cursor.x, y: cursor.y + 10, size: 9, bold: false, gray: 60,
    text: cursor.truncate(summaryLine(block.summary), contentW, 9, false),
  });
  cursor.y += SUMMARY_HEIGHT;
  cursor.push({ kind: 'text', x: cursor.x, y: cursor.y + 10, size: 8, bold: false, gray: 130,
    text: cursor.truncate(`Validation run: ${block.generatedAt}`, contentW, 8, false) });
  cursor.y += DATE_HEIGHT;

  for (const check of block.checks) {
    const rowHeight = check.longDescription ? DESCRIBED_CHECK_ROW_HEIGHT : CHECK_ROW_HEIGHT;
    const children = childRows(check);
    cursor.ensure(rowHeight + (children.length > 0 ? rowHeightOf(children[0]) : 0));
    const name = check.shortDescription || check.id;
    cursor.push({ kind: 'text', x: cursor.x, y: cursor.y + 10, size: 9.5, bold: true, gray: 0, text: cursor.truncate(name, contentW, 9.5, true) });
    if (check.longDescription) {
      cursor.push({ kind: 'text', x: cursor.x, y: cursor.y + 21, size: 8, bold: false, gray: 130, text: cursor.truncate(check.longDescription, contentW, 8, false) });
    }
    // Counts occupy their own line so a long description cannot print over them.
    const countsY = check.longDescription ? cursor.y + 32 : cursor.y + 21;
    cursor.push({
      kind: 'text', x: cursor.x, y: countsY, size: 8, bold: false, gray: 60,
      text: cursor.truncate(checkCountsLine(check), contentW, 8, false),
    });
    cursor.y += rowHeight;

    for (const row of children) {
      const childHeight = rowHeightOf(row);
      cursor.ensure(childHeight);
      const childX = cursor.x + 10;
      const childW = contentW - 10;
      cursor.push({ kind: 'text', x: childX, y: cursor.y + 10, size: 8.5, bold: true, gray: 45,
        text: cursor.truncate(row.name, childW, 8.5, true) });
      if (row.description) {
        cursor.push({ kind: 'text', x: childX, y: cursor.y + 21, size: 8, bold: false, gray: 130,
          text: cursor.truncate(row.description, childW, 8, false) });
      }
      cursor.push({ kind: 'text', x: childX, y: cursor.y + (row.description ? 32 : 21), size: 8, bold: false, gray: 60,
        text: cursor.truncate(row.detail, childW, 8, false) });
      cursor.y += childHeight;
    }
  }

  if (block.checks.length === 0) {
    cursor.push({ kind: 'text', x: cursor.x, y: cursor.y + 10, size: 9, bold: false, gray: 130, text: 'No checks in this report.' });
    cursor.y += CHECK_ROW_HEIGHT;
  }

  cursor.y += blockGap;
}
