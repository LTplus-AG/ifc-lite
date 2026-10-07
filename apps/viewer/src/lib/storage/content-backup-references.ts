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
    if (block.kind === 'chart') for (const [key, ids] of [['comparisonId', comparisons], ['clashReportId', clashReports]] as const) {
      const bound = block.chart[key], id = bound && ids.get(bound);
      if (id) return { ...block, chart: { ...block.chart, [key]: id } };
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
      for (const [key, ids] of [['comparisonId', comparisons], ['clashReportId', clashReports]] as const) {
        const id = (block.chart as Record<string, unknown>)[key], now = next.chart[key];
        if (typeof id === 'string' && now && id !== now) ids.set(id, now);
      }
    }
    if ((block.kind === 'ids-report' || block.kind === 'manual-report') && (next?.kind === 'ids-report' || next?.kind === 'manual-report')
      && next.kind === block.kind && typeof block.savedReportId === 'string' && next.savedReportId
      && block.savedReportId !== next.savedReportId) validation.set(block.savedReportId, next.savedReportId);
  }
  return rebindContentDocument(current, comparisons, validation, clashReports);
}
