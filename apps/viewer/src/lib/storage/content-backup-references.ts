/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { DocumentSpec } from '../document/types.js';

/** Preserve library bindings when conflicting backup entries get fresh IDs (#6679).
 * Embedded evidence stays intact; only its source-library reference changes. */
export function rebindContentDocument(document: DocumentSpec,
  comparisons: ReadonlyMap<string, string>, validation: ReadonlyMap<string, string>,
  clashReports: ReadonlyMap<string, string> = new Map()): DocumentSpec {
  return { ...document, blocks: document.blocks.map(block => {
    if (block.kind === 'chart' && block.chart.comparisonId) {
      const id = comparisons.get(block.chart.comparisonId);
      if (id) return { ...block, chart: { ...block.chart, comparisonId: id } };
    }
    if (block.kind === 'chart' && block.chart.clashReportId) {
      const id = clashReports.get(block.chart.clashReportId);
      if (id) return { ...block, chart: { ...block.chart, clashReportId: id } };
    }
    if ((block.kind === 'ids-report' || block.kind === 'manual-report') && block.savedReportId) {
      const id = validation.get(block.savedReportId);
      if (id) return { ...block, savedReportId: id };
    }
    return block;
  }) };
}

/** Carry own-commit source remaps into newer authored content without undoing it. */
export function rebindCommittedDocument(current: DocumentSpec, before: unknown, committed: DocumentSpec): DocumentSpec {
  const comparisons = new Map<string, string>(), validation = new Map<string, string>(), clashReports = new Map<string, string>();
  const blocks = new Map<string, DocumentSpec['blocks'][number]>();
  for (const block of committed.blocks) if (!blocks.has(block.id)) blocks.set(block.id, block);
  if (!before || typeof before !== 'object' || !('blocks' in before) || !Array.isArray(before.blocks)) return current;
  for (const raw of before.blocks as unknown[]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const block = raw as Record<string, unknown>;
    const next = typeof block.id === 'string' ? blocks.get(block.id) : undefined;
    if (block.kind === 'chart' && next?.kind === 'chart' && block.chart && typeof block.chart === 'object') {
      const id = (block.chart as Record<string, unknown>).comparisonId;
      if (typeof id === 'string' && next.chart.comparisonId && id !== next.chart.comparisonId) comparisons.set(id, next.chart.comparisonId);
      const clashReportId = (block.chart as Record<string, unknown>).clashReportId;
      if (typeof clashReportId === 'string' && next.chart.clashReportId && clashReportId !== next.chart.clashReportId) clashReports.set(clashReportId, next.chart.clashReportId);
    }
    if ((block.kind === 'ids-report' || block.kind === 'manual-report') && (next?.kind === 'ids-report' || next?.kind === 'manual-report')
      && next.kind === block.kind && typeof block.savedReportId === 'string' && next.savedReportId
      && block.savedReportId !== next.savedReportId) validation.set(block.savedReportId, next.savedReportId);
  }
  return rebindContentDocument(current, comparisons, validation, clashReports);
}
