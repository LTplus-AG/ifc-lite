/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The manual-validation report block's saved shape (#6401), kept beside
 * `types.ts` (which composes it into `DocumentBlock`) the way the
 * validation report block's types are.
 *
 * A frozen snapshot, like `ids-report`: the checklist's groups and checks,
 * each check's verdict and comment, and the per-group counts, copied when
 * the block is added or refreshed. It never reads the live checklist or
 * the stored answers again, so a saved document prints the round that was
 * recorded, and it travels with the `.ifclite-document.json` file.
 */

import { validateBlockTitle, type BlockTitle } from './block-title.js';
import type { DocumentValidationError } from './types.js';
import { validateReportProvenance, type ReportProvenance } from './report-provenance.js';

export type ManualReportVerdict = 'pass' | 'fail' | 'warning';

/** The four disjoint buckets; a warning is its own bucket, never a pass. */
export interface ManualReportCounts {
  total: number;
  pass: number;
  fail: number;
  warning: number;
  unanswered: number;
}

export interface ManualReportItem {
  id: string;
  text: string;
  description?: string;
  /** `null`: not checked when the snapshot was taken. */
  status: ManualReportVerdict | null;
  comment?: string;
}

export interface ManualReportGroup {
  id: string;
  name: string;
  counts: ManualReportCounts;
  items: ManualReportItem[];
}

export interface ManualReportBlock extends ReportProvenance, BlockTitle {
  kind: 'manual-report';
  id: string;
  /** The checklist's name, printed in the block's heading. */
  checklistName: string;
  /** Live instance used by explicit Refresh; embedded answers stay immutable. */
  checklistId?: string;
  /** Missing on older documents: their existing detailed layout. */
  variant?: 'long' | 'compact';
  /** Missing on older documents: display their existing rings and scores. */
  benchmarks?: boolean;
  /** Whole-block size, 0.5-2 (#6548); absent is 1. */
  scale?: number;
  /** Missing on older documents: show their model/recording stamp. Evidence stays saved when hidden. */
  showStamp?: boolean;
  /** The model the answers were recorded against, when there was one (display only). */
  modelName?: string;
  /**
   * That model's source fingerprint, the key its answers are stored under:
   * Refresh reads this model and no other. Absent when no model (or one
   * without a fingerprint) was loaded; such a block follows the tab's pick.
   */
  modelFingerprint?: string;
  /** When the snapshot was taken (ISO). */
  generatedAt: string;
  summary: ManualReportCounts;
  groups: ManualReportGroup[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const VERDICTS: readonly unknown[] = ['pass', 'fail', 'warning', null];

/** Counts that are whole, non-negative, and whose four buckets sum to `total`. */
function isCounts(v: unknown): v is ManualReportCounts {
  return isRecord(v) && isCount(v.total) && isCount(v.pass) && isCount(v.fail) && isCount(v.warning) && isCount(v.unanswered)
    && v.pass + v.fail + v.warning + v.unanswered === v.total;
}

const COUNTS_MESSAGE = 'expected { total, pass, fail, warning, unanswered: non-negative integers; the four buckets sum to total }';

/** Structural check of a manual report block (#6401), every problem with its JSON path. */
export function validateManualReportBlock(block: Record<string, unknown>, at: string, errors: DocumentValidationError[]): void {
  validateReportProvenance(block, at, errors);
  validateBlockTitle(block, at, errors);
  if (!isString(block.checklistName)) errors.push({ path: `${at}.checklistName`, message: 'expected a string' });
  if (block.checklistId !== undefined && !(isString(block.checklistId) && block.checklistId.trim())) errors.push({ path: `${at}.checklistId`, message: 'expected a nonblank string' });
  if (block.variant !== undefined && block.variant !== 'long' && block.variant !== 'compact') errors.push({ path: `${at}.variant`, message: 'expected long or compact' });
  if (block.benchmarks !== undefined && typeof block.benchmarks !== 'boolean') errors.push({ path: `${at}.benchmarks`, message: 'expected a boolean' });
  if (block.showStamp !== undefined && typeof block.showStamp !== 'boolean') errors.push({ path: `${at}.showStamp`, message: 'expected a boolean' });
  if (block.modelName !== undefined && !isString(block.modelName)) errors.push({ path: `${at}.modelName`, message: 'expected a string' });
  if (block.modelFingerprint !== undefined && !(isString(block.modelFingerprint) && block.modelFingerprint.length > 0)) {
    errors.push({ path: `${at}.modelFingerprint`, message: 'expected a non-empty string' });
  }
  if (!isString(block.generatedAt)) errors.push({ path: `${at}.generatedAt`, message: 'expected a string' });
  if (!isCounts(block.summary)) errors.push({ path: `${at}.summary`, message: COUNTS_MESSAGE });
  if (!Array.isArray(block.groups)) {
    errors.push({ path: `${at}.groups`, message: 'expected an array' });
    return;
  }
  // One id space across groups and checks, as the checklist parser enforces; the preview keys rows by id.
  const seenIds = new Set<string>();
  const checkId = (value: unknown, path: string): void => {
    if (!isString(value) || value.length === 0) errors.push({ path, message: 'expected a non-empty string' });
    else if (seenIds.has(value)) errors.push({ path, message: `duplicate id "${value}"` });
    else seenIds.add(value);
  };
  block.groups.forEach((group: unknown, i) => {
    const groupAt = `${at}.groups[${i}]`;
    if (!isRecord(group)) { errors.push({ path: groupAt, message: 'expected an object' }); return; }
    checkId(group.id, `${groupAt}.id`);
    if (!isString(group.name)) errors.push({ path: `${groupAt}.name`, message: 'expected a string' });
    if (!isCounts(group.counts)) errors.push({ path: `${groupAt}.counts`, message: COUNTS_MESSAGE });
    if (!Array.isArray(group.items)) { errors.push({ path: `${groupAt}.items`, message: 'expected an array' }); return; }
    group.items.forEach((item: unknown, j) => {
      const itemAt = `${groupAt}.items[${j}]`;
      if (!isRecord(item)) { errors.push({ path: itemAt, message: 'expected an object' }); return; }
      checkId(item.id, `${itemAt}.id`);
      if (!isString(item.text)) errors.push({ path: `${itemAt}.text`, message: 'expected a string' });
      if (item.description !== undefined && !isString(item.description)) errors.push({ path: `${itemAt}.description`, message: 'expected a string' });
      if (!VERDICTS.includes(item.status)) errors.push({ path: `${itemAt}.status`, message: 'expected pass | fail | warning | null' });
      if (item.comment !== undefined && !isString(item.comment)) errors.push({ path: `${itemAt}.comment`, message: 'expected a string' });
    });
    // The ring is drawn from `counts`, so counts that disagree with the verdicts listed under
    // them would print a chart the page contradicts; a hand-edited file is refused instead.
    if (isCounts(group.counts) && !sameCounts(group.counts, countItems(group.items))) {
      errors.push({ path: `${groupAt}.counts`, message: 'does not match the verdicts of its items' });
    }
  });
  const groupCounts = block.groups.map((g: unknown) => (isRecord(g) && isCounts(g.counts) ? g.counts : null));
  if (isCounts(block.summary) && groupCounts.every((c): c is ManualReportCounts => c !== null)) {
    const sum = groupCounts.reduce((acc, c) => ({
      total: acc.total + c.total, pass: acc.pass + c.pass, fail: acc.fail + c.fail, warning: acc.warning + c.warning, unanswered: acc.unanswered + c.unanswered,
    }), { total: 0, pass: 0, fail: 0, warning: 0, unanswered: 0 });
    if (!sameCounts(block.summary, sum)) errors.push({ path: `${at}.summary`, message: 'does not match the sum of its groups' });
  }
}

function countItems(items: readonly unknown[]): ManualReportCounts {
  const counts = { total: 0, pass: 0, fail: 0, warning: 0, unanswered: 0 };
  for (const item of items) {
    counts.total += 1;
    const status = isRecord(item) ? item.status : null;
    if (status === 'pass' || status === 'fail' || status === 'warning') counts[status] += 1;
    else counts.unanswered += 1;
  }
  return counts;
}

const sameCounts = (a: ManualReportCounts, b: ManualReportCounts): boolean =>
  a.total === b.total && a.pass === b.pass && a.fail === b.fail && a.warning === b.warning && a.unanswered === b.unanswered;
